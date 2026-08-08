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

from . import __version__, awake, harness, imessage, installer, keychain, models, paths
from . import drafting, packages as pkglib, reqlog, timefmt, transfer, triggers as triggerlib
from .drafting import draft_jobs
from .engine import Engine, kill_orphan_group
from .events import OVERFLOW, hub
from .firing import cancel_unmatched_queue, drain_queue, finish_never_ran, fire_trigger
from .storage import _kind_ok, iter_file_stats, size_label, store
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


def _publish_auto_changed(a: dict) -> None:
    """§19: a single-automation change event carries the changed row (list
    shape) so clients patch in place instead of re-fetching /state. Bare
    `automation.changed` stays the many-changed resync signal."""
    with store.lock:
        payload = store.auto_json(a, full=False)
    hub.publish("automation.changed", automationId=a["id"], automation=payload)


def _agent_or_404(agent_id: str) -> dict:
    for a in store.agents:
        if a["id"] == agent_id:
            return a
    raise HTTPException(404, "agent not found")


def _check_agent_refs(agent_id: str | None, step_agents: list | None) -> None:
    """§19 cross-field rule: `agentId` and `stepAgents` entries must reference
    configured agents. Needs store state, so it lives here as a 422 rather
    than in the request model."""
    ids = {g["id"] for g in store.agents}
    if agent_id is not None and agent_id not in ids:
        raise HTTPException(422, f"agentId {agent_id!r} isn't a configured agent")
    for x in step_agents or ():
        if x not in ids:
            raise HTTPException(422, f"stepAgents entry {x!r} isn't a configured agent")


def _check_param_values(a: dict, values: dict) -> None:
    """§19 cross-field rule: every paramValues entry must match the
    automation's param definitions by name AND kind — a typo'd name or a
    mistyped value is a 422, never a silently-ignored store."""
    defs = {p["name"]: p.get("kind")
            for p in a["versions"].get(a["current_version"], {}).get("params") or []}
    for name, v in values.items():
        if name not in defs:
            raise HTTPException(422, f"paramValues names an unknown param {name!r}")
        if not _kind_ok(defs[name], v):
            raise HTTPException(
                422, f"paramValues[{name!r}] doesn't match the param's kind ({defs[name]})")


def _validate_draft_steps(d: dict) -> None:
    """§19 server-side step validation: POST /automations and /versions run
    the §8 step validators (`drafting.validate_steps` — ast.parse, the §6.2
    import allowlist, manifest schema and step-file ordering, the
    timeout/retry rules) on the sent draft and answer 422 with the errors —
    an invalid draft can never land as a version, whatever client sent it.
    Grants context mirrors the §20 CLI's existence check: all configured
    agents + all stored secret names."""
    import yaml

    files: dict[str, str] = {}
    man_steps: list[dict] = []
    for s in d.get("steps") or []:
        if not isinstance(s, dict):
            raise HTTPException(422, "each step must be an object")
        files[str(s.get("file") or "")] = str(s.get("code") or "")
        # The serialized step shape carries `agents: []` / `secrets: []` /
        # nulls on steps that have none — the validator's manifest dialect
        # omits those keys instead, so strip the empties on the way in.
        man_steps.append({k: v for k, v in s.items()
                          if k != "code" and v is not None
                          and not (k in ("agents", "secrets", "why") and not v)})
    manifest = {"steps": man_steps, "params": d.get("params") or [],
                "packages": d.get("packages") or []}
    files["manifest.yaml"] = yaml.safe_dump(manifest, sort_keys=False)
    grants = {"agents": [{"name": harness.grant_name(g)} for g in store.agents],
              "secrets": [{"name": s["name"]} for s in store.secrets]}
    _, errors = drafting.validate_steps(files, grants)
    if errors:
        raise HTTPException(422, "the draft doesn't validate: " + "; ".join(errors))


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
def patch_auto(automation_id: str, body: models.AutomationPatch) -> dict:
    a = _auto_or_404(automation_id)
    # §19: the model checked types/shapes (incl. the §6 concurrency ints with
    # their floors); the store-state cross-field rules land here.
    patch = body.model_dump(exclude_unset=True)
    if "agentId" in patch or "stepAgents" in patch:
        _check_agent_refs(patch.get("agentId"), patch.get("stepAgents"))
    if "paramValues" in patch:
        _check_param_values(a, patch["paramValues"])
    if "triggers" in patch:
        # §19: whole-list replace; message kinds / bad expressions / past times → 422.
        norm, err = triggerlib.normalize_triggers(patch["triggers"])
        if err:
            raise HTTPException(422, err)
        patch = {**patch, "triggers": norm}
    store.patch_automation(a, patch)
    if "triggers" in patch:
        # §6: a waiting entry whose trigger was just turned off or removed is
        # cancelled — it could never be re-admitted, and promoting it would
        # execute a firing the user just switched off.
        cancel_unmatched_queue(store, engine, automation_id)
    _publish_auto_changed(a)
    # A raised maxParallel may have just opened a slot for a waiting firing (§6).
    drain_queue(store, engine, automation_id)
    return _auto_json_locked(a)


