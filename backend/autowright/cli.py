"""`autowright` CLI (§20): full-parity client of the §19 backend API.

Noun-verb groups (automation, execution, secret, agent, settings, service) plus
status/instructions. Authoring goes through workdirs — spec.md + manifest.yaml +
NN-name.py step files — validated with the same §8 validators the drafting
pipeline uses. `--json` on read verbs prints the raw API JSON. Exit codes:
0 ok · 1 error · 2 a followed execution ended other than succeeded.
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
import time
import urllib.request
from pathlib import Path

from . import paths, service

# The backend is always 127.0.0.1 — a configured corporate proxy (http_proxy
# env) must never see these requests (or the bearer token). ProxyHandler({})
# disables proxying outright.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Client:
    def __init__(self) -> None:
        bj = paths.backend_json()
        if not bj.exists():
            sys.exit("backend isn't up (no backend.json) — start it with "
                     "`autowright service install` or `autowright-backend`")
        try:
            info = json.loads(bj.read_text())
            self.base = f"http://127.0.0.1:{info['port']}"
            self.token = info["token"]
        except (OSError, ValueError, KeyError, TypeError):
            # A SIGKILL'd backend can leave a stale/truncated backend.json.
            sys.exit("backend.json is stale or unreadable — restart the backend with "
                     "`autowright service restart` or `autowright-backend`")

    def req(self, method: str, path: str, body: dict | None = None):
        r = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with _opener.open(r, timeout=30) as resp:
                return json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            sys.exit(f"{e.code}: {detail}")
        except (urllib.error.URLError, TimeoutError) as e:
            # §3: backend.json can be well-formed yet point at a dead backend
            # (SIGKILL leftovers) — same clean guidance as a stale file, no traceback.
            sys.exit(f"backend isn't reachable at {self.base} ({e}) — restart it with "
                     "`autowright service restart` or `autowright-backend`")

    def req_raw(self, method: str, path: str, data: bytes | None = None) -> bytes:
        """Binary request — §5.1 archives and §7 result files go over the wire as raw bytes."""
        r = urllib.request.Request(
            self.base + path, data=data,
            headers={"Authorization": f"Bearer {self.token}",
                     "Content-Type": "application/octet-stream"},
            method=method,
        )
        try:
            with _opener.open(r, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            sys.exit(f"{e.code}: {detail}")
        except (urllib.error.URLError, TimeoutError) as e:
            sys.exit(f"backend isn't reachable at {self.base} ({e}) — restart it with "
                     "`autowright service restart` or `autowright-backend`")


# ---------------------------------------------------------------- lookups

def find_automation(c: Client, ref: str) -> dict:
    autos = c.req("GET", "/automations")
    for a in autos:
        if a["id"] == ref or a["name"].lower() == ref.lower():
            return a
    matches = [a for a in autos if ref.lower() in a["name"].lower()]
    if len(matches) == 1:
        return matches[0]
    sys.exit(f"no unique automation matches {ref!r} — "
             f"have: {', '.join(a['name'] for a in autos) or '(none)'}")


def find_execution(c: Client, ref: str | None) -> dict:
    execs = c.req("GET", "/executions")
    if not ref:
        if execs:
            return execs[0]
        sys.exit("no execution found")
    matches = [e for e in execs if e["id"].startswith(ref)]
    if len(matches) == 1:
        return matches[0]
    sys.exit(f"no unique execution matches {ref!r}")


def _pjson(data) -> None:
    print(json.dumps(data, indent=2))


# ---------------------------------------------------------------- log follow

def follow_exec(c: Client, exec_id: str) -> str:
    # Logs are lazy (§19): poll the record for step/attempt structure, then
    # fetch each attempt's log file and print lines past the last seen seq.
    # An attempt fetched once after it reached a terminal status can't grow —
    # skip it on later polls instead of re-downloading its whole file forever.
    seen: dict[tuple, int] = {}   # (step index | None, attempt | None) → last printed seq
    settled: set[tuple] = set()
    while True:
        e = c.req("GET", f"/executions/{exec_id}")
        targets: list[tuple[int | None, int | None, bool]] = [(None, None, False)]  # the execution log
        for i, s in enumerate(e.get("steps", [])):
            for a in s.get("attempts") or []:
                terminal = a.get("status") not in ("executing", "queued")
                targets.append((i, a["n"], terminal))
        for step, attempt, terminal in targets:
            key = (step, attempt)
            if key in settled:
                continue
            q = "" if step is None else f"?step={step}&attempt={attempt}"
            lines = c.req("GET", f"/executions/{exec_id}/logs{q}").get("lines", [])
            last = seen.get(key, 0)
            for ln in lines:
                if ln["seq"] > last:
                    print(f"  {ln['t']} [{ln['k']}] {ln['text']}")
                    last = ln["seq"]
            seen[key] = last
            if terminal:
                settled.add(key)
        if e["status"] != "executing":
            print(f"→ {e['status']} in {e['dur']}")
            return e["status"]
        time.sleep(1)


def _exit_by_status(status: str) -> None:
    """§20 exit codes: 2 when a followed execution ends other than succeeded."""
    if status != "succeeded":
        sys.exit(2)


# ---------------------------------------------------------------- workdir (§20)

WORKDIR_META = ("spec.md", "manifest.yaml", "instructions.md", "notes.md")
# §4.2: the resolved value fields per kind — stripped from pulled manifests
# (values are user-owned operational state, set via `param set`, never versioned).
PARAM_VALUE_KEYS = ("on", "lines", "rows", "value")


def read_workdir(d: Path) -> dict[str, str]:
    from .drafting import STEP_FILE_RE

    if not d.is_dir():
        sys.exit(f"{d} is not a directory")
    files = {}
    for f in sorted(d.iterdir()):
        if f.name in WORKDIR_META or STEP_FILE_RE.match(f.name):
            files[f.name] = f.read_text(encoding="utf-8")
    return files


def _all_grants(c: Client) -> dict:
    """§20: the validators' *existence* context — all configured agents + all
    stored secrets, so a manifest naming an unknown one fails with the §8
    message. Which known names the automation may use is `_grants`'s job."""
    agents = [{"name": a.get("name") or a["harness"]} for a in c.req("GET", "/agents")]
    secrets = [{"name": s["name"]} for s in c.req("GET", "/secrets")]
    return {"agents": agents, "secrets": secrets}


