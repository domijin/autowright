"""Backend API (§19): localhost JSON over HTTP + one WebSocket, bearer-token auth."""
from __future__ import annotations

import asyncio
import logging
import re
import secrets as pysecrets
import subprocess
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import __version__, awake, harness, imessage, installer, keychain, paths
from . import drafting, packages as pkglib, reqlog, schedule, timefmt, transfer
from .drafting import draft_jobs
from .engine import Engine, kill_orphan_group
from .events import OVERFLOW, hub
from .scheduler import cancel_unmatched_queue, drain_queue, fire_trigger
from .storage import iter_file_stats, size_label, store
from . import testexec

log = logging.getLogger("autowright.api")

AUTH_TOKEN = pysecrets.token_hex(24)
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")

engine = Engine(store)
_bearer = HTTPBearer(auto_error=False)


def token_ok(candidate: str | None) -> bool:
    """§19: constant-time — never leak the token through comparison timing."""
    return bool(candidate) and pysecrets.compare_digest(candidate, AUTH_TOKEN)


def auth(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    if cred is None or not token_ok(cred.credentials):
        raise HTTPException(401, "bad token")


# §19: no interactive docs. /health is the only unauthenticated route, and any
# website in a browser can reach localhost — the app must not hand one its
# schema.
app = FastAPI(title="Autowright backend", version=__version__,
              docs_url=None, redoc_url=None, openapi_url=None)

# §19: the Electron renderer calls us cross-origin — packaged it loads from
# file:// (Origin: null), with the §15 renderer-URL knob from a local dev
# server. Those are the only shapes allowed: a page on the open internet can
# reach localhost too, and must not be handed even an unauthenticated response.
# One rule for both modes — no dev-only branch. The bearer token remains the
# real gate, and the service binds to 127.0.0.1 only.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(null|http://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["*"], allow_headers=["*"])


class _RequestLogMiddleware:
    """§5 request-log files: while developerMode is on, every served HTTP request
    (never the /ws WebSocket) lands as one file under <logs>/requests. Pure
    ASGI — taps the receive/send streams, so bodies are captured without
    disturbing them; only the first BODY_CAP bytes of each are kept."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not reqlog.enabled():
            await self.app(scope, receive, send)
            return
        ts = reqlog.stamp()
        t0 = time.monotonic()
        req_body, resp_body = bytearray(), bytearray()
        totals = [0, 0]
        status = [0]

        async def recv():
            msg = await receive()
            if msg.get("type") == "http.request":
                chunk = msg.get("body") or b""
                totals[0] += len(chunk)
                if len(req_body) < reqlog.BODY_CAP:
                    req_body.extend(chunk[: reqlog.BODY_CAP - len(req_body)])
            return msg

        async def snd(msg):
            if msg["type"] == "http.response.start":
                status[0] = msg["status"]
            elif msg["type"] == "http.response.body":
                chunk = msg.get("body") or b""
                totals[1] += len(chunk)
                if len(resp_body) < reqlog.BODY_CAP:
                    resp_body.extend(chunk[: reqlog.BODY_CAP - len(resp_body)])
            await send(msg)

        try:
            await self.app(scope, recv, snd)
        finally:
            reqlog.write_http(ts, scope, bytes(req_body), totals[0], status[0],
                              bytes(resp_body), totals[1],
                              (time.monotonic() - t0) * 1000)


app.add_middleware(_RequestLogMiddleware)


def _auto_or_404(automation_id: str) -> dict:
    a = store.autos.get(automation_id)
    if not a:
        raise HTTPException(404, "automation not found")
    return a


def _auto_json_locked(a: dict) -> dict:
    """Serialize an automation under store.lock — the only correct way to build
    a response payload from live state (auto_json reads fields the engine and
    scheduler mutate concurrently)."""
    with store.lock:
        return store.auto_json(a)


def _agent_or_404(agent_id: str) -> dict:
    for a in store.agents:
        if a["id"] == agent_id:
            return a
    raise HTTPException(404, "agent not found")


# The executions tree can be GBs across thousands of directories; the size
# label is display-only, so one walk per TTL window is plenty — and it must
# never run while holding store.lock (it would stall live log streaming).
_DATA_SIZE_TTL_S = 30
_data_size_cache: tuple[float, str] | None = None


def _data_size_label() -> str:
    global _data_size_cache
    now = time.monotonic()
    if _data_size_cache and now - _data_size_cache[0] < _DATA_SIZE_TTL_S:
        return _data_size_cache[1]
    p = store.executions_dir()
    total = sum(st.st_size for st in iter_file_stats(p))
    _data_size_cache = (now, size_label(total))
    return _data_size_cache[1]


def _agents_json() -> list[dict]:
    out = []
    for ag in store.agents:
        used = [a["name"] for a in store.autos.values()
                if a["agent_id"] == ag["id"]
                or any(harness.grant_name(ag) == e.get("name")
                       for s in a["versions"].get(a["current_version"], {}).get("steps", [])
                       for e in (s.get("agents") or []))]
        out.append({**ag, "usedBy": used,
                    "default": ag["id"] == store.default_agent_id})
    return out


def _settings_json() -> dict:
    s = dict(store.settings)
    s["dataPath"] = str(store.data_path())
    s["dataSize"] = _data_size_label()
    s["appPath"] = str(paths.app_support())
    return s


def _secrets_json() -> list[dict]:
    return [{"name": s["name"], "description": s.get("description") or "",
             "set": bool(s.get("set", True)),
             "usedBy": store.secret_used_by(s["name"])}
            for s in sorted(store.secrets, key=lambda s: s["name"])]


def _agent_grant(g: dict) -> dict:
    """§8 grants yaml entry: name, description, harness, model — the fields the
    drafting agent weighs when deciding which agents to use; ids stay internal."""
    e = {"name": harness.grant_name(g)}
    if g.get("description"):
        e["description"] = g["description"]
    e["harness"] = g.get("harness", "")
    e["model"] = g.get("model") or "harness default"
    return e


def _secret_grant(name: str) -> dict:
    """§8 grants yaml entry: name + description (omitted when empty)."""
    e = {"name": name}
    description = next((s.get("description") for s in store.secrets if s["name"] == name), "")
    if description:
        e["description"] = description
    return e


# ---------- health / state ----------
@app.get("/health")
def health() -> dict:
    return {"version": __version__, "app": "Autowright"}


@app.get("/instructions", dependencies=[Depends(auth)])
def instructions() -> dict:
    """§8 instruction files for the create/edit page, verbatim:
    framework-instructions.md + default-build-instructions.md."""
    return {"framework": drafting.CONTRACT_PREAMBLE,
            "defaultBuild": drafting.DEFAULT_INSTRUCTIONS}


@app.get("/state", dependencies=[Depends(auth)])
def state() -> dict:
    settings = _settings_json()  # walks the executions tree — never under the lock
    with store.lock:
        return {
            "version": __version__,
            "automations": [store.auto_json(a) for a in store.autos.values()],
            "executions": sorted((store.exec_json(h) for h in store.execs.values()),
                            key=lambda e: e["startedMs"], reverse=True),
            "agents": _agents_json(),
            "secrets": _secrets_json(),
            "settings": settings,
            "pendingDraft": store.pending_draft_summary(),
        }


# ---------- automations ----------
@app.get("/automations", dependencies=[Depends(auth)])
def list_autos() -> list[dict]:
    with store.lock:
        return [store.auto_json(a) for a in store.autos.values()]


@app.get("/automations/{automation_id}", dependencies=[Depends(auth)])
def get_auto(automation_id: str) -> dict:
    return _auto_json_locked(_auto_or_404(automation_id))


@app.patch("/automations/{automation_id}", dependencies=[Depends(auth)])
def patch_auto(automation_id: str, patch: dict) -> dict:
    a = _auto_or_404(automation_id)
    if "triggers" in patch:
        # §19: whole-list replace; message kinds / bad expressions / past times → 422.
        norm, err = schedule.normalize_triggers(patch["triggers"])
        if err:
            raise HTTPException(422, err)
        patch = {**patch, "triggers": norm}
    # §19: the §6 concurrency settings are ints with a floor; anything else is a
    # 422 and nothing is stored (a silently clamped typo would be worse — the
    # user would never learn the automation isn't set up the way they think).
    for key, floor in (("maxParallel", 1), ("maxQueued", 0)):
        if key in patch:
            v = patch[key]
            if isinstance(v, bool) or not isinstance(v, int) or v < floor:
                raise HTTPException(422, f"{key} must be an integer >= {floor}")
    store.patch_automation(a, patch)
    if "triggers" in patch:
        # §6: a waiting entry whose trigger was just turned off or removed is
        # cancelled — it could never be re-admitted, and promoting it would
        # execute a firing the user just switched off.
        cancel_unmatched_queue(store, engine, automation_id)
    hub.publish("automation.changed", automationId=automation_id)
    # A raised maxParallel may have just opened a slot for a waiting firing (§6).
    drain_queue(store, engine, automation_id)
    return _auto_json_locked(a)


@app.post("/automations/{automation_id}/queue/clear", dependencies=[Depends(auth)])
def clear_queue(automation_id: str) -> dict:
    """§19: cancel every §6 firing-queue entry waiting on this automation.
    Running executions are untouched — an empty queue answers 0, not 404."""
    _auto_or_404(automation_id)
    n = 0
    for h in store.queued_execs(automation_id):
        if engine.cancel(h["id"]):
            n += 1
    if n:
        hub.publish("automation.changed", automationId=automation_id)
    return {"cancelled": n}


@app.delete("/automations/{automation_id}", dependencies=[Depends(auth)])
def delete_auto(automation_id: str) -> dict:
    a = _auto_or_404(automation_id)
    live = list(a.get("_live") or ())
    for eid in live:
        engine.cancel(eid)
    # §6: waiting firings go with it — their sender is told rather than left
    # waiting on an automation that no longer exists.
    for h in store.queued_execs(automation_id):
        engine.cancel(h["id"])
    # §19: a cancelled step gets a SIGTERM grace window (§7) — wait for the
    # engine threads to actually finish before the rmtree, or a step writing
    # memory/ during the window re-creates the directory with no versions/,
    # leaving a ghost tree the UI can never see.
    if live and not engine.wait_finished(live):
        logging.getLogger(__name__).warning(
            "delete %s: an execution thread outlived the kill grace — removing anyway", automation_id)
    store.delete_automation(a)
    hub.publish("automation.changed")
    return {"ok": True}


def _norm_steps(steps: list | None) -> list:
    """§4.1: the API spelling of the step flags is camelCase (noTimeout,
    infiniteRetries); disk and the internal shape are snake_case only. This is
    the one place the client spelling is accepted — nothing past this boundary
    reads the camel keys."""
    out = []
    for s in steps or []:
        s = dict(s)
        if s.pop("noTimeout", None):
            s["no_timeout"] = True
        if s.pop("infiniteRetries", None):
            s["infinite_retries"] = True
        out.append(s)
    return out


def _draft_to_version(d: dict) -> dict:
    return {"description": d.get("description", ""), "note": d.get("note", ""),
            "params": d.get("params", []), "packages": d.get("packages", []),
            "steps": _norm_steps(d.get("steps")),
            "spec": d.get("spec") or [], "instructions": d.get("instructions"),
            "notes": d.get("notes") or ""}


@app.post("/automations", dependencies=[Depends(auth)])
def create_auto(body: dict) -> dict:
    d = body.get("draft") or {}
    if not d.get("steps"):
        raise HTTPException(422, "draft has no steps")
    triggers, err = schedule.normalize_triggers(d.get("triggers") or [])
    if err:
        raise HTTPException(422, err)
    a = store.create_automation(
        _draft_to_version(d),
        name=body.get("name") or d.get("name") or "New automation",
        agent_id=body.get("agentId"),
        triggers=triggers,
        enabled_agents=body.get("stepAgents"),
        allowed_secrets=body.get("allowedSecrets"),
    )
    # §4.4: Create consumes the pending create-mode slot — settled drafts are
    # never resurrected.
    store.delete_pending_draft()
    hub.publish("draft.changed")
    hub.publish("automation.changed", automationId=a["id"])
    return _auto_json_locked(a)


@app.post("/automations/{automation_id}/versions", dependencies=[Depends(auth)])
def save_version(automation_id: str, body: dict) -> dict:
    a = _auto_or_404(automation_id)
    d = body.get("draft") or {}
    if not d.get("steps"):
        raise HTTPException(422, "draft has no steps")
    # §4.3/§4.4: the draft's trigger list (merged in the editor) replaces the
    # automation's — validated like the PATCH, and before the version lands.
    triggers = None
    if "triggers" in d:
        triggers, err = schedule.normalize_triggers(d["triggers"])
        if err:
            raise HTTPException(422, err)
    with store.lock:
        # Same guard as PUT/DELETE draft: saving deletes the draft container,
        # and a live Draft execution reads its step scripts lazily mid-run.
        _reject_live_draft_exec(a)
        n = store.save_new_version(a, _draft_to_version(d))
        patch = {k: body[k] for k in ("agentId", "stepAgents", "allowedSecrets", "name") if k in body}
        if triggers is not None:
            patch["triggers"] = triggers
        if patch:
            store.patch_automation(a, patch)
        store.delete_draft(a)
    if triggers is not None:
        # §6: same rule as the PATCH — the saved version's trigger list may have
        # dropped or disabled the trigger some waiting entry came from.
        cancel_unmatched_queue(store, engine, automation_id)
    hub.publish("automation.changed", automationId=automation_id)
    return {"version": n, "automation": _auto_json_locked(a)}


def _reject_live_draft_exec(a: dict) -> None:
    """409 while a Draft-version execution runs: rewriting or pruning the
    draft's step scripts mid-run would make later steps execute code that no
    longer matches the recorded per-step sha (§7). Call under store.lock."""
    for eid in a.get("_live") or ():
        live = store.execs.get(eid)
        if live and live.get("kind") == "draft":
            raise HTTPException(409, "a draft execution is in progress")


@app.put("/automations/{automation_id}/draft", dependencies=[Depends(auth)])
def put_draft(automation_id: str, body: dict) -> dict:
    a = _auto_or_404(automation_id)
    d = body.get("draft") or {}
    # §4.4: the draft snapshot carries the editor's grant selections and trigger
    # list as draft-only keys — never applied to the automation until saved.
    ver = _draft_to_version(d)
    ver["step_agents"] = d.get("stepAgents")
    ver["allowed_secrets"] = d.get("allowedSecrets")
    ver["triggers"] = d.get("triggers")
    with store.lock:
        _reject_live_draft_exec(a)
        store.save_draft(a, ver, chat=d.get("chat"))
    hub.publish("automation.changed", automationId=automation_id)
    return {"ok": True}


@app.delete("/automations/{automation_id}/draft", dependencies=[Depends(auth)])
def del_draft(automation_id: str) -> dict:
    a = _auto_or_404(automation_id)
    with store.lock:
        _reject_live_draft_exec(a)
        store.delete_draft(a)
    hub.publish("automation.changed", automationId=automation_id)
    return {"ok": True}


# §4.4 pending create-mode slot (<root>/draft/) — one unsaved new automation.
@app.get("/draft", dependencies=[Depends(auth)])
def get_pending_draft() -> dict:
    return store.pending_draft_json()


@app.post("/draft/open", dependencies=[Depends(auth)])
def open_pending_draft() -> dict:
    store.open_pending_draft()
    return {"ok": True}


@app.put("/draft", dependencies=[Depends(auth)])
def put_pending_draft(body: dict) -> dict:
    d = body.get("draft") or {}
    ver = _draft_to_version(d)
    ver["step_agents"] = d.get("stepAgents")
    ver["allowed_secrets"] = d.get("allowedSecrets")
    # Triggers pass through unvalidated — Create normalizes them (§19).
    store.save_pending_draft(ver, name=d.get("name"), agent_id=body.get("agentId"),
                             triggers=d.get("triggers") or [], chat=d.get("chat"))
    hub.publish("draft.changed")
    return {"ok": True}


@app.delete("/draft", dependencies=[Depends(auth)])
def del_pending_draft() -> dict:
    store.delete_pending_draft()
    hub.publish("draft.changed")
    return {"ok": True}


# ---------- transfer archives (§5.1) ----------
@app.get("/automations/{automation_id}/export", dependencies=[Depends(auth)])
def export_auto(automation_id: str, values: int = 1):
    a = _auto_or_404(automation_id)
    data = transfer.export_automation(store, a, include_values=bool(values))
    from urllib.parse import quote

    from fastapi.responses import Response

    fname = transfer.safe_filename(a["name"]) + ".autowright"
    ascii_name = fname.encode("ascii", "replace").decode() or "automation.autowright"
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition":
                             f'attachment; filename="{ascii_name}"; '
                             f"filename*=UTF-8''{quote(fname)}"})


async def _archive_body(request: Request) -> bytes:
    # §19: the archive is the raw request body — no multipart. Stream it in
    # with the transfer cap applied so an oversized upload can't balloon RAM
    # before import_automation ever sees it.
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > transfer.MAX_ARCHIVE_BYTES:
            raise HTTPException(413, "the archive is larger than the 64 MB import limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _land_import(data: bytes) -> dict:
    try:
        a, summary = transfer.import_automation(store, data)
    except transfer.TransferError as e:
        raise HTTPException(422, str(e)) from e
    if summary["secretsCreated"]:
        hub.publish("secrets.changed")
    if summary["agentsCreated"]:
        hub.publish("agents.changed")
    hub.publish("automation.changed", automationId=a["id"])
    return {"automation": _auto_json_locked(a), "summary": summary}


@app.post("/automations/import", dependencies=[Depends(auth)])
async def import_auto(request: Request) -> dict:
    return _land_import(await _archive_body(request))


# §5.2 preview tokens: validated archive bytes parked in memory between the
# preview and confirm calls, so the user imports exactly the bytes reviewed.
_IMPORT_TTL = 15 * 60
_IMPORT_SLOTS = 4
_import_parked: dict[str, tuple[float, bytes]] = {}


def _park_archive(data: bytes) -> str:
    now = time.time()
    for k in [k for k, (t, _) in _import_parked.items() if now - t > _IMPORT_TTL]:
        del _import_parked[k]
    while len(_import_parked) >= _IMPORT_SLOTS:
        del _import_parked[min(_import_parked, key=lambda k: _import_parked[k][0])]
    token = pysecrets.token_hex(16)
    _import_parked[token] = (now, data)
    return token


@app.post("/automations/import/preview", dependencies=[Depends(auth)])
async def import_preview(request: Request) -> dict:
    data = await _archive_body(request)
    try:
        preview = transfer.preview_archive(store, data)
    except transfer.TransferError as e:
        raise HTTPException(422, str(e)) from e
    return {"token": _park_archive(data), "preview": preview}


@app.post("/automations/import/url", dependencies=[Depends(auth)])
def import_url(body: dict) -> dict:
    url = (body.get("url") or "").strip()
    if not url:
        raise HTTPException(422, "no URL given")
    try:
        data, resolved = transfer.fetch_archive(url)
        preview = transfer.preview_archive(store, data)
    except transfer.TransferError as e:
        raise HTTPException(422, str(e)) from e
    preview["sourceUrl"] = url
    preview["resolvedUrl"] = resolved
    return {"token": _park_archive(data), "preview": preview}


@app.post("/automations/import/confirm", dependencies=[Depends(auth)])
def import_confirm(body: dict) -> dict:
    token = body.get("token")
    slot = _import_parked.pop(token, None) if isinstance(token, str) else None
    if slot is None or time.time() - slot[0] > _IMPORT_TTL:
        raise HTTPException(404, "the import preview expired — fetch it again")
    return _land_import(slot[1])


@app.post("/automations/{automation_id}/restore", dependencies=[Depends(auth)])
def restore(automation_id: str, body: dict) -> dict:
    a = _auto_or_404(automation_id)
    try:
        v = int(body.get("version", 0))
    except (TypeError, ValueError):
        raise HTTPException(422, "v must be an integer") from None
    if v not in a["versions"]:
        raise HTTPException(404, f"v{v} not found")
    n = store.restore_version(a, v)
    hub.publish("automation.changed", automationId=automation_id)
    return {"version": n, "automation": _auto_json_locked(a)}


@app.post("/automations/{automation_id}/execute", dependencies=[Depends(auth)])
def execute_auto(automation_id: str, body: dict | None = None) -> dict:
    a = _auto_or_404(automation_id)
    body = body or {}
    version = body.get("version")
    if version is not None and not isinstance(version, str):
        raise HTTPException(422, 'version must be a string like "v3" or "draft"')
    # §4.5/§19: the record stores the trigger's machine kind; manual starts are
    # `manual` (Execute now, CLI) or `menubar` (the tray panel).
    trigger = body.get("trigger", "manual")
    if trigger not in ("manual", "menubar"):
        raise HTTPException(422, "trigger must be manual | menubar")
    try:
        h = engine.start(a, trigger, version_label=version)
    except LookupError as e:  # unknown version label — not a liveness conflict
        raise HTTPException(404, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {"executionId": h["id"]}


_served_launches: set[str] = set()


@app.post("/app-started", dependencies=[Depends(auth)])
def app_started(body: dict | None = None) -> dict:
    """§6 app-start firing: the Electron main process calls this once per app
    launch; every automation holding an enabled `app_start` trigger executes.
    Idempotent per `launchId` — the caller retries until it gets a response, and
    a reply lost in flight must not fire everything a second time."""
    launch_id = (body or {}).get("launchId")
    if launch_id:
        with store.lock:
            if launch_id in _served_launches:
                return {"fired": 0}
            _served_launches.add(launch_id)
    with store.lock:
        autos = list(store.autos.values())
    fired = 0
    for a in autos:
        t = next((t for t in a["triggers"]
                  if t["kind"] == "app_start" and t["enabled"]), None)
        if not t:
            continue
        # One automation that can't start (a disk error creating its record)
        # must not 500 the batch: the rest would never fire, and the caller's
        # retry would re-fire the ones that already did.
        try:
            if fire_trigger(store, engine, a, t):
                fired += 1
        except Exception:  # noqa: BLE001
            log.exception("app-start firing failed for automation %s", a["id"])
    return {"fired": fired}


@app.get("/imessage/permissions", dependencies=[Depends(auth)])
def imessage_permissions() -> dict:
    """§19: the §9 permission checklist's status source. `fullDisk` probes
    chat.db right now (never prompts); `automation` is the remembered result
    of the backend's most recent Apple Events send to Messages."""
    return {"fullDisk": imessage.fda_status(),
            "automation": imessage.automation_status()}


@app.post("/imessage/permissions/automation-probe", dependencies=[Depends(auth)])
def imessage_automation_probe() -> dict:
    """§19: fire a benign Apple Event at Messages.app so macOS shows the
    Automation consent prompt; blocks until the user answers it."""
    return {"automation": imessage.automation_probe()}


# ---------- tests (§11 Test — §19 POST /tests) ----------
def _mock_payload(mock: dict) -> dict:
    """§19 `triggerMock` → the §4.5 payload stored on the test record. Fields
    the backend can't truthfully supply are null; `at` is the test start."""
    kind = mock.get("kind")
    text = mock.get("text")
    sender = mock.get("sender")
    if kind not in ("discord", "imessage"):
        raise HTTPException(422, "triggerMock kind must be discord | imessage")
    if not isinstance(text, str) or not text or not isinstance(sender, str) or not sender:
        raise HTTPException(422, "triggerMock needs nonempty text and sender")
    if kind == "imessage":
        return {"kind": "imessage", "text": text, "sender": sender,
                "chat": None, "messageId": None, "at": timefmt.now_iso()}
    channel = mock.get("channel")
    secret = mock.get("secret")
    if not isinstance(channel, str) or not channel.isascii() or not channel.isdigit():
        raise HTTPException(422, "triggerMock channel must be an ASCII-digit string")
    if not isinstance(secret, str) or not SECRET_NAME_RE.match(secret):
        raise HTTPException(422, "triggerMock secret must be a valid secret name")
    return {"kind": "discord", "text": text, "sender": sender, "channel": channel,
            "channelName": None, "guildName": None, "messageId": None,
            "guildId": None, "secret": secret, "at": timefmt.now_iso()}


@app.post("/tests", dependencies=[Depends(auth)])
def post_test(body: dict) -> dict:
    d = body.get("draft")
    if not d or not d.get("steps"):
        raise HTTPException(422, "draft with steps required")
    d = {**d, "steps": _norm_steps(d.get("steps"))}
    payload = _mock_payload(body["triggerMock"]) if body.get("triggerMock") else None
    auto = None
    if body.get("automationId"):
        # A stale/unknown automationId must 404 — falling through to create mode
        # would delete the unrelated pending slot's test record.
        auto = _auto_or_404(body["automationId"])
    # §19: grant arrays as in /drafts — create mode (no automationId) defaults to
    # ALL agents/secrets when the arrays are absent, edit mode to the
    # automation's grants.
    enabled = body.get("enabledAgents")
    if enabled is None:
        enabled = auto["enabled_agents"] if auto else [g["id"] for g in store.agents]
    allowed = body.get("allowedSecrets")
    if allowed is None:
        allowed = auto["allowed_secrets"] if auto else [s["name"] for s in store.secrets]
    try:
        execution_id = testexec.start(engine, d, auto, enabled, allowed,
                                 body.get("paramValues") or {}, trigger_payload=payload)
    except RuntimeError as e:  # §19: one live test per draft container
        raise HTTPException(409, str(e)) from e
    return {"executionId": execution_id}


# ---------- declared packages (§6.2 — §19 /packages/*) ----------
@app.post("/packages/check", dependencies=[Depends(auth)])
def packages_check(body: dict) -> dict:
    return {"packages": pkglib.check(body.get("packages") or [])}


@app.post("/packages/install", dependencies=[Depends(auth)])
def packages_install(body: dict) -> dict:
    # Blocking §6.2 ensure — FastAPI runs sync endpoints on a worker thread,
    # and the module lock serializes concurrent pip runs.
    return {"packages": pkglib.ensure(body.get("packages") or [])}


@app.post("/packages/outdated", dependencies=[Depends(auth)])
def packages_outdated(body: dict) -> dict:
    # §6.2 update check — read-only PyPI lookups; failures just omit `latest`.
    return {"packages": pkglib.outdated(body.get("packages") or [])}


@app.post("/packages/update", dependencies=[Depends(auth)])
def packages_update(body: dict) -> dict:
    """§6.2 update: `pip install --upgrade` in the shared directory — no
    manifest writes; manifests carry no version. Blocking like /install."""
    entries = body.get("packages") or []
    for e in entries:
        if not pkglib.PIP_NAME_RE.match(str(e.get("pip") or "").strip()):
            raise HTTPException(422, f"not a bare distribution name: {e.get('pip')!r}")
    return {"packages": pkglib.upgrade(entries)}


@app.post("/automations/{automation_id}/memory/clear", dependencies=[Depends(auth)])
def clear_memory(automation_id: str) -> dict:
    # §9.2 MEMORY card: "Clear memory" — next execution starts fresh.
    a = _auto_or_404(automation_id)
    store.snapshot_memory(a, "pre-clear")  # §6.3 — silently skipped when memory is empty or the toggle is off
    store.clear_memory(a)
    hub.publish("automation.changed", automationId=automation_id)
    return {"ok": True}


@app.post("/automations/{automation_id}/memory/snapshots", dependencies=[Depends(auth)])
def create_snapshot(automation_id: str, body: dict | None = None) -> dict:
    # §6.3 manual snapshot — 409 while live, 422 when memory is empty.
    a = _auto_or_404(automation_id)
    # One lock span for check + copy: engine.start flips `_live` under
    # store.lock, so this can't race a trigger into copying half-written memory.
    with store.lock:
        if a.get("_live"):
            raise HTTPException(409, "an execution is in progress")
        meta = store.snapshot_memory(a, "manual", name=((body or {}).get("name") or "").strip() or None)
    if meta is None:
        raise HTTPException(422, "memory is empty")
    hub.publish("automation.changed", automationId=automation_id)
    return {"snapshot": store.snapshot_json(meta)}


@app.patch("/automations/{automation_id}/memory/snapshots/{sid}", dependencies=[Depends(auth)])
def rename_snapshot(automation_id: str, sid: str, body: dict | None = None) -> dict:
    a = _auto_or_404(automation_id)
    meta = store.rename_snapshot(a, sid, (body or {}).get("name"))
    if meta is None:
        raise HTTPException(404, "snapshot not found")
    hub.publish("automation.changed", automationId=automation_id)
    return {"snapshot": store.snapshot_json(meta)}


@app.post("/automations/{automation_id}/memory/snapshots/{sid}/restore", dependencies=[Depends(auth)])
def restore_snapshot(automation_id: str, sid: str) -> dict:
    a = _auto_or_404(automation_id)
    # Same lock span as create_snapshot: no execution may start mid-restore.
    with store.lock:
        if a.get("_live"):
            raise HTTPException(409, "an execution is in progress")
        if store.restore_snapshot(a, sid) is None:
            raise HTTPException(404, "snapshot not found")
    hub.publish("automation.changed", automationId=automation_id)
    return {"ok": True}


@app.delete("/automations/{automation_id}/memory/snapshots/{sid}", dependencies=[Depends(auth)])
def delete_snapshot(automation_id: str, sid: str) -> dict:
    a = _auto_or_404(automation_id)
    if not store.delete_snapshot(a, sid):
        raise HTTPException(404, "snapshot not found")
    hub.publish("automation.changed", automationId=automation_id)
    return {"ok": True}


# ---------- drafts ----------
@app.post("/drafts", dependencies=[Depends(auth)])
def post_draft(body: dict) -> dict:
    mode = body.get("mode")
    if mode not in ("create", "chat", "sync"):
        raise HTTPException(422, "mode must be create | chat | sync")
    if mode == "chat" and not (body.get("text") or "").strip():
        raise HTTPException(422, "chat mode needs a nonempty text")
    agent = _agent_or_404(body.get("agentId") or store.default_agent_id
                          or (store.agents[0]["id"] if store.agents else ""))
    auto = store.autos.get(body.get("automationId", "")) if body.get("automationId") else None
    current = body.get("current")
    if auto and current is None:
        current = auto["versions"][auto["current_version"]]
    if auto and "triggers" not in (current or {}):
        # §8: triggers are unversioned top-level state — attach the stored list
        # so the steps call's CURRENT-triggers reference has it (the editor's
        # `current.triggers` wins when the body carries one).
        current = dict(current or {})
        current["triggers"] = auto["triggers"]
    if auto and mode == "chat":
        # §8 AUTOMATION section: name/description are §4.1 top-level identity, not
        # versioned content — attach the stored values when the body's
        # `current` carries none (the editor's win).
        current = dict(current or {})
        current.setdefault("name", auto["name"])
        current.setdefault("description", auto.get("description", ""))
    # §19: an explicit `spec` in the body wins — sync/edit regenerate against the
    # PROVIDED spec (§8), e.g. the in-editor draft, not the stored version's spec.
    if body.get("spec") is not None:
        current = dict(current or {})
        current["spec"] = body["spec"]
    if (current or {}).get("steps"):
        # §4.1 spelling boundary — an in-editor draft sent as `current` carries
        # the API's camelCase step flags.
        current = dict(current or {})
        current["steps"] = _norm_steps(current["steps"])
    if mode == "create" and not (current or {}).get("instructions"):
        # §8: new automations draft against the default best-practice build
        # instructions; the draft payload carries them back to pre-fill Review.
        current = dict(current or {})
        current["instructions"] = drafting.DEFAULT_INSTRUCTIONS
    # §8/§19: in-editor grant arrays in the body win over the stored automation's —
    # the editor's live toggles are the truth while a draft is being worked on.
    enabled_ids = body.get("enabledAgents")
    if enabled_ids is None:
        # §19: edit/sync fall back to the stored grants; create defaults to every
        # configured agent — the same all-enabled seed the Review page starts from.
        enabled_ids = auto["enabled_agents"] if auto else [a["id"] for a in store.agents]
    allowed = body.get("allowedSecrets")
    if allowed is None:
        # create defaults to every stored secret — the same all-on seed the
        # Review page's secrets card starts from
        allowed = auto["allowed_secrets"] if auto else [s["name"] for s in store.secrets]
    grants = {
        "agents": [_agent_grant(g) for g in store.agents if g["id"] in enabled_ids],
        "secrets": [_secret_grant(n) for n in allowed],
    }
    runs = pkg_state = None
    if mode == "chat":
        # §8/§19: the backend assembles the RECENT RUNS and PACKAGES context —
        # the editor never sends run output. `runId` (the §11 Fix-with-AI
        # entry) forces that execution into the section in full detail.
        runs = testexec.runs_context(auto, (current or {}).get("steps") or [],
                                     body.get("runId"))
        if pkgs := (current or {}).get("packages"):
            pkg_state = pkglib.check([{"pip": p.get("pip"), "import": p.get("import")}
                                      for p in pkgs])
    job_id = draft_jobs.start(mode, agent, body.get("text"), current, grants,
                              chat_history=body.get("chat"), runs=runs,
                              pkg_state=pkg_state)
    return {"jobId": job_id}


@app.get("/drafts/{job_id}", dependencies=[Depends(auth)])
def get_draft(job_id: str) -> dict:
    j = draft_jobs.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@app.delete("/drafts/{job_id}", dependencies=[Depends(auth)])
def cancel_draft(job_id: str) -> dict:
    return {"ok": draft_jobs.cancel(job_id)}


# ---------- executions ----------
@app.get("/executions", dependencies=[Depends(auth)])
def list_execs(auto: str | None = None, status: str | None = None) -> list[dict]:
    with store.lock:
        hs = list(store.execs.values())
        if auto:
            hs = [h for h in hs if h["automation_id"] == auto]
        if status:
            hs = [h for h in hs if h["status"] == status]
        return sorted((store.exec_json(h) for h in hs), key=lambda e: e["startedMs"], reverse=True)


@app.get("/executions/{execution_id}", dependencies=[Depends(auth)])
def get_exec(execution_id: str) -> dict:
    with store.lock:
        h = store.exec_full(execution_id)
        if not h:
            raise HTTPException(404, "execution not found")
        return store.exec_json(h, full=True)


@app.get("/executions/{execution_id}/logs", dependencies=[Depends(auth)])
def get_exec_logs(execution_id: str, step: int | None = None, attempt: int | None = None) -> dict:
    """§19: lazy per-step-attempt log — no params selects the execution log."""
    if execution_id not in store.execs:
        raise HTTPException(404, "execution not found")
    lines = store.read_log(execution_id, step, attempt)
    return {"lines": [{"time": l.get("time", ""), "kind": l.get("kind", "out"),
                       "sequence": l.get("sequence", 0), "text": l.get("text", "")} for l in lines]}


@app.get("/executions/{execution_id}/result/{name}", dependencies=[Depends(auth)])
def get_result_file(execution_id: str, name: str):
    """§4.5: raw result-dir file (result.md, result.html, images) for the §7 file views."""
    if execution_id not in store.execs:
        raise HTTPException(404, "execution not found")
    d = (store.exec_dir(execution_id) / "result").resolve()
    f = (d / name).resolve()
    if f.parent != d or not f.is_file():
        raise HTTPException(404, "file not found")
    from fastapi.responses import FileResponse

    return FileResponse(f)


@app.post("/executions/{execution_id}/cancel", dependencies=[Depends(auth)])
def cancel_exec(execution_id: str) -> dict:
    return {"ok": engine.cancel(execution_id)}


@app.post("/executions/{execution_id}/retry", dependencies=[Depends(auth)])
def retry_exec(execution_id: str) -> dict:
    h = store.execs.get(execution_id)
    if not h:
        raise HTTPException(404, "execution not found")
    a = _auto_or_404(h["automation_id"])
    try:
        h2 = engine.retry(a, h)
    except (RuntimeError, LookupError) as e:
        # §7: retry answers 409 while live, when the version no longer
        # resolves, or when a re-saved draft's steps drifted from the record.
        raise HTTPException(409, str(e)) from e
    return {"executionId": h2["id"]}


@app.post("/executions/{execution_id}/skip-step", dependencies=[Depends(auth)])
def skip_step(execution_id: str, body: dict) -> dict:
    if execution_id not in store.execs:
        raise HTTPException(404, "execution not found")
    index = body.get("index")
    if not isinstance(index, int):
        raise HTTPException(422, "index required")
    if not engine.skip_step(execution_id, index):
        raise HTTPException(409, "that step isn't executing right now")
    return {"ok": True}


# ---------- agents ----------
HARNESSES = ("Claude Code", "Gemini CLI", "Codex", "OpenCode")


@app.get("/agents", dependencies=[Depends(auth)])
def list_agents() -> list[dict]:
    with store.lock:
        return _agents_json()


@app.post("/agents", dependencies=[Depends(auth)])
def add_agent(body: dict) -> dict:
    harness_name = body.get("harness")
    if harness_name not in HARNESSES:
        raise HTTPException(422, "unknown harness")
    mode = body.get("mode", "default")
    if mode not in ("default", "ollama", "custom"):
        raise HTTPException(422, "mode must be default | ollama | custom")
    # §4.7: mode ollama is OpenCode driving a local Ollama model; mode custom
    # is a user-typed model string valid with every harness; model is null
    # only in default mode — a null model means the harness uses whatever it
    # is already configured with.
    if mode == "ollama" and harness_name != "OpenCode":
        raise HTTPException(422, "local-model mode needs the OpenCode harness")
    model = (body.get("model") or None) if mode != "default" else None
    if mode == "ollama" and not model:
        raise HTTPException(422, "local-model mode needs a model")
    if mode == "custom" and not model:
        raise HTTPException(422, "custom-model mode needs a model")
    import uuid

    with store.lock:
        ag = {"id": str(uuid.uuid4()), "name": body.get("name") or None, "description": body.get("description") or "",
              "harness": harness_name, "mode": mode, "model": model}
        store.agents.append(ag)
        if store.default_agent_id is None:
            store.default_agent_id = ag["id"]  # §4.7: the first agent is the default
        store.save_agents()
    hub.publish("agents.changed")
    return {**ag, "default": ag["id"] == store.default_agent_id}


@app.patch("/agents/{agent_id}", dependencies=[Depends(auth)])
def patch_agent(agent_id: str, body: dict) -> dict:
    # Same validation as POST — a PATCH must not be able to create an agent
    # shape POST rejects (e.g. mode ollama with no model, §4.7).
    if "harness" in body and body["harness"] not in HARNESSES:
        raise HTTPException(422, "unknown harness")
    if "mode" in body and body["mode"] not in ("default", "ollama", "custom"):
        raise HTTPException(422, "mode must be default | ollama | custom")
    with store.lock:
        ag = _agent_or_404(agent_id)
        mode = body.get("mode", ag.get("mode", "default"))
        harness_name = body.get("harness", ag.get("harness"))
        if mode == "ollama" and harness_name != "OpenCode":
            raise HTTPException(422, "local-model mode needs the OpenCode harness")
        model = body["model"] if "model" in body else ag.get("model")
        if mode == "ollama" and not model:
            raise HTTPException(422, "local-model mode needs a model")
        if mode == "custom" and not model:
            raise HTTPException(422, "custom-model mode needs a model")
        if body.get("default"):
            store.default_agent_id = agent_id  # §4.7: single pointer
        if "harness" in body:
            ag["harness"] = body["harness"]
        for k in ("name", "model", "mode", "description"):
            if k in body:
                ag[k] = body[k]
        if ag.get("mode", "default") == "default":
            ag["model"] = None
        store.save_agents()
    hub.publish("agents.changed")
    return {**ag, "default": ag["id"] == store.default_agent_id}


@app.delete("/agents/{agent_id}", dependencies=[Depends(auth)])
def delete_agent(agent_id: str) -> dict:
    with store.lock:
        ag = _agent_or_404(agent_id)
        store.agents = [g for g in store.agents if g["id"] != agent_id]
        # §4.7: repoint the default
        if store.default_agent_id == agent_id:
            store.default_agent_id = store.agents[0]["id"] if store.agents else None
        for a in store.autos.values():
            changed = False
            if a["agent_id"] == agent_id:
                a["agent_id"] = store.default_agent_id
                changed = True
            if agent_id in a["enabled_agents"]:
                a["enabled_agents"] = [x for x in a["enabled_agents"] if x != agent_id]
                changed = True
            if changed:
                store.patch_automation(a, {})
        store.save_agents()
    hub.publish("agents.changed")
    hub.publish("automation.changed")
    return {"ok": True}


@app.post("/agents/{agent_id}/check", dependencies=[Depends(auth)])
def check_agent(agent_id: str) -> dict:
    ag = _agent_or_404(agent_id)
    return {"status": "ready" if harness.check_ready(ag["harness"], ag.get("model"),
                                                     ag.get("mode", "default"))
            else "needs-setup"}


@app.get("/agents/detect", dependencies=[Depends(auth)])
def detect_agents() -> list[dict]:
    return harness.detect()


def _provider_or_422(provider_id: str | None) -> str:
    if provider_id not in harness.PROVIDER_NAME:
        raise HTTPException(422, "unknown provider")
    return provider_id


@app.post("/agents/check-harness", dependencies=[Depends(auth)])
def check_harness(body: dict) -> dict:
    """§19: the §4.7 readiness check before an agent record exists (§10)."""
    if body.get("harness") not in harness.HARNESS_ID:
        raise HTTPException(422, "unknown harness")
    return {"status": "ready" if harness.check_ready(body["harness"], body.get("model"),
                                                     body.get("mode", "default"))
            else "needs-setup"}


@app.get("/agents/signin/{provider_id}", dependencies=[Depends(auth)])
def agents_signin(provider_id: str) -> dict:
    return harness.signin_state(_provider_or_422(provider_id))


@app.post("/agents/install", dependencies=[Depends(auth)])
def agents_install(body: dict) -> dict:
    pid = _provider_or_422(body.get("id"))

    def publish(**kw) -> None:
        hub.publish("harness.install", id=pid,
                    **{k: v for k, v in kw.items() if v is not None})

    if not installer.start(pid, publish):
        raise HTTPException(409, "an install for this provider is already running")
    return {"ok": True}


@app.get("/agents/install/{provider_id}", dependencies=[Depends(auth)])
def agents_install_status(provider_id: str) -> dict:
    return installer.status(_provider_or_422(provider_id))


@app.post("/agents/login", dependencies=[Depends(auth)])
def agents_login(body: dict) -> dict:
    """§19 sign-in help — only when the provider needs it."""
    pid = _provider_or_422(body.get("id"))
    if pid == "ollama":
        raise HTTPException(409, "Ollama needs no sign-in")
    st = harness.signin_state(pid)
    if not st["installed"]:
        raise HTTPException(409, f"{harness.PROVIDER_NAME[pid]} isn't installed on this Mac")
    if st["signedIn"] is True:
        raise HTTPException(409, "already signed in")
    try:
        method = installer.login(pid)
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {"ok": True, "method": method}


@app.get("/ollama/status", dependencies=[Depends(auth)])
def ollama_status() -> dict:
    return harness.ollama_status()


@app.post("/ollama/pull", dependencies=[Depends(auth)])
def ollama_pull(body: dict) -> dict:
    model = body.get("model")
    if not model:
        raise HTTPException(422, "model required")
    # Never let a model name parse as an option to `ollama pull`.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", str(model)):
        raise HTTPException(422, "invalid model name")

    def pull() -> None:
        try:
            binpath = harness.ollama_bin() or "ollama"
            proc = subprocess.Popen([binpath, "pull", model], stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True,
                                    env=harness.spawn_env(binpath))
            for line in proc.stdout:  # type: ignore[union-attr]
                hub.publish("ollama.pull", model=model, line=line.strip(), done=False)
            proc.wait()
            hub.publish("ollama.pull", model=model, line="", done=True, ok=proc.returncode == 0)
        except FileNotFoundError:
            hub.publish("ollama.pull", model=model, line="ollama isn't installed", done=True, ok=False)
        hub.publish("agents.changed")

    threading.Thread(target=pull, daemon=True).start()
    return {"ok": True}


# ---------- secrets ----------
@app.get("/secrets", dependencies=[Depends(auth)])
def list_secrets() -> list[dict]:
    return _secrets_json()


@app.put("/secrets/{name}", dependencies=[Depends(auth)])
def put_secret(name: str, body: dict) -> dict:
    if not SECRET_NAME_RE.match(name):
        raise HTTPException(422, "secret names must match [A-Z][A-Z0-9_]* — "
                                 "uppercase letters, digits and underscores, starting with a letter")
    value = body.get("value", "")
    if value:
        # Keychain IPC can block for seconds (locked keychain, consent prompt) —
        # never hold store.lock across it; the engine would stall mid-execution.
        try:
            keychain.set_secret(name, value)
        except Exception as e:  # noqa: BLE001 — keyring's error zoo is open-ended
            # A locked keychain or a denied consent prompt is a routine macOS
            # condition, not a server bug: clean 503, nothing stored.
            raise HTTPException(503, f"your Keychain didn't accept the value ({e}) — "
                                     "unlock the login Keychain and try again") from e
    with store.lock:
        existing = next((s for s in store.secrets if s["name"] == name), None)
        if existing is None:
            # §4.8: a blank value on a new name creates a placeholder (set: False).
            existing = {"name": name, "description": "", "set": False}
            store.secrets.append(existing)
        if value:
            existing["set"] = True
        if "description" in body:
            existing["description"] = body.get("description") or ""
        store.save_secrets()
    hub.publish("secrets.changed")
    return {"ok": True}


@app.delete("/secrets/{name}", dependencies=[Depends(auth)])
def delete_secret(name: str) -> dict:
    keychain.delete_secret(name)  # Keychain IPC — outside the lock (see put_secret)
    with store.lock:
        store.secrets = [s for s in store.secrets if s["name"] != name]
        store.save_secrets()
    hub.publish("secrets.changed")
    return {"ok": True}


# ---------- settings ----------
@app.get("/settings", dependencies=[Depends(auth)])
def get_settings() -> dict:
    return _settings_json()


@app.patch("/settings", dependencies=[Depends(auth)])
def patch_settings(body: dict) -> dict:
    # Validate before storing: a bad `days` would otherwise persist and make
    # every hourly retention sweep raise — retention silently off forever.
    if "days" in body:
        try:
            body["days"] = max(1, int(body["days"]))  # §4.9: int ≥ 1
        except (TypeError, ValueError):
            raise HTTPException(422, "days must be a number ≥ 1") from None
    if "notifications" in body and body["notifications"] not in ("attention", "all"):
        raise HTTPException(422, "notifications must be attention | all")
    with store.lock:
        for k in ("login", "menuBarIcon", "keepAwake", "notifications", "days", "keepForever", "developerMode"):
            if k in body:
                store.settings[k] = body[k]
        store.save_settings()
    awake.reconcile(bool(store.settings.get("keepAwake")))  # §3: applies live, no restart
    hub.publish("settings.changed")
    return _settings_json()


@app.post("/settings/data-path", dependencies=[Depends(auth)])
def set_data_path(body: dict) -> dict:
    global _data_size_cache
    raw = str(body.get("path", "")).strip()
    if not raw:
        raise HTTPException(422, "path required")
    new_root = Path(raw).expanduser()
    target = new_root if new_root.name == "executions" else new_root / "executions"
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(422, f"can't create that directory: {e}") from e
    # Nothing moves: execution state lives in the executions dir, so switching
    # the path just closes the old DB and reloads from the new location. The
    # whole swap holds the lock — an engine thread finishing mid-swap would
    # otherwise hit a closed DB and die with the execution stuck "executing" —
    # and is refused while an execution is live (it writes to the old dir).
    with store.lock:
        if any(h["status"] == "executing" for h in store.execs.values()):
            raise HTTPException(409, "an execution is in progress — try again when it finishes")
        # §6: a queued firing would not survive the reload — the in-memory
        # queue dies, the entry never executes and never finishes `skipped`,
        # and its sender is never told. Refuse rather than strand it.
        if any(h["status"] == "queued" for h in store.execs.values()):
            raise HTTPException(409, "a queued execution is waiting — try again when the queue is empty")
        store.close_exec_db()
        store.settings["dataPath"] = str(target)
        store.save_settings()
        store.load_all()
        # The new location may hold records a crashed backend left "executing" —
        # repair them here too, or the automation would be wedged in 409s.
        _repair_stale_executing()
    _data_size_cache = None
    hub.publish("settings.changed")
    hub.publish("automation.changed")
    return _settings_json()


# ---------- websocket ----------
@app.websocket("/ws")
async def ws(sock: WebSocket, token: str = Query("")) -> None:
    if not token_ok(token):
        await sock.close(code=4401)
        return
    await sock.accept()
    q = hub.subscribe()

    async def pump() -> None:
        while True:
            msg = await q.get()
            if msg is OVERFLOW:
                # This client stalled and lost events — close so it reconnects
                # and re-syncs (1013: try again later).
                await sock.close(code=1013)
                return
            await sock.send_json(msg)

    # Stream in a side task and block on receive(): a quiet client publishes
    # nothing, so without the receive-watch a disconnect goes unseen and the
    # handler sits in q.get() forever — holding uvicorn's graceful shutdown.
    sender = asyncio.ensure_future(pump())
    try:
        while (await sock.receive())["type"] != "websocket.disconnect":
            pass
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sender.cancel()
        try:
            await sender  # retrieve a send-side error so it never logs as unretrieved
        except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            pass
        hub.unsubscribe(q)


def _repair_stale_executing() -> None:
    """§3: a record can only be 'executing' while an engine thread owns it —
    anything else (backend restart, a data-path switch onto a crashed tree) is
    marked interrupted. A leftover §6 `queued` record is swept too: the in-memory
    queue died with the process and the sender stopped waiting long ago, so it
    finishes `skipped` rather than executing minutes or days late. Callers hold
    store.lock (RLock, re-entry is fine)."""
    with store.lock:
        for h in list(store.execs.values()):
            if h["status"] == "queued":
                full = store.exec_full(h["id"]) or {**h, "steps": [], "redacted_secrets": [], "params": []}
                full["status"] = "skipped"
                full["note"] = "backend restarted before this ran"
                full["duration_ms"] = 0
                full["finished_at"] = full["started_at"]
                store.execs[full["id"]] = full
                store.update_execution(full)
                continue
            if h["status"] == "executing" and not engine.is_live(h["id"]):
                full = store.exec_full(h["id"]) or {**h, "steps": [], "redacted_secrets": [], "params": []}
                # §3: the previous backend's step group may still be running —
                # kill it before freeing the slot, or the next cron tick starts
                # a second copy writing the same memory/ dir.
                if full.get("pgid"):
                    kill_orphan_group(full["pgid"])
                full["pgid"] = None
                full["status"] = "interrupted"
                full["note"] = full["note"] or "backend restarted mid-execution"
                for s in full["steps"]:
                    if s["status"] == "executing":
                        s["status"] = "interrupted"
                        for a in s.get("attempts", []):
                            if a["status"] == "executing":
                                a["status"] = "interrupted"
                store.execs[full["id"]] = full
                store.update_execution(full)
        store._refresh_exec_derived()


@app.on_event("startup")
async def _bind_loop() -> None:
    hub.bind_loop(asyncio.get_running_loop())
    _repair_stale_executing()
    hub.publish("automation.changed")


@app.on_event("shutdown")
async def _kill_live_steps() -> None:
    # §3: live step groups die with this backend — the successor's startup
    # recovery marks their records interrupted, and an orphan must not keep
    # writing memory/ beside the second copy the next cron tick starts.
    engine.kill_all_live()