@app.post("/automations/{automation_id}/queue/clear", dependencies=[Depends(auth)])
def clear_queue(automation_id: str) -> dict:
    """§19: cancel every §6 firing-queue entry waiting on this automation.
    Running executions are untouched — an empty queue answers 0, not 404."""
    a = _auto_or_404(automation_id)
    n = 0
    for h in store.queued_execs(automation_id):
        if engine.cancel(h["id"]):
            n += 1
    if n:
        _publish_auto_changed(a)
    return {"cancelled": n}


@app.post("/triggers/preview", dependencies=[Depends(auth)])
def triggers_preview(body: models.TriggersPreview) -> dict:
    """§19: a pure function endpoint — no state read or written. Validates and
    labels §4.3-shaped trigger dicts with the same triggers.py code that gates
    the PATCH, one result per entry in order. An invalid entry is a
    `valid: false` result, never a 422 (the editors preview half-typed state);
    only a body that isn't a list of trigger dicts gets the ordinary 422.
    Trigger math exists once, here on the backend — the renderer keeps no
    local mirror."""
    out: list[dict] = []
    seen_app_start = False
    for t in body.triggers:
        norm, err = triggerlib.normalize_triggers([t])
        if not err and norm[0]["kind"] == "app_start":
            # §4.3: at most one app_start per list — per-entry validation
            # can't see the duplicate, the loop can.
            if seen_app_start:
                err = "only one app-start trigger per automation"
            seen_app_start = True
        if err:
            entry = {"valid": False, "error": err, "label": "", "short": "", "nextAt": None}
            try:  # best-effort display for a half-typed entry
                entry["label"], entry["short"] = triggerlib.trigger_display(t)
            except Exception:  # noqa: BLE001 — undisplayable is fine, not an error
                pass
            out.append(entry)
            continue
        n = norm[0]
        label, short = triggerlib.trigger_display(n)
        nxt = triggerlib.trigger_next(n)  # None for app_start/message kinds and elapsed one-shots
        entry = {"valid": True, "label": label, "short": short,
                 "nextAt": int(nxt.timestamp() * 1000) if nxt else None}
        if nxt:
            entry["nextLabel"] = f"{nxt.strftime('%b')} {nxt.day}, {timefmt.clock(nxt)}"
        out.append(entry)
    return {"triggers": out}


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
    # §19: the deleted row travels as automation=None — clients drop it in place.
    hub.publish("automation.changed", automationId=automation_id, automation=None)
    return {"ok": True}


def _draft_to_version(d: dict) -> dict:
    # §4.1 spelling boundary: the request models already normalized the steps'
    # camelCase flags (noTimeout/infiniteRetries) to snake_case — nothing past
    # the models reads the camel keys.
    return {"description": d.get("description", ""), "note": d.get("note", ""),
            "params": d.get("params", []), "packages": d.get("packages", []),
            "steps": d.get("steps") or [],
            "spec": d.get("spec") or [], "instructions": d.get("instructions"),
            "notes": d.get("notes") or ""}