def validate_workdir(c: Client, d: Path) -> dict:
    """§8 validation of a workdir; prints every error and exits 1 on failure.
    Returns the draft payload (spec blocks + steps/params/packages/triggers/instr)."""
    from . import drafting

    files = read_workdir(d)
    errors: list[str] = []
    spec: dict = {}
    if "spec.md" in files:
        spec, errs = drafting.validate_spec({"spec.md": files["spec.md"]})
        errors += errs
    else:
        errors.append("spec.md is missing")
    step_files = {n: t for n, t in files.items() if n not in ("spec.md", "instructions.md", "notes.md")}
    draft, errs = drafting.validate_steps(step_files, _all_grants(c))
    errors += errs
    if errors:
        print(f"{d} doesn't validate:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)
    draft["spec"] = spec["blocks"]
    if "instructions.md" in files:
        draft["instr"] = files["instructions.md"].strip()
    if "notes.md" in files:
        draft["notes"] = files["notes.md"].strip()
    return draft


def _manifest_step(s: dict) -> dict:
    e: dict = {"file": s.get("file"), "name": s.get("name", ""), "desc": s.get("desc", "")}
    if s.get("agent"):
        e["agent"] = True
        e["why"] = s.get("why", "")
        if s.get("agents"):
            e["agents"] = list(s["agents"])
    if s.get("secrets"):
        e["secrets"] = list(s["secrets"])
    if s.get("timeout"):
        e["timeout"] = s["timeout"]
    if s.get("noTimeout"):  # API spelling — the CLI only ever reads API step JSON
        e["no_timeout"] = True
    if s.get("retries"):
        e["retries"] = s["retries"]
    if s.get("infiniteRetries"):
        e["infinite_retries"] = True
    return e


def write_workdir(d: Path, auto: dict) -> list[str]:
    """§20 pull: materialize an automation's current version into a workdir.
    Returns the written filenames."""
    import yaml

    from . import specmd

    d.mkdir(parents=True, exist_ok=True)
    written = ["spec.md", "manifest.yaml"]
    (d / "spec.md").write_text(specmd.blocks_to_md(auto.get("spec") or []), encoding="utf-8")
    manifest: dict = {"name": auto["name"], "desc": auto.get("desc", "")}
    crons = [{"cron": t["expr"], **({"tz": t["tz"]} if t.get("tz") else {})}
             for t in auto.get("triggers") or [] if t["kind"] == "cron"]
    if crons:
        manifest["triggers"] = crons
    params = [{k: v for k, v in p.items() if k not in PARAM_VALUE_KEYS}
              for p in auto.get("params") or []]
    if params:
        manifest["params"] = params
    if auto.get("packages"):
        manifest["packages"] = auto["packages"]
    manifest["steps"] = [_manifest_step(s) for s in auto.get("steps") or []]
    (d / "manifest.yaml").write_text(
        yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True), encoding="utf-8")
    for s in auto.get("steps") or []:
        (d / s["file"]).write_text(s.get("code", ""), encoding="utf-8")
        written.append(s["file"])
    if auto.get("instr"):
        (d / "instructions.md").write_text(auto["instr"] + "\n", encoding="utf-8")
        written.append("instructions.md")
    if (auto.get("notes") or "").strip():
        (d / "notes.md").write_text(auto["notes"].strip() + "\n", encoding="utf-8")
        written.append("notes.md")
    return written


def merge_draft_triggers(stored: list[dict], drafted: list[dict]) -> list[dict]:
    """§4.3 trigger merge, client-side like the editor: drafted crons replace
    the cron subset ((expr, tz) matches keep id and off state, new entries
    arrive enabled, unmatched stored crons drop); drafted message/app-start
    entries add only when no stored trigger matches their identity fields;
    stored non-cron triggers always survive."""
    def same_non_cron(a: dict, b: dict) -> bool:
        if a["kind"] != b["kind"]:
            return False
        if a["kind"] == "app_start":
            return True
        if a["kind"] == "imessage":
            return (a.get("from") == b.get("from")
                    and (a.get("pattern") or "") == (b.get("pattern") or ""))
        if a["kind"] == "discord":
            return (a.get("channel") == b.get("channel") and a.get("secret") == b.get("secret")
                    and (a.get("pattern") or "") == (b.get("pattern") or "")
                    and bool(a.get("mention")) == bool(b.get("mention"))
                    and (a.get("author") or "") == (b.get("author") or ""))
        return False

    out = [t for t in stored if t["kind"] != "cron"]
    for d in drafted:
        if d["kind"] == "cron":
            kept = next((t for t in stored if t["kind"] == "cron"
                         and t["expr"] == d["expr"] and t.get("tz") == d.get("tz")), None)
            out.append(kept or d)
        elif d["kind"] != "time" and not any(same_non_cron(t, d) for t in stored):
            out.append(d)
    return out


def ensure_packages(c: Client, pkgs: list[dict]) -> None:
    """§20: run the §6.2 ensure for a just-saved version's declared packages,
    so an install failure surfaces at save time, not when a trigger fires. A
    failure warns and never fails the save (the §8 rule) — the engine's
    pre-execution ensure retries it before anything runs."""
    if not pkgs:
        return
    r = c.req("POST", "/packages/install", {"packages": pkgs})
    for p in r.get("packages", []):
        if p.get("status") == "installed":
            ver = f" {p['version']}" if p.get("version") else ""
            print(f"  package {p['pip']}{ver} installed")
        else:
            print(f"  warning: package {p['pip']} failed to install — "
                  f"{p.get('error') or 'unknown error'}")