@app.post("/automations", dependencies=[Depends(auth)])
def create_auto(body: models.AutomationCreate) -> dict:
    d = body.draft.plain()
    if not d.get("steps"):
        raise HTTPException(422, "draft has no steps")
    _check_agent_refs(body.agentId, body.stepAgents)
    triggers, err = triggerlib.normalize_triggers(d.get("triggers") or [])
    if err:
        raise HTTPException(422, err)
    _validate_draft_steps(d)  # §19: the §8 validators run server-side
    a = store.create_automation(
        _draft_to_version(d),
        name=body.name or d.get("name") or "New automation",
        agent_id=body.agentId,
        triggers=triggers,
        enabled_agents=body.stepAgents,
        allowed_secrets=body.allowedSecrets,
    )
    # §4.4: Create consumes the pending create-mode slot — settled drafts are
    # never resurrected.
    store.delete_draft(None)
    hub.publish("draft.changed")
    _publish_auto_changed(a)
    return _auto_json_locked(a)


@app.post("/automations/{automation_id}/versions", dependencies=[Depends(auth)])
def save_version(automation_id: str, body: models.VersionSave) -> dict:
    a = _auto_or_404(automation_id)
    d = body.draft.plain()
    if not d.get("steps"):
        raise HTTPException(422, "draft has no steps")
    sent = body.model_dump(exclude_unset=True)
    if "agentId" in sent or "stepAgents" in sent:
        _check_agent_refs(sent.get("agentId"), sent.get("stepAgents"))
    # §4.3/§4.4: the draft's trigger list (merged in the editor) replaces the
    # automation's — validated like the PATCH, and before the version lands.
    triggers = None
    if "triggers" in d:
        triggers, err = triggerlib.normalize_triggers(d["triggers"])
        if err:
            raise HTTPException(422, err)
    _validate_draft_steps(d)  # §19: the §8 validators run server-side
    with store.lock:
        # Same guard as PUT/DELETE draft: saving deletes the draft container,
        # and a live Draft execution reads its step scripts lazily mid-run.
        _reject_live_draft_exec(a)
        n = store.save_new_version(a, _draft_to_version(d))
        patch = {k: sent[k] for k in ("agentId", "stepAgents", "allowedSecrets", "name") if k in sent}
        if triggers is not None:
            patch["triggers"] = triggers
        if patch:
            store.patch_automation(a, patch)
        store.delete_draft(a)
    if triggers is not None:
        # §6: same rule as the PATCH — the saved version's trigger list may have
        # dropped or disabled the trigger some waiting entry came from.
        cancel_unmatched_queue(store, engine, automation_id)
    _publish_auto_changed(a)
    return {"version": n, "automation": _auto_json_locked(a)}


def _reject_live_draft_exec(a: dict) -> None:
    """409 while a Draft-version execution runs: rewriting or pruning the
    draft's step scripts mid-run would make later steps execute code that no
    longer matches the recorded per-step sha (§7). Call under store.lock."""
    for eid in a.get("_live") or ():
        live = store.execs.get(eid)
        if live and live.get("kind") == "draft":
            raise HTTPException(409, "a draft execution is in progress")


# §19: the one draft-container surface — GET/PUT/DELETE /draft/{owner} +
# POST /draft/{owner}/open, where `owner` is an automation id (its draft/
# container) or the literal `pending` (the §4.4 create-mode slot <root>/draft/).
def _draft_owner(owner: str) -> dict | None:
    """None → the pending slot; an automation owner that doesn't resolve is 404."""
    if owner == "pending":
        return None
    return _auto_or_404(owner)


def _publish_draft_changed(a: dict | None) -> None:
    if a is None:
        hub.publish("draft.changed")  # §19 GET /state pendingDraft consumers
    else:
        _publish_auto_changed(a)