def _step_grant_names(draft: dict, key: str) -> set[str]:
    return {n for s in draft.get("steps", []) for n in s.get(key) or []}


def _grants(c: Client, args, draft: dict,
            stored_agents: list[str] = (), stored_secrets: list[str] = ()) -> tuple[list[str], list[str]]:
    """§20 grant model: the saved grants are the stored lists plus the explicit
    --grant-agent/--grant-secret flags — no all-on seed, no silent widening.
    Every name the workdir needs (per-step agents; per-step secrets plus
    code-referenced secretRefs) must be granted, or this exits 1 naming the
    exact flags to add. Unknown flag names exit with the candidate list."""
    agents = c.req("GET", "/agents")
    known_agents = [a.get("name") or a["harness"] for a in agents]
    known_secrets = [s["name"] for s in c.req("GET", "/secrets")]

    # stepAgents stores agent ids (§4.1 enablement list); grant flags and step
    # `agents:` entries use §8 grant names — compare at name level, save ids.
    grant_name_by_id = {a["id"]: (a.get("name") or a["harness"]) for a in agents}
    granted_agent_ids = list(stored_agents)
    for name in args.grant_agent:
        match = [a for a in agents
                 if (a.get("name") or a["harness"]).lower() == name.lower()]
        if not match:
            sys.exit(f"no agent named {name!r} — have: {', '.join(known_agents) or '(none)'}")
        if match[0]["id"] not in granted_agent_ids:
            granted_agent_ids.append(match[0]["id"])
    granted_agents = {grant_name_by_id[i] for i in granted_agent_ids if i in grant_name_by_id}
    granted_secrets = set(stored_secrets)
    for name in args.grant_secret:
        if name not in known_secrets:
            sys.exit(f"no stored secret named {name!r} — have: "
                     f"{', '.join(sorted(known_secrets)) or '(none)'}")
        granted_secrets.add(name)

    need_agents = _step_grant_names(draft, "agents")
    need_secrets = _step_grant_names(draft, "secrets") | set(draft.get("secretRefs") or [])
    # Manifest names are existence-checked by the validators; code-referenced
    # secrets (secretRefs) aren't, so a nonexistent one needs storing, not a flag.
    unknown = sorted(n for n in need_secrets - granted_secrets if n not in known_secrets)
    if unknown:
        sys.exit(f"the step code references secrets that don't exist: {', '.join(unknown)} — "
                 f"store them first with `autowright secret set <NAME>`")
    missing = ([f"--grant-agent {n}" for n in sorted(need_agents - granted_agents)]
               + [f"--grant-secret {n}" for n in sorted(need_secrets - granted_secrets)])
    if missing:
        sys.exit("the steps use agents/secrets this automation isn't granted — "
                 f"grants are explicit (§20); re-run with {' '.join(missing)}")
    # §20: an agent step with no `agents:` list runs on the first enabled agent,
    # so it still needs at least one granted agent.
    if not granted_agent_ids and any(s.get("agent") for s in draft.get("steps", [])):
        sys.exit("an agent step needs at least one granted agent — re-run with "
                 f"--grant-agent <NAME> (have: {', '.join(known_agents) or '(none)'})")
    return granted_agent_ids, sorted(granted_secrets)


# ---------------------------------------------------------------- top level

def cmd_status(c: Client, args) -> None:
    h = c.req("GET", "/health")
    s = c.req("GET", "/state")
    info = {
        "version": h.get("version"), "backend": c.base,
        "automations": len(s.get("autos") or s.get("automations") or []),
        "executions": len(s.get("execs") or s.get("executions") or []),
        "agents": len(s.get("agents") or []),
        "secrets": len(s.get("secrets") or []),
        "pendingDraft": s.get("pendingDraft"),
    }
    if args.json:
        _pjson(info)
        return
    print(f"backend {info['version']} at {info['backend']}")
    print(f"{info['automations']} automations · {info['executions']} executions · "
          f"{info['agents']} agents · {info['secrets']} secrets")
    if info["pendingDraft"]:
        print(f"pending create draft: {info['pendingDraft'].get('name') or '(unnamed)'}")


def cmd_instructions(c: Client, args) -> None:
    r = c.req("GET", "/instructions")
    if args.json:
        _pjson(r)
        return
    print(r.get("framework", ""))


# ---------------------------------------------------------------- automation

def cmd_automation_list(c: Client, args) -> None:
    autos = c.req("GET", "/automations")
    if args.json:
        _pjson(autos)
        return
    for a in autos:
        chip = a["triggerChip"] + (" (off)" if a.get("triggersOff") else "")
        print(f"{a['name']:<32} {chip:<16} {a['lastStatus']:<11} "
              f"{a.get('resultChip') or ''}  [{a['id'][:8]}]")


def cmd_automation_show(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    full = c.req("GET", f"/automations/{a['id']}")
    if args.json:
        _pjson(full)
        return
    print(f"{full['name']} [{full['id']}] — {full['specMeta']}")
    if full.get("desc"):
        print(full["desc"])
    print(f"status: {full['lastStatus']}"
          + (f" · {full['resultChip']}" if full.get("resultChip") else ""))
    for i, t in enumerate(full.get("triggers") or [], 1):
        print(f"trigger {i}: {t['label']}" + (" (off)" if t.get("off") else ""))
    for p in full.get("params") or []:
        print(f"param {p['name']} ({p['kind']}): {_param_value(p)!r}")
    for i, s in enumerate(full.get("steps") or [], 1):
        tags = "".join([" [agent]" if s.get("agent") else "",
                        f" [secrets: {', '.join(s['secrets'])}]" if s.get("secrets") else ""])
        print(f"step {i}: {s['name']}{tags}")
    vs = [f"v{v['v']}" for v in full.get("versions") or []]
    if vs:
        print(f"history: {', '.join(vs)}")
    if full.get("draft"):
        print("has an unsaved draft")


def cmd_automation_pull(c: Client, args) -> None:
    from .transfer import safe_filename

    a = find_automation(c, args.automation)
    full = c.req("GET", f"/automations/{a['id']}")
    d = Path(args.dir or safe_filename(full["name"]))
    for name in write_workdir(d, full):
        print(f"wrote {d / name}")


def cmd_automation_push(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    full = c.req("GET", f"/automations/{a['id']}")
    draft = validate_workdir(c, Path(args.dir))
    if args.note:
        draft["note"] = args.note
    draft["triggers"] = merge_draft_triggers(full.get("triggers") or [], draft["triggers"])
    # §20 grant model: stored grants plus explicit --grant-* flags, never
    # widened by what the pushed steps happen to reference.
    step_agents, allowed_secrets = _grants(c, args, draft,
                                           stored_agents=full.get("stepAgents") or [],
                                           stored_secrets=full.get("allowedSecrets") or [])
    body = {"draft": draft, "stepAgents": step_agents, "allowedSecrets": allowed_secrets}
    r = c.req("POST", f"/automations/{a['id']}/versions", body)
    print(f"saved {full['name']!r} as v{r['version']}")
    ensure_packages(c, draft.get("packages") or [])


def cmd_automation_create(c: Client, args) -> None:
    d = Path(args.dir)
    draft = validate_workdir(c, d)
    name = args.name or draft.get("name") or d.resolve().name
    agents = c.req("GET", "/agents")
    agent_id = None
    if args.agent:
        match = [a for a in agents
                 if (a.get("name") or a["harness"]).lower() == args.agent.lower()]
        if not match:
            sys.exit(f"no agent named {args.agent!r} — have: "
                     f"{', '.join(a.get('name') or a['harness'] for a in agents) or '(none)'}")
        agent_id = match[0]["id"]
    # §20 grant model: create grants exactly the --grant-* flags — no all-on seed.
    step_agents, allowed_secrets = _grants(c, args, draft)
    body = {"draft": draft, "name": name, "agentId": agent_id,
            "stepAgents": step_agents, "allowedSecrets": allowed_secrets}
    r = c.req("POST", "/automations", body)
    n = len(r.get("triggers") or [])
    print(f"created {r['name']!r} [{r['id'][:8]}] — "
          + (f"{n} trigger(s) enabled" if n else "no triggers (execute manually)"))
    ensure_packages(c, draft.get("packages") or [])


def cmd_automation_delete(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    if not args.yes:
        sys.exit(f"deleting {a['name']!r} removes every version and its execution "
                 "history — add --yes to confirm")
    c.req("DELETE", f"/automations/{a['id']}")
    print(f"deleted {a['name']!r}")


def cmd_automation_restore(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    v = args.version.lstrip("vV")
    if not v.isdigit():
        sys.exit(f"version must be vN, got {args.version!r}")
    r = c.req("POST", f"/automations/{a['id']}/restore", {"v": int(v)})
    print(f"restored v{v} of {a['name']!r} as v{r.get('version', '?')}")


def cmd_automation_execute(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    body: dict = {"trigger": "manual"}  # §4.5 machine kind; the API serializes the label
    if args.version:
        body["version"] = args.version
    r = c.req("POST", f"/automations/{a['id']}/execute", body)
    print(f"started — execution {r['execId']}")
    if args.follow:
        _exit_by_status(follow_exec(c, r["execId"]))


def cmd_automation_export(c: Client, args) -> None:
    from .transfer import safe_filename

    a = find_automation(c, args.automation)
    q = "?values=0" if args.no_values else ""
    data = c.req_raw("GET", f"/automations/{a['id']}/export{q}")
    path = args.path or f"{safe_filename(a['name'])}.autowright"
    with open(path, "wb") as f:
        f.write(data)
    print(f"exported {a['name']!r} to {path}")


def cmd_automation_import(c: Client, args) -> None:
    try:
        with open(args.path, "rb") as f:
            data = f.read()
    except OSError as e:
        sys.exit(str(e))
    r = json.loads(c.req_raw("POST", "/automations/import", data).decode() or "{}")
    s = r.get("summary", {})
    print(f"imported {r.get('auto', {}).get('name', '?')!r} [{r.get('auto', {}).get('id', '')[:8]}]")
    if s.get("secretsCreated"):
        print(f"  secrets that need values: {', '.join(s['secretsCreated'])}")
    if s.get("secretsExisting"):
        print(f"  existing secrets to grant on the edit page: {', '.join(s['secretsExisting'])}")
    if s.get("agentsCreated"):
        print(f"  agents added: {', '.join(s['agentsCreated'])}")
    if s.get("agentsReused"):
        print(f"  agents reused: {', '.join(s['agentsReused'])}")
    ensure_packages(c, s.get("packages") or [])
    print("  triggers imported off — enable them with `autowright automation trigger on`")


# ------------------------------------------------------------ automation param

def _param_value(p: dict):
    kind = p.get("kind")
    if kind == "toggle":
        return p.get("on", False)
    if kind == "list":
        return p.get("lines", [])
    if kind == "kv":
        return p.get("rows", [])
    return p.get("value")


def parse_param_value(p: dict, raw: str):
    """§20: parse a `param set` VALUE by the definition's kind."""
    kind = p["kind"]
    if kind == "toggle":
        low = raw.strip().lower()
        if low in ("on", "true", "1", "yes"):
            return True
        if low in ("off", "false", "0", "no"):
            return False
        sys.exit(f"param {p['name']}: toggle takes on|off, got {raw!r}")
    if kind == "number":
        try:
            return int(raw)
        except ValueError:
            sys.exit(f"param {p['name']}: number takes an integer, got {raw!r}")
    if kind == "list":
        if raw.strip().startswith("["):
            try:
                v = json.loads(raw)
            except ValueError as e:
                sys.exit(f"param {p['name']}: bad JSON array — {e}")
            if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
                sys.exit(f"param {p['name']}: expected a JSON array of strings")
            return v
        return [x.strip() for x in raw.split(",") if x.strip()]
    if kind == "kv":
        if raw.strip().startswith("{"):
            try:
                v = json.loads(raw)
            except ValueError as e:
                sys.exit(f"param {p['name']}: bad JSON object — {e}")
            if not isinstance(v, dict):
                sys.exit(f"param {p['name']}: expected a JSON object")
            return [{"k": k, "v": str(x)} for k, x in v.items()]
        rows = []
        for pair in raw.split(","):
            if pair.strip():
                k, sep, v = pair.partition("=")
                if not sep or not k.strip():
                    sys.exit(f"param {p['name']}: kv takes k=v[,k=v] or a JSON object, got {raw!r}")
                rows.append({"k": k.strip(), "v": v.strip()})
        return rows
    return raw  # text


def cmd_param_list(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    params = c.req("GET", f"/automations/{a['id']}")["params"]
    if args.json:
        _pjson(params)
        return
    for p in params:
        print(f"{p['name']:<24} {p['kind']:<8} {_param_value(p)!r}")


def cmd_param_set(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    defs = {p["name"]: p for p in c.req("GET", f"/automations/{a['id']}")["params"]}
    values = {}
    for item in args.values:
        name, sep, raw = item.partition("=")
        if not sep:
            sys.exit(f"expected NAME=VALUE, got {item!r}")
        if name not in defs:
            sys.exit(f"no param named {name!r} — have: {', '.join(defs) or '(none)'}")
        values[name] = parse_param_value(defs[name], raw)
    c.req("PATCH", f"/automations/{a['id']}", {"paramValues": values})
    print(f"set {', '.join(values)} on {a['name']!r}")


# ---------------------------------------------------------- automation trigger

def cmd_trigger_list(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    triggers = c.req("GET", f"/automations/{a['id']}")["triggers"]
    if args.json:
        _pjson(triggers)
        return
    if not triggers:
        print("no triggers — executes only via `automation execute` or the menu bar")
    for i, t in enumerate(triggers, 1):
        print(f"{i}. {t['label']}" + (" (off)" if t.get("off") else ""))


def _stored_triggers(c: Client, auto_id: str) -> list[dict]:
    # label/short are §4.3 display derivations — the PATCH normalizer ignores
    # extra keys, so stored entries round-trip as-is.
    return c.req("GET", f"/automations/{auto_id}")["triggers"]


def _trigger_at_index(triggers: list[dict], n: str) -> dict:
    if not n.isdigit() or not 1 <= int(n) <= len(triggers):
        sys.exit(f"trigger index must be 1..{len(triggers)} (see `automation trigger list`)")
    return triggers[int(n) - 1]


def cmd_trigger_add(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    if args.discord:
        if not args.secret:
            sys.exit("a Discord trigger needs --secret, the name of the secret "
                     "holding the bot token")
        entry: dict = {"kind": "discord", "channel": args.discord,
                       "secret": args.secret, "off": False}
        if args.pattern:
            entry["pattern"] = args.pattern
        if args.mention:
            entry["mention"] = True
        if args.author:
            entry["author"] = args.author
    elif args.imessage:
        entry = {"kind": "imessage", "from": args.imessage, "off": False}
        if args.pattern:
            entry["pattern"] = args.pattern
    elif args.app_start:
        entry = {"kind": "app_start", "off": False}
    elif args.at:
        entry = {"kind": "time", "at": args.at, "off": False}
    elif args.expr:
        entry = {"kind": "cron", "expr": args.expr, "off": False}
    else:
        sys.exit("give a cron expression, --at for a one-shot, --app-start, "
                 "--discord for a Discord message trigger, or --imessage for "
                 "an iMessage trigger")
    if args.tz:
        entry["tz"] = args.tz
    triggers = _stored_triggers(c, a["id"]) + [entry]
    r = c.req("PATCH", f"/automations/{a['id']}", {"triggers": triggers})
    print(f"added — now: {r['triggerChip']}")


def cmd_trigger_toggle(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    triggers = _stored_triggers(c, a["id"])
    t = _trigger_at_index(triggers, args.index)
    t["off"] = args.fn_off
    c.req("PATCH", f"/automations/{a['id']}", {"triggers": triggers})
    print(f"trigger {args.index} ({t['short']}) now {'off' if t['off'] else 'on'}")


def cmd_trigger_remove(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    triggers = _stored_triggers(c, a["id"])
    t = _trigger_at_index(triggers, args.index)
    triggers.remove(t)
    c.req("PATCH", f"/automations/{a['id']}", {"triggers": triggers})
    print(f"removed trigger {args.index} ({t['short']})")


# ----------------------------------------------------- automation memory/snapshot

def cmd_memory_clear(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    c.req("POST", f"/automations/{a['id']}/memory/clear")
    print("memory cleared (a pre-clear snapshot was taken when memory existed)")


def _find_snapshot(c: Client, auto: dict, ref: str) -> dict:
    snaps = c.req("GET", f"/automations/{auto['id']}")["snapshots"]
    matches = [s for s in snaps if s["id"].startswith(ref)]
    if len(matches) == 1:
        return matches[0]
    sys.exit(f"no unique snapshot matches {ref!r} — see `automation snapshot list`")


def cmd_snapshot_list(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    snaps = c.req("GET", f"/automations/{a['id']}")["snapshots"]
    if args.json:
        _pjson(snaps)
        return
    for s in snaps:
        name = s.get("name") or ""
        print(f"{s['id'][:8]}  {s['when']:<16} {s['reason']:<11} {s['version']:<5} "
              f"{s['size']:<9} {name}")


def cmd_snapshot_create(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    r = c.req("POST", f"/automations/{a['id']}/memory/snapshots",
              {"name": args.name} if args.name else {})
    print(f"snapshot {r.get('snapshot', {}).get('id', '')[:8]} created")


def cmd_snapshot_restore(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    s = _find_snapshot(c, a, args.snapshot)
    c.req("POST", f"/automations/{a['id']}/memory/snapshots/{s['id']}/restore")
    print(f"restored snapshot {s['id'][:8]} (a pre-restore snapshot was taken first)")


def cmd_snapshot_delete(c: Client, args) -> None:
    a = find_automation(c, args.automation)
    s = _find_snapshot(c, a, args.snapshot)
    c.req("DELETE", f"/automations/{a['id']}/memory/snapshots/{s['id']}")
    print(f"deleted snapshot {s['id'][:8]}")


# ---------------------------------------------------------------- execution

def cmd_execution_list(c: Client, args) -> None:
    q = []
    if args.automation:
        q.append(f"auto={find_automation(c, args.automation)['id']}")
    if args.status:
        q.append(f"status={args.status}")
    execs = c.req("GET", "/executions" + ("?" + "&".join(q) if q else ""))
    if args.json:
        _pjson(execs[: args.n])
        return
    for e in execs[: args.n]:
        print(f"{e['started']:<22} {e['autoName']:<30} {e['ver']:<6} {e['status']:<11} "
              f"{e['dur']:<8} {e['trigger']:<9} [{e['id'][:8]}]")


def cmd_execution_show(c: Client, args) -> None:
    e = find_execution(c, args.execution)
    full = c.req("GET", f"/executions/{e['id']}")
    if args.json:
        _pjson(full)
        return
    print(f"{full['autoName']} {full['ver']} — {full['status']} in {full['dur']} "
          f"({full['trigger']}, {full['started']}) [{full['id']}]")
    p = full.get("triggerPayload")
    if p:
        # §20 trigger-message parity: kind-aware like the UI's TRIGGER MESSAGE
        # block — an iMessage payload has no channel; never print the secret.
        if p.get("channelName"):
            origin = f"#{p['channelName']}"
            if p.get("guildName"):
                origin += f" · {p['guildName']}"
        else:
            origin = p.get("channel")
        parts = [p["sender"], *([origin] if origin else []), p["at"]]
        print("trigger message: " + " · ".join(parts))
        print(f"  {p['text']}")
    for i, s in enumerate(full.get("steps") or [], 1):
        print(f"step {i}: {s['name']:<32} {s['status']:<11} {s.get('dur') or ''}")
    if full.get("error"):
        err = full["error"]
        print(f"error in {err['step']!r}: {err['message']}")
        if err.get("reason"):
            print(f"possible reason: {err['reason']}")
    r = full.get("result") or {}
    if r.get("chip"):
        print(f"result: {r['chip']}")
    for f in r.get("files") or []:
        print(f"file: {f['name']} ({f['size']})")


def cmd_execution_tail(c: Client, args) -> None:
    e = find_execution(c, args.execution)
    _exit_by_status(follow_exec(c, e["id"]))


def cmd_execution_cancel(c: Client, args) -> None:
    e = find_execution(c, args.execution)
    c.req("POST", f"/executions/{e['id']}/cancel")
    print(f"cancelled {e['id'][:8]}")


def cmd_execution_retry(c: Client, args) -> None:
    e = find_execution(c, args.execution)
    c.req("POST", f"/executions/{e['id']}/retry")
    print(f"retrying {e['id'][:8]} in place")
    if args.follow:
        _exit_by_status(follow_exec(c, e["id"]))


def cmd_execution_skip(c: Client, args) -> None:
    e = find_execution(c, args.execution)
    full = c.req("GET", f"/executions/{e['id']}")
    executing = [i for i, s in enumerate(full.get("steps") or [])
                 if s["status"] == "executing"]
    if not executing:
        sys.exit("no step is executing")
    c.req("POST", f"/executions/{e['id']}/skip-step", {"index": executing[0]})
    print(f"skipping step {executing[0] + 1}")


def cmd_execution_result(c: Client, args) -> None:
    e = find_execution(c, args.execution)
    if not args.name:
        full = c.req("GET", f"/executions/{e['id']}")
        for f in (full.get("result") or {}).get("files") or []:
            print(f"{f['name']} ({f['size']})")
        return
    data = c.req_raw("GET", f"/executions/{e['id']}/result/{args.name}")
    sys.stdout.buffer.write(data)


# ---------------------------------------------------------------- secret/agent

def cmd_secret_list(c: Client, args) -> None:
    secrets = c.req("GET", "/secrets")
    if args.json:
        _pjson(secrets)
        return
    for s in secrets:
        tag = "" if s.get("set", True) else " (not set)"
        used = ", ".join(s.get("usedBy") or []) or "not used yet"  # §4.8: usedBy is a list
        print(f"{s['name'] + tag:<28} used by: {used}")


def cmd_secret_set(c: Client, args) -> None:
    # §20: a secret value never rides argv — it would land in shell history and
    # in every local process's view of the process list.
    value = sys.stdin.readline().rstrip("\n") if args.stdin \
        else getpass.getpass(f"value for {args.name}: ")
    if not value:
        print("no value given — nothing saved")
        raise SystemExit(1)
    c.req("PUT", f"/secrets/{args.name}", {"value": value})
    print("saved to your Keychain")


def cmd_secret_delete(c: Client, args) -> None:
    c.req("DELETE", f"/secrets/{args.name}")
    print("removed from your Keychain")


def cmd_agent_list(c: Client, args) -> None:
    agents = c.req("GET", "/agents")
    if args.json:
        _pjson(agents)
        return
    for a in agents:
        star = "*" if a.get("default") else " "
        print(f"{star} {(a.get('name') or a['harness']):<24} {a['harness']:<12} "
              f"{a['model'] or 'default model'}")


def cmd_agent_check(c: Client, args) -> None:
    agents = c.req("GET", "/agents")
    match = [a for a in agents
             if (a.get("name") or a["harness"]).lower() == args.agent.lower()]
    if not match:
        sys.exit(f"no agent named {args.agent!r} — have: "
                 f"{', '.join(a.get('name') or a['harness'] for a in agents) or '(none)'}")
    r = c.req("POST", f"/agents/{match[0]['id']}/check")
    print(json.dumps(r))


# ---------------------------------------------------------------- settings

SETTINGS_KEYS = {"login": bool, "mbIcon": bool, "keepAwake": bool, "notif": str, "days": int,
                 "keepForever": bool, "devMode": bool}


def cmd_settings_show(c: Client, args) -> None:
    s = c.req("GET", "/settings")
    if args.json:
        _pjson(s)
        return
    for k, v in s.items():
        print(f"{k:<14} {v}")


def cmd_settings_set(c: Client, args) -> None:
    patch: dict = {}
    for item in args.values:
        k, sep, raw = item.partition("=")
        if not sep:
            sys.exit(f"expected KEY=VALUE, got {item!r}")
        if k == "dataPath":
            c.req("POST", "/settings/data-path", {"path": raw})
            print(f"execution data now at {raw}")
            continue
        if k not in SETTINGS_KEYS:
            sys.exit(f"unknown setting {k!r} — have: {', '.join(SETTINGS_KEYS)}, dataPath")
        kind = SETTINGS_KEYS[k]
        if kind is bool:
            patch[k] = raw.strip().lower() in ("on", "true", "1", "yes")
        elif kind is int:
            try:
                patch[k] = int(raw)
            except ValueError:
                sys.exit(f"{k} takes an integer, got {raw!r}")
        else:
            patch[k] = raw
    if patch:
        c.req("PATCH", "/settings", patch)
        print(f"set {', '.join(patch)}")


# ---------------------------------------------------------------- service

def cmd_service(_c, args) -> None:
    print({"install": service.install, "uninstall": service.uninstall,
           "status": service.status, "restart": service.restart}[args.action]())


# ---------------------------------------------------------------- parser

def _sub(parent, name: str, fn, help: str, client: bool = True, json_flag: bool = False):
    p = parent.add_parser(name, help=help)
    p.set_defaults(fn=fn, client=client)
    if json_flag:
        p.add_argument("--json", action="store_true", help="print the raw API JSON")
    return p


# §20: the full surface is on. False registers only `service` (the group the
# packaged app shells out to at launch, §3 ensure-backend) — kept as a switch
# because the test suite exercises both parser shapes.
CLI_ENABLED = True

_DISABLED_NOTE = ("Automation commands are disabled in this release — "
                  "create, edit, and execute automations in the Autowright app.")


def _grant_flags(p) -> None:
    """§20 grant model: the explicit, repeatable grant flags on create/push."""
    p.add_argument("--grant-agent", action="append", default=[], metavar="NAME",
                   help="grant the automation use of this configured agent (repeatable)")
    p.add_argument("--grant-secret", action="append", default=[], metavar="NAME",
                   help="grant the automation this stored secret (repeatable)")


def _add_service(top) -> None:
    p = _sub(top, "service", cmd_service, "manage the launchd service (§3)", client=False)
    p.add_argument("action", choices=["install", "uninstall", "status", "restart"])


def build_parser(full: bool = CLI_ENABLED) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="autowright", description="Autowright from the command line",
        epilog=None if full else _DISABLED_NOTE)
    top = ap.add_subparsers(dest="cmd", required=True)

    if not full:
        _add_service(top)
        return ap

    _sub(top, "status", cmd_status, "backend health and entity counts", json_flag=True)
    _sub(top, "instructions", cmd_instructions,
         "the framework instructions step code must follow (§8)", json_flag=True)

    # ---- automation
    ag = _sub(top, "automation", None, "manage automations").add_subparsers(
        dest="verb", required=True)
    _sub(ag, "list", cmd_automation_list, "list automations", json_flag=True)
    p = _sub(ag, "show", cmd_automation_show, "full record: spec, steps, triggers, params",
             json_flag=True)
    p.add_argument("automation")
    p = _sub(ag, "pull", cmd_automation_pull,
             "materialize into a workdir (spec.md, manifest.yaml, steps) for editing")
    p.add_argument("automation")
    p.add_argument("dir", nargs="?", help="target directory (default: the automation's name)")
    p = _sub(ag, "push", cmd_automation_push, "validate a workdir and save it as the next version")
    p.add_argument("automation")
    p.add_argument("dir", help="workdir to validate and save")
    p.add_argument("--note", help="version note for the history menu")
    _grant_flags(p)
    p = _sub(ag, "create", cmd_automation_create, "validate a workdir and create a new automation")
    p.add_argument("dir", help="workdir to validate and create from")
    p.add_argument("--name", help="automation name (default: manifest name, then the dir name)")
    p.add_argument("--agent", help="drafting agent, by name")
    _grant_flags(p)
    p = _sub(ag, "delete", cmd_automation_delete, "delete an automation and its history")
    p.add_argument("automation")
    p.add_argument("--yes", action="store_true", help="confirm the deletion")
    p = _sub(ag, "restore", cmd_automation_restore, "restore an old version as the next version")
    p.add_argument("automation")
    p.add_argument("version", help="vN")
    p = _sub(ag, "execute", cmd_automation_execute, "execute an automation now")
    p.add_argument("automation")
    p.add_argument("-f", "--follow", action="store_true", help="stream logs until it finishes")
    p.add_argument("--version", help='execute an old version or the draft once ("vN" | "draft")')
    p = _sub(ag, "export", cmd_automation_export, "export to a .autowright file")
    p.add_argument("automation")
    p.add_argument("path", nargs="?", help="output file (default: <name>.autowright)")
    p.add_argument("--no-values", action="store_true", help="leave your parameter values out")
    p = _sub(ag, "import", cmd_automation_import, "import a .autowright file")
    p.add_argument("path")

    pg = _sub(ag, "param", None, "parameter values").add_subparsers(dest="verb2", required=True)
    p = _sub(pg, "list", cmd_param_list, "list parameters and their values", json_flag=True)
    p.add_argument("automation")
    p = _sub(pg, "set", cmd_param_set, "set parameter values")
    p.add_argument("automation")
    p.add_argument("values", nargs="+", metavar="NAME=VALUE")

    tg = _sub(ag, "trigger", None, "triggers").add_subparsers(dest="verb2", required=True)
    p = _sub(tg, "list", cmd_trigger_list, "list triggers with their indexes", json_flag=True)
    p.add_argument("automation")
    p = _sub(tg, "add", cmd_trigger_add, "add a trigger")
    p.add_argument("automation")
    p.add_argument("expr", nargs="?", help='cron expression ("0 8 * * *")')
    p.add_argument("--at", help='one-shot local ISO time ("2026-08-01T09:00")')
    p.add_argument("--app-start", action="store_true", help="fire at every app launch")
    p.add_argument("--discord", metavar="CHANNEL",
                   help="fire on Discord messages in this channel id (needs --secret)")
    p.add_argument("--secret", metavar="NAME",
                   help="secret holding the Discord bot token (with --discord)")
    p.add_argument("--imessage", metavar="FROM",
                   help="fire on iMessages from this sender — a phone in "
                        "+15551234567 form or an email")
    p.add_argument("--pattern", metavar="TEXT",
                   help="only messages containing this text "
                        "(with --discord or --imessage)")
    p.add_argument("--mention", action="store_true",
                   help="only Discord messages that mention the bot (with --discord)")
    p.add_argument("--author", metavar="USER_ID",
                   help="only Discord messages from this numeric user id, like "
                        "234567890123456789 (with --discord; for several senders, "
                        "add one trigger per user id)")
    p.add_argument("--tz", help="IANA zone for the cron/one-shot")
    p = _sub(tg, "on", cmd_trigger_toggle, "enable a trigger by index")
    p.add_argument("automation")
    p.add_argument("index")
    p.set_defaults(fn_off=False)
    p = _sub(tg, "off", cmd_trigger_toggle, "disable a trigger by index")
    p.add_argument("automation")
    p.add_argument("index")
    p.set_defaults(fn_off=True)
    p = _sub(tg, "remove", cmd_trigger_remove, "remove a trigger by index")
    p.add_argument("automation")
    p.add_argument("index")

    mg = _sub(ag, "memory", None, "per-automation memory").add_subparsers(
        dest="verb2", required=True)
    p = _sub(mg, "clear", cmd_memory_clear, "clear the memory (snapshots first)")
    p.add_argument("automation")

    sg = _sub(ag, "snapshot", None, "memory snapshots").add_subparsers(dest="verb2", required=True)
    p = _sub(sg, "list", cmd_snapshot_list, "list memory snapshots", json_flag=True)
    p.add_argument("automation")
    p = _sub(sg, "create", cmd_snapshot_create, "snapshot the memory now")
    p.add_argument("automation")
    p.add_argument("--name", help="snapshot label")
    p = _sub(sg, "restore", cmd_snapshot_restore, "restore a snapshot by id prefix")
    p.add_argument("automation")
    p.add_argument("snapshot")
    p = _sub(sg, "delete", cmd_snapshot_delete, "delete a snapshot by id prefix")
    p.add_argument("automation")
    p.add_argument("snapshot")

    # ---- execution
    eg = _sub(top, "execution", None, "inspect and control executions").add_subparsers(
        dest="verb", required=True)
    p = _sub(eg, "list", cmd_execution_list, "recent executions", json_flag=True)
    p.add_argument("-n", type=int, default=20)
    p.add_argument("--automation", help="only this automation's executions")
    p.add_argument("--status", help="only this status (§4.6 vocabulary)")
    p = _sub(eg, "show", cmd_execution_show, "steps, error, and result of one execution",
             json_flag=True)
    p.add_argument("execution", nargs="?", help="execution id prefix (default: latest)")
    p = _sub(eg, "tail", cmd_execution_tail, "stream an execution's logs")
    p.add_argument("execution", nargs="?", help="execution id prefix (default: latest)")
    p = _sub(eg, "cancel", cmd_execution_cancel, "cancel a live execution")
    p.add_argument("execution", nargs="?")
    p = _sub(eg, "retry", cmd_execution_retry, "retry a failed execution in place")
    p.add_argument("execution", nargs="?")
    p.add_argument("-f", "--follow", action="store_true", help="stream logs until it finishes")
    p = _sub(eg, "skip", cmd_execution_skip, "skip the currently executing step")
    p.add_argument("execution", nargs="?")
    p = _sub(eg, "result", cmd_execution_result,
             "list result files, or print one to stdout")
    p.add_argument("execution", nargs="?", help="execution id prefix (default: latest)")
    p.add_argument("name", nargs="?", help="result file to print")

    # ---- secret / agent / settings / service
    scg = _sub(top, "secret", None, "manage secrets").add_subparsers(dest="verb", required=True)
    _sub(scg, "list", cmd_secret_list, "list secrets", json_flag=True)
    p = _sub(scg, "set", cmd_secret_set, "store a secret in your Keychain")
    p.add_argument("name")
    p.add_argument("--stdin", action="store_true",
                   help="read the value from stdin instead of prompting")
    p = _sub(scg, "delete", cmd_secret_delete, "remove a secret")
    p.add_argument("name")

    agg = _sub(top, "agent", None, "configured AI agents").add_subparsers(
        dest="verb", required=True)
    _sub(agg, "list", cmd_agent_list, "list agents", json_flag=True)
    p = _sub(agg, "check", cmd_agent_check, "readiness check, by agent name")
    p.add_argument("agent")

    stg = _sub(top, "settings", None, "app settings").add_subparsers(dest="verb", required=True)
    _sub(stg, "show", cmd_settings_show, "current settings", json_flag=True)
    p = _sub(stg, "set", cmd_settings_set, "change settings")
    p.add_argument("values", nargs="+", metavar="KEY=VALUE")

    _add_service(top)
    return ap


def main() -> None:
    args = build_parser().parse_args()
    c = Client() if args.client else None
    args.fn(c, args)


if __name__ == "__main__":
    main()