@app.get("/draft/{owner}", dependencies=[Depends(auth)])
def get_draft_container(owner: str) -> dict:
    return store.draft_container_json(_draft_owner(owner))


@app.post("/draft/{owner}/open", dependencies=[Depends(auth)])
def open_draft_container(owner: str) -> dict:
    store.open_draft(_draft_owner(owner))
    return {"ok": True}


@app.put("/draft/{owner}", dependencies=[Depends(auth)])
def put_draft_container(owner: str, body: models.DraftPut) -> dict:
    a = _draft_owner(owner)
    d = body.draft.plain()
    # §4.4: the draft snapshot carries the editor's grant selections and trigger
    # list as draft-only keys — never applied to the automation until saved.
    # Triggers pass through unvalidated — saving (Create / vN+1) normalizes them.
    ver = _draft_to_version(d)
    ver["step_agents"] = d.get("stepAgents")
    ver["allowed_secrets"] = d.get("allowedSecrets")
    with store.lock:
        if a is None:
            # §19: the pending payload also carries the identity fields no
            # automation record exists to hold (name, triggers; agentId beside).
            store.save_draft(None, ver, name=d.get("name"), agent_id=body.agentId,
                             triggers=d.get("triggers") or [], chat=d.get("chat"))
        else:
            _reject_live_draft_exec(a)
            ver["triggers"] = d.get("triggers")
            store.save_draft(a, ver, chat=d.get("chat"))
    _publish_draft_changed(a)
    return {"ok": True}


@app.delete("/draft/{owner}", dependencies=[Depends(auth)])
def delete_draft_container(owner: str) -> dict:
    a = _draft_owner(owner)
    with store.lock:
        if a is not None:
            _reject_live_draft_exec(a)
        store.delete_draft(a)
    _publish_draft_changed(a)
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
    _publish_auto_changed(a)
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
def import_url(body: models.ImportUrl) -> dict:
    url = body.url.strip()
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
def import_confirm(body: models.ImportConfirm) -> dict:
    slot = _import_parked.pop(body.token, None)
    if slot is None or time.time() - slot[0] > _IMPORT_TTL:
        raise HTTPException(404, "the import preview expired — fetch it again")
    return _land_import(slot[1])


@app.post("/automations/{automation_id}/restore", dependencies=[Depends(auth)])
def restore(automation_id: str, body: models.VersionRestore) -> dict:
    a = _auto_or_404(automation_id)
    v = body.version
    if v not in a["versions"]:
        raise HTTPException(404, f"v{v} not found")
    n = store.restore_version(a, v)
    _publish_auto_changed(a)
    return {"version": n, "automation": _auto_json_locked(a)}


@app.post("/automations/{automation_id}/execute", dependencies=[Depends(auth)])
def execute_auto(automation_id: str, body: models.ExecuteBody | None = None) -> dict:
    a = _auto_or_404(automation_id)
    body = body or models.ExecuteBody()
    # §4.5/§19: the record stores the trigger's machine kind; manual starts are
    # `manual` (Execute now, CLI) or `menubar` (the tray panel) — the model
    # rejects anything else, and a non-string version, with a 422.
    try:
        h = engine.start(a, body.trigger, version_label=body.version)
    except LookupError as e:  # unknown version label — not a liveness conflict
        raise HTTPException(404, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return {"executionId": h["id"]}


_served_launches: set[str] = set()


@app.post("/app-started", dependencies=[Depends(auth)])
def app_started(body: models.AppStarted) -> dict:
    """§6 app-start firing: the Electron main process calls this once per app
    launch; every automation holding an enabled `app_start` trigger executes.
    Idempotent per `launchId` (required, §19 — the model rejects a missing or
    empty one): the caller retries until it gets a response, and a reply lost
    in flight must not fire everything a second time."""
    with store.lock:
        if body.launchId in _served_launches:
            return {"fired": 0}
        _served_launches.add(body.launchId)
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
def post_test(body: models.TestStart) -> dict:
    d = body.draft.plain()
    if not d.get("steps"):
        raise HTTPException(422, "draft with steps required")
    payload = _mock_payload(body.triggerMock) if body.triggerMock else None
    auto = None
    if body.automationId:
        # A stale/unknown automationId must 404 — falling through to create mode
        # would delete the unrelated pending slot's test record.
        auto = _auto_or_404(body.automationId)
    # §19: grant arrays as in /drafts — create mode (no automationId) defaults to
    # ALL agents/secrets when the arrays are absent, edit mode to the
    # automation's grants.
    enabled = body.enabledAgents
    if enabled is None:
        enabled = auto["enabled_agents"] if auto else [g["id"] for g in store.agents]
    allowed = body.allowedSecrets
    if allowed is None:
        allowed = auto["allowed_secrets"] if auto else [s["name"] for s in store.secrets]
    try:
        execution_id = testexec.start(engine, d, auto, enabled, allowed,
                                 body.paramValues or {}, trigger_payload=payload)
    except RuntimeError as e:  # §19: one live test per draft container
        raise HTTPException(409, str(e)) from e
    return {"executionId": execution_id}


# ---------- declared packages (§6.2 — §19 /packages/*) ----------
@app.post("/packages/check", dependencies=[Depends(auth)])
def packages_check(body: models.PackagesBody) -> dict:
    return {"packages": pkglib.check([p.plain() for p in body.packages])}


@app.post("/packages/install", dependencies=[Depends(auth)])
def packages_install(body: models.PackagesBody) -> dict:
    # Blocking §6.2 ensure — FastAPI runs sync endpoints on a worker thread,
    # and the module lock serializes concurrent pip runs.
    return {"packages": pkglib.ensure([p.plain() for p in body.packages])}


@app.post("/packages/outdated", dependencies=[Depends(auth)])
def packages_outdated(body: models.PackagesBody) -> dict:
    # §6.2 update check — read-only PyPI lookups; failures just omit `latest`.
    return {"packages": pkglib.outdated([p.plain() for p in body.packages])}


@app.post("/packages/update", dependencies=[Depends(auth)])
def packages_update(body: models.PackagesBody) -> dict:
    """§6.2 update: `pip install --upgrade` in the shared directory — no
    manifest writes; manifests carry no version. Blocking like /install."""
    entries = [p.plain() for p in body.packages]
    for e in entries:
        if not pkglib.PIP_NAME_RE.match(e["pip"].strip()):
            raise HTTPException(422, f"not a bare distribution name: {e['pip']!r}")
    return {"packages": pkglib.upgrade(entries)}


@app.post("/automations/{automation_id}/memory/clear", dependencies=[Depends(auth)])
def clear_memory(automation_id: str) -> dict:
    # §9.2 MEMORY card: "Clear memory" — next execution starts fresh.
    a = _auto_or_404(automation_id)
    # §19: same guard (and the same lock span) as manual snapshot and restore —
    # a mid-execution clear could delete files a step is reading right now.
    with store.lock:
        if a.get("_live"):
            raise HTTPException(409, "an execution is in progress")
        store.snapshot_memory(a, "pre-clear")  # §6.3 — silently skipped when memory is empty or the toggle is off
        store.clear_memory(a)
    _publish_auto_changed(a)
    return {"ok": True}


@app.post("/automations/{automation_id}/memory/snapshots", dependencies=[Depends(auth)])
def create_snapshot(automation_id: str, body: models.SnapshotCreate | None = None) -> dict:
    # §6.3 manual snapshot — 409 while live, 422 when memory is empty.
    a = _auto_or_404(automation_id)
    # One lock span for check + copy: engine.start flips `_live` under
    # store.lock, so this can't race a trigger into copying half-written memory.
    with store.lock:
        if a.get("_live"):
            raise HTTPException(409, "an execution is in progress")
        meta = store.snapshot_memory(a, "manual",
                                     name=((body.name if body else None) or "").strip() or None)
    if meta is None:
        raise HTTPException(422, "memory is empty")
    _publish_auto_changed(a)
    return {"snapshot": store.snapshot_json(meta)}


@app.patch("/automations/{automation_id}/memory/snapshots/{sid}", dependencies=[Depends(auth)])
def rename_snapshot(automation_id: str, sid: str, body: models.SnapshotRename | None = None) -> dict:
    a = _auto_or_404(automation_id)
    meta = store.rename_snapshot(a, sid, body.name if body else None)
    if meta is None:
        raise HTTPException(404, "snapshot not found")
    _publish_auto_changed(a)
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
    _publish_auto_changed(a)
    return {"ok": True}


@app.delete("/automations/{automation_id}/memory/snapshots/{sid}", dependencies=[Depends(auth)])
def delete_snapshot(automation_id: str, sid: str) -> dict:
    a = _auto_or_404(automation_id)
    if not store.delete_snapshot(a, sid):
        raise HTTPException(404, "snapshot not found")
    _publish_auto_changed(a)
    return {"ok": True}


# ---------- drafts ----------
@app.post("/drafts", dependencies=[Depends(auth)])
def post_draft(body: models.DraftJobStart) -> dict:
    mode = body.mode
    if mode == "chat" and not (body.text or "").strip():
        raise HTTPException(422, "chat mode needs a nonempty text")
    agent = _agent_or_404(body.agentId or store.default_agent_id
                          or (store.agents[0]["id"] if store.agents else ""))
    # §19: an automationId that doesn't resolve answers 404 (like the
    # stale-automationId 404 on /tests) — never a silent fall-back to the
    # create-mode grant defaults below.
    auto = _auto_or_404(body.automationId) if body.automationId else None
    current = body.current.plain() if body.current is not None else None
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
    if body.spec is not None:
        current = dict(current or {})
        current["spec"] = body.spec
    # (§4.1 spelling boundary: the request model already normalized `current`'s
    # camelCase step flags to snake_case.)
    if mode == "create" and not (current or {}).get("instructions"):
        # §8: new automations draft against the default best-practice build
        # instructions; the draft payload carries them back to pre-fill Review.
        current = dict(current or {})
        current["instructions"] = drafting.DEFAULT_INSTRUCTIONS
    # §8/§19: in-editor grant arrays in the body win over the stored automation's —
    # the editor's live toggles are the truth while a draft is being worked on.
    enabled_ids = body.enabledAgents
    if enabled_ids is None:
        # §19: edit/sync fall back to the stored grants; create defaults to every
        # configured agent — the same all-enabled seed the Review page starts from.
        enabled_ids = auto["enabled_agents"] if auto else [a["id"] for a in store.agents]
    allowed = body.allowedSecrets
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
                                     body.runId)
        if pkgs := (current or {}).get("packages"):
            pkg_state = pkglib.check([{"pip": p.get("pip"), "import": p.get("import")}
                                      for p in pkgs])
    job_id = draft_jobs.start(mode, agent, body.text, current, grants,
                              chat_history=body.chat, runs=runs,
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
def skip_step(execution_id: str, body: models.SkipStep) -> dict:
    if execution_id not in store.execs:
        raise HTTPException(404, "execution not found")
    if not engine.skip_step(execution_id, body.index):
        raise HTTPException(409, "that step isn't executing right now")
    return {"ok": True}


# ---------- agents ----------
HARNESSES = ("Claude Code", "Gemini CLI", "Codex", "OpenCode")


@app.get("/agents", dependencies=[Depends(auth)])
def list_agents() -> list[dict]:
    with store.lock:
        return _agents_json()


@app.post("/agents", dependencies=[Depends(auth)])
def add_agent(body: models.AgentAdd) -> dict:
    harness_name = body.harness
    if harness_name not in HARNESSES:
        raise HTTPException(422, "unknown harness")
    mode = body.mode
    # §4.7: mode ollama is OpenCode driving a local Ollama model; mode custom
    # is a user-typed model string valid with every harness; model is null
    # only in default mode — a null model means the harness uses whatever it
    # is already configured with.
    if mode == "ollama" and harness_name != "OpenCode":
        raise HTTPException(422, "local-model mode needs the OpenCode harness")
    model = (body.model or None) if mode != "default" else None
    if mode == "ollama" and not model:
        raise HTTPException(422, "local-model mode needs a model")
    if mode == "custom" and not model:
        raise HTTPException(422, "custom-model mode needs a model")
    import uuid

    with store.lock:
        ag = {"id": str(uuid.uuid4()), "name": body.name or None, "description": body.description or "",
              "harness": harness_name, "mode": mode, "model": model}
        store.agents.append(ag)
        if store.default_agent_id is None:
            store.default_agent_id = ag["id"]  # §4.7: the first agent is the default
        store.save_agents()
    hub.publish("agents.changed")
    return {**ag, "default": ag["id"] == store.default_agent_id}


@app.patch("/agents/{agent_id}", dependencies=[Depends(auth)])
def patch_agent(agent_id: str, patch: models.AgentPatch) -> dict:
    # Same validation as POST — a PATCH must not be able to create an agent
    # shape POST rejects (e.g. mode ollama with no model, §4.7).
    body = patch.model_dump(exclude_unset=True)
    if "harness" in body and body["harness"] not in HARNESSES:
        raise HTTPException(422, "unknown harness")
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
def check_harness(body: models.CheckHarness) -> dict:
    """§19: the §4.7 readiness check before an agent record exists (§10)."""
    if body.harness not in harness.HARNESS_ID:
        raise HTTPException(422, "unknown harness")
    return {"status": "ready" if harness.check_ready(body.harness, body.model, body.mode)
            else "needs-setup"}


@app.get("/agents/signin/{provider_id}", dependencies=[Depends(auth)])
def agents_signin(provider_id: str) -> dict:
    return harness.signin_state(_provider_or_422(provider_id))


@app.post("/agents/install", dependencies=[Depends(auth)])
def agents_install(body: models.ProviderId) -> dict:
    pid = _provider_or_422(body.id)

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
def agents_login(body: models.ProviderId) -> dict:
    """§19 sign-in help — only when the provider needs it."""
    pid = _provider_or_422(body.id)
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
def ollama_pull(body: models.OllamaPull) -> dict:
    model = body.model
    if not model:
        raise HTTPException(422, "model required")
    # Never let a model name parse as an option to `ollama pull`.
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", model):
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
def put_secret(name: str, body: models.SecretPut) -> dict:
    if not SECRET_NAME_RE.match(name):
        raise HTTPException(422, "secret names must match [A-Z][A-Z0-9_]* — "
                                 "uppercase letters, digits and underscores, starting with a letter")
    sent = body.model_dump(exclude_unset=True)
    value = body.value
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
        if "description" in sent:
            existing["description"] = body.description or ""
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
def patch_settings(body: models.SettingsPatch) -> dict:
    # §19: strictly typed by the request model — the §4.9 booleans must be
    # booleans and `days` a real int (bool/float/string are 422s), so a bad
    # value can never persist and silently break the retention sweep.
    patch = body.model_dump(exclude_unset=True)
    if "days" in patch:
        patch["days"] = max(1, patch["days"])  # §4.9: floor 1
    with store.lock:
        for k in ("login", "menuBarIcon", "keepAwake", "notifications", "days", "keepForever", "developerMode"):
            if k in patch:
                store.settings[k] = patch[k]
        store.save_settings()
    awake.reconcile(bool(store.settings.get("keepAwake")))  # §3: applies live, no restart
    hub.publish("settings.changed")
    return _settings_json()


@app.post("/settings/data-path", dependencies=[Depends(auth)])
def set_data_path(body: models.DataPath) -> dict:
    global _data_size_cache
    raw = body.path.strip()
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
                store.execs[full["id"]] = full
                finish_never_ran(store, full, "backend restarted before this ran")
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
