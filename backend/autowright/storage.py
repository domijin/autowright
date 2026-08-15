"""Storage (§5): YAML/markdown files everywhere; SQLite only as an index.

All derived state lives in memory (`Store`) and is rebuilt from disk at every
startup. Every write goes disk-first (atomic file / DB transaction), then
memory updates. Each execution's full record is `executions/<uuid>/execution.yaml`
(steps with attempts, params, error, notes); per-step-attempt logs live under
`executions/<uuid>/logs/`; `executions.db` (execdb.py) holds only the header
rows the list surfaces need.
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import stat
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from . import paths, timefmt, triggers as triggerlib
from .execdb import ExecDB
from .specmd import blocks_to_md, md_to_blocks
from .yamlio import atomic_write_text, load_yaml, save_yaml

SECRET_REF_RE = re.compile(r"\bsecrets\.([A-Z][A-Z0-9_]*)")

log = logging.getLogger("autowright.storage")

# §4.5 trigger display labels — derived at serialization, never stored. The
# stored value is always the machine kind on the left.
TRIGGER_LABELS = {
    "manual": "Manual", "menubar": "Menu bar", "cron": "Cron", "time": "Once",
    "app_start": "App start", "discord": "Discord", "imessage": "iMessage",
    "test": "Test", "pubsub": "Pub/Sub",
}


def trigger_label(kind: str | None) -> str:
    return TRIGGER_LABELS.get(kind or "", kind or "")


def exec_ver_label(h: dict) -> str:
    """§4.5 derived display label for the stored (kind, version) pair."""
    kind = h.get("kind")
    if kind == "draft":
        return "Draft"
    if kind == "test":
        return "Test"
    return f"v{h.get('version')}"


def is_test(h: dict) -> bool:
    """§4.5: test executions are kind `test` — there is no stored flag."""
    return h.get("kind") == "test"

# §6 concurrency settings (§4.1). One run at a time and skip-on-busy are the
# defaults — parallel runs and queueing are opt-in per automation (§9.2 card,
# or staged through the §8 `concurrency` chat action).
DEFAULT_MAX_PARALLEL = 1
DEFAULT_MAX_QUEUED = 0


def clamp_max_parallel(v: Any) -> int:
    """§4.1 `maxParallel` — int ≥ 1. Anything unusable falls back to the default
    rather than raising: this also runs on hand-edited automation.yaml at load,
    where a bad value must not cost the user their automation."""
    try:
        return max(1, int(v))
    except (TypeError, ValueError):
        return DEFAULT_MAX_PARALLEL


def clamp_max_queued(v: Any) -> int:
    """§4.1 `maxQueued` — int ≥ 0 (0 restores skip-on-busy)."""
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return DEFAULT_MAX_QUEUED


DEFAULT_SETTINGS: dict[str, Any] = {
    "login": True,
    "menuBarIcon": True,
    "keepAwake": True,  # §4.9: permanent idle-sleep assertion while on (§3, awake.py)
    "automaticUpdateCheck": True,  # §4.9: on by default — consumed by the Electron shell (§3)
    "notifications": "attention",
    "days": 90,
    "keepForever": False,
    "dataPath": None,  # None → paths.default_data_path()
    "developerMode": False,  # §4.9: request logging on/off, read live by the log filter
}


def new_id() -> str:
    return str(uuid.uuid4())


def safe_step_filename(fname, i: int, name, taken: set[str]) -> str:
    """Step `file` names can arrive in client payloads (trust boundary):
    anything that isn't a plain step-script name (path separators, dotfiles,
    reserved names, non-.py) or that collides with an earlier step's file
    falls back to the generated `NN-slug.py` name — a collision would
    silently overwrite the earlier step's script; a path-y value would
    escape the folder. Shared by version writes and §11 test executions."""
    if fname and re.fullmatch(r"[a-z0-9][a-z0-9-]*\.py", str(fname)) and str(fname) not in taken:
        return str(fname)
    slug = re.sub(r"[^a-z0-9]+", "-", str(name or "step").lower()).strip("-") or "step"
    out = f"{i:02d}-{slug}.py"
    n = 2
    while out in taken:
        out = f"{i:02d}-{slug}-{n}.py"
        n += 1
    return out


def iter_file_stats(d: Path):
    """stat results of the regular files under `d`, recursively. Retention
    sweeps, deletes, and memory clears run concurrently with these walks —
    an entry vanishing between listing and stat() is skipped, not raised."""
    if not d.exists():
        return
    for f in d.rglob("*"):
        try:
            st = f.stat()
        except OSError:
            continue
        if stat.S_ISREG(st.st_mode):
            yield st


def size_label(n: int) -> str:
    """One humanized byte label for every surface (§4.1, §4.9)."""
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024 / 1024 / 1024:.1f} GB"


def _kind_ok(kind: str | None, v: Any) -> bool:
    return (
        (kind == "toggle" and isinstance(v, bool))
        or (kind == "number" and isinstance(v, (int, float)) and not isinstance(v, bool))
        or (kind == "list" and isinstance(v, list) and all(isinstance(x, str) for x in v))
        or (kind == "kv" and isinstance(v, list) and all(isinstance(x, dict) for x in v))
        or (kind == "text" and isinstance(v, str))
    )


def param_default(d: dict) -> Any:
    kind = d.get("kind")
    # A declared default that doesn't match its own kind (agent output is only
    # presence-validated) falls through to the kind default — a string default
    # on a `list` param must not explode into characters downstream.
    if "default" in d and d["default"] is not None and _kind_ok(kind, d["default"]):
        return d["default"]
    if kind == "toggle":
        return False
    if kind == "number":
        return d.get("min", 0)
    if kind == "list":
        return []
    if kind == "kv":
        return []
    return ""


def resolve_param_value(d: dict, values: dict, warn: list[str] | None = None) -> Any:
    """§5 matching rules: by name and kind; kind mismatch → default + warning."""
    name = d["name"]
    if name in values:
        v = values[name]
        kind = d.get("kind")
        if _kind_ok(kind, v):
            return v
        if warn is not None:
            warn.append(f'parameter "{name}": stored value doesn\'t match kind {kind} — using the default')
        return param_default(d)
    return param_default(d)


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.autos: dict[str, dict] = {}          # id → automation (internal shape)
        self.execs: dict[str, dict] = {}          # id → execution header
        self.execdb: ExecDB | None = None
        self.agents: list[dict] = []
        # §4.7: THE app-default agent — a single id pointer (persisted as
        # `default_agent` in agents.yaml), never a per-record flag.
        self.default_agent_id: str | None = None
        self.settings: dict = dict(DEFAULT_SETTINGS)
        # §4.3 `connection`: token-secret name → {state, error?}, owned by the §6
        # listener manager (listeners.py pushes updates; trigger_json reads).
        self.listener_status: dict[str, dict] = {}
        self.secrets: list[dict] = []             # {name, description, set} — values live in the Keychain;
                                                  # set: False = §4.8 placeholder, no Keychain entry
        # §5 log line cap: (execution_id, file name) → lines written so far,
        # seeded from disk on first append (see append_log_line).
        self._log_counts: dict[tuple[str, str], int] = {}

    # ---------- paths ----------
    def data_path(self) -> Path:
        p = self.settings.get("dataPath")
        return Path(p).expanduser() if p else paths.default_data_path()

    def executions_dir(self) -> Path:
        d = self.data_path()
        return d if d.name == "executions" else d / "executions"

    def auto_dir(self, a: dict) -> Path:
        return paths.automations_dir() / a["id"]

    def exec_dir(self, execution_id: str) -> Path:
        return self.executions_dir() / execution_id

    # ---------- startup walk (§5 load model) ----------
    def load_all(self) -> None:
        with self.lock:
            paths.ensure_dirs()
            self.settings = {**DEFAULT_SETTINGS, **self._load_toplevel_mapping(paths.settings_file())}
            self.agents = self._load_toplevel_list(paths.agents_file(), "agents")
            # §4.7 default pointer — a dangling/absent value (hand-edited file)
            # falls back to the first agent so the invariant self-heals at load.
            default = self._load_toplevel_mapping(paths.agents_file()).get("default_agent")
            self.default_agent_id = (default if any(a.get("id") == default for a in self.agents)
                                     else (self.agents[0]["id"] if self.agents else None))
            self.secrets = [{"name": s["name"], "description": s.get("description") or "",
                             "set": bool(s.get("set", True))}
                            for s in self._load_toplevel_list(paths.secrets_file(), "secrets")
                            if s.get("name")]
            self.autos = {}
            for d in sorted(paths.automations_dir().iterdir()) if paths.automations_dir().exists() else []:
                if not d.is_dir() or not (d / "automation.yaml").exists():
                    continue
                try:
                    a = self._load_automation(d)
                except Exception as e:  # noqa: BLE001
                    # §5: hand-edited disk (bad encodings, permissions, weird
                    # values) never bricks startup — skip just this automation.
                    log.warning("failed to load automation at %s (%s) — skipping it at load", d, e)
                    continue
                if a:
                    self.autos[a["id"]] = a
            self.close_exec_db()
            self.execdb, self.execs = self._open_exec_index()
            self._reconcile_exec_index()
            self._refresh_exec_derived()

    @staticmethod
    def _load_toplevel_mapping(path: Path) -> dict:
        """§5: every top-level YAML is hand-editable — a readable file whose
        root isn't a mapping loads as its default with a warning, and
        null-valued keys fall back to their defaults."""
        raw = load_yaml(path, {}) or {}
        if not isinstance(raw, dict):
            log.warning("%s doesn't hold a mapping — using the defaults", path)
            return {}
        return {k: v for k, v in raw.items() if v is not None}

    def _load_toplevel_list(self, path: Path, key: str) -> list[dict]:
        raw = self._load_toplevel_mapping(path).get(key, [])
        if not isinstance(raw, list):
            log.warning("%s: %r isn't a list — using the default", path, key)
            return []
        return [x for x in raw if isinstance(x, dict)]

    def _open_exec_index(self) -> tuple[ExecDB, dict[str, dict]]:
        """§5: the DB is a disposable index. A corrupt file is deleted and
        rebuilt (the yaml reconcile restores every row); an unreachable
        executions dir (data path on a disconnected volume) degrades to an
        in-memory index for the session instead of bricking startup into a
        launchd crash loop."""
        path = self.executions_dir() / "executions.db"
        try:
            db = ExecDB(path)
            return db, db.load_all()
        except sqlite3.DatabaseError as e:
            log.warning("executions.db is unusable (%s) — deleting it; the yaml reconcile rebuilds the rows", e)
            try:
                for suffix in ("", "-wal", "-shm"):
                    (path.parent / (path.name + suffix)).unlink(missing_ok=True)
                db = ExecDB(path)
                return db, db.load_all()
            except (sqlite3.Error, OSError) as e2:
                log.warning("rebuilding executions.db failed (%s) — using an in-memory index this session", e2)
        except OSError as e:
            log.warning("executions dir is unavailable (%s) — using an in-memory index this session", e)
        return ExecDB(None), {}

    def _reconcile_exec_index(self) -> None:
        """§5: `execution.yaml` is authoritative; the DB is only an index. An
        execution directory the index doesn't know (crash between the yaml write
        and the DB upsert, or a schema wipe) is restored from its yaml here, so
        startup truly rebuilds everything from disk."""
        d = self.executions_dir()
        if not d.exists():
            return
        for ed in d.iterdir():
            if not ed.is_dir() or ed.name in self.execs:
                continue
            try:
                y = self.read_exec_yaml(ed.name)
                if not y or y.get("id") != ed.name or not y.get("started_at"):
                    continue
                # Timestamps must parse the way the serializers will parse them
                # later — an unparsable value upserted here would 500 the whole
                # executions list (and, via _latest_exec, the automations list)
                # on every request until the row is removed by hand.
                timefmt.parse_local(str(y["started_at"]))
                for k in ("queued_at", "finished_at"):
                    if y.get(k):
                        timefmt.parse_local(str(y[k]))
                h = self.exec_header(y)
                self.execdb.upsert(h)
            except Exception as e:  # noqa: BLE001
                # §5: a hand-damaged execution.yaml (bad timestamps, missing
                # fields, wrong shapes) never bricks startup — the record just
                # stays out of the index.
                log.warning("execution %s has an unusable execution.yaml (%s) — leaving it out of the index",
                            ed.name, e)
                continue
            self.execs[h["id"]] = h
            log.warning("execution %s was missing from the index — restored from its execution.yaml", h["id"])
        # The reverse repair: a directory deleted by hand (Finder is one click
        # away via "Show in Finder") leaves a ghost index row that would list
        # forever — the yaml is authoritative, so the row goes.
        for eid in [e for e in self.execs if not (d / e).is_dir()]:
            self.execdb.delete(eid)
            del self.execs[eid]
            log.warning("execution %s has no directory on disk — dropping its index row", eid)

    def close_exec_db(self) -> None:
        with self.lock:
            if self.execdb:
                self.execdb.close()
                self.execdb = None

    def _load_automation(self, d: Path) -> dict | None:
        top = load_yaml(d / "automation.yaml")
        if not top or "id" not in top:
            return None
        if d.name != top["id"]:
            # §5: directory name IS the id — a mismatch means hand-edited disk.
            log.warning("automation dir %s doesn't match its id %r — skipping it at load", d, top["id"])
            return None
        a: dict = {
            "id": top["id"],
            "name": top.get("name", d.name),
            "description": top.get("description", ""),
            "current_version": int(top.get("current_version", 1)),
            "triggers": self._load_triggers(top.get("triggers", []) or []),
            "agent_id": top.get("agent_id"),
            "enabled_agents": top.get("enabled_agents", []) or [],
            "allowed_secrets": top.get("allowed_secrets", []) or [],
            "memory_snapshots": self._load_snapshot_settings(top.get("memory_snapshots")),
            "param_values": top.get("param_values", {}) or {},
            # §6 concurrency settings — absent keys default to one at a time
            # and skip-on-busy; a hand-edited out-of-range value is clamped
            # rather than dropping the automation at load.
            "max_parallel": clamp_max_parallel(top.get("max_parallel")),
            "max_queued": clamp_max_queued(top.get("max_queued")),
            "created_at": top.get("created_at"),
            "updated_at": top.get("updated_at"),
            "versions": {},
            "draft": None,
        }
        vdir = d / "versions"
        if vdir.exists():
            for vd in vdir.iterdir():
                m = re.fullmatch(r"v(\d+)", vd.name)
                if m and (vd / "automation.yaml").exists():
                    a["versions"][int(m.group(1))] = self._load_version_folder(vd)
        self._recover_draft_swap(d / "draft")  # §5: repair a half-finished save_draft swap
        if (d / "draft" / "automation" / "automation.yaml").exists():
            a["draft"] = self._load_version_folder(d / "draft" / "automation")
        if not a["versions"]:
            log.warning("automation %r at %s has no version folders — skipping it at load", a["name"], d)
            return None
        return a

    @staticmethod
    def _load_snapshot_settings(raw: dict | None) -> dict:
        """§6.3 automatic-snapshot toggles from automation.yaml — absent keys default on."""
        raw = raw or {}
        return {k: bool(raw.get(k, True)) for k in ("pre_version", "pre_clear", "pre_restore")}

    @staticmethod
    def _load_triggers(raw: list) -> list[dict]:
        """§4.3 stored shape from automation.yaml; malformed entries are dropped
        with a warning (disk is hand-editable)."""
        def _valid(t: dict) -> bool:
            # Hand-edited disk must never brick startup (§5) — a validator
            # crash on weird trigger data counts as invalid, not fatal.
            try:
                return triggerlib.validate_trigger(t) is None
            except Exception:  # noqa: BLE001
                return False

        out = []
        for t in raw:
            if (isinstance(t, dict) and t.get("kind") == "app_start"
                    and any(x["kind"] == "app_start" for x in out)):
                log.warning("dropping duplicate app-start trigger %r", t)  # §4.3: at most one
            elif isinstance(t, dict) and _valid(t):
                out.append({"id": t.get("id") or new_id(), "kind": t["kind"],
                            "enabled": bool(t.get("enabled", True)),
                            **({"expression": t["expression"],
                                **({"source": t["source"]} if t.get("source") in ("spec", "user") else {})}
                               if t["kind"] == "cron" else
                               {"at": t["at"]} if t["kind"] == "time" else
                               {"channel": t["channel"], "secret": t["secret"],
                                **({"pattern": t["pattern"]} if t.get("pattern") else {}),
                                **({"mention": True} if t.get("mention") else {}),
                                **({"author": triggerlib.normalize_authors(t["author"])}
                                   if t.get("author") else {})}
                               if t["kind"] == "discord" else
                               {"from": t["from"],
                                **({"pattern": t["pattern"]} if t.get("pattern") else {})}
                               if t["kind"] == "imessage" else {}),
                            **({"timezone": t["timezone"]} if t.get("timezone") and t["kind"] in ("cron", "time") else {})})
            elif isinstance(t, dict) and t.get("kind") == "time":
                # A past one-shot found on disk was missed while the backend was
                # down — consumed (§4.3), never loaded.
                continue
            else:
                log.warning("dropping malformed trigger %r", t)
        return out

    def _load_version_folder(self, vd: Path) -> dict:
        meta = load_yaml(vd / "automation.yaml", {}) or {}
        steps = []
        for s in meta.get("steps", []) or []:
            code = ""
            f = vd / (s.get("file") or "")
            # is_file(): a missing/empty `file` key resolves to the version dir
            # itself — read_text on it would crash startup (§5: hand-edited
            # disk never bricks the load).
            if s.get("file") and f.is_file():
                code = f.read_text(encoding="utf-8")
            steps.append({**s, "code": code})
        instructions = None
        if (vd / "instructions.md").exists():
            instructions = (vd / "instructions.md").read_text(encoding="utf-8").strip()
        notes = ""
        if (vd / "notes.md").exists():
            notes = (vd / "notes.md").read_text(encoding="utf-8").strip()
        spec_md = (vd / "spec.md").read_text(encoding="utf-8") if (vd / "spec.md").exists() else ""
        return {
            "when": meta.get("when"),
            "note": meta.get("note"),
            "params": meta.get("params", []) or [],
            "packages": meta.get("packages", []) or [],
            "steps": steps,
            "spec": md_to_blocks(spec_md),
            "instructions": instructions,
            "notes": notes,
            "step_agents": meta.get("step_agents"),
            "allowed_secrets": meta.get("allowed_secrets"),
            "triggers": meta.get("triggers"),
            "param_values": meta.get("param_values"),
            "concurrency": meta.get("concurrency"),
            "test_values": meta.get("test_values"),
            "out_of_sync": bool(meta.get("out_of_sync")) or None,
        }

    def _refresh_exec_derived(self) -> None:
        """Fill last_status / last_exec_at / live / latest-header per automation
        (§5 load model); the result chip rides on the execution header itself.
        `_latest` is kept current by create/update_execution so serialization
        never re-scans all executions per automation."""
        live: dict[str, set[str]] = {}
        for h in self.execs.values():
            # §4.1 `live` is every in-progress execution, not just the newest —
            # maxParallel may allow several, and the startup sweep needs them all.
            if h["status"] == "executing" and not is_test(h):
                live.setdefault(h["automation_id"], set()).add(h["id"])
        for a in self.autos.values():
            latest = self._latest_exec(a["id"])
            a["_latest"] = latest
            a["_last_status"] = latest["status"] if latest else "none"
            a["_last_exec_at"] = latest["started_at"] if latest else None
            a["_live"] = live.get(a["id"], set())

    @staticmethod
    def never_ran(h: dict) -> bool:
        """§4.1: a record that never reached `executing` must not shadow the real
        latest execution's status/chip. `skipped` already carries exactly that
        meaning, which is why a §6 queue entry cancelled before its turn finishes
        `skipped` (with a note saying so) rather than `cancelled` — status alone
        then decides this, and it keeps deciding correctly for a header row read
        back from the index, which carries no steps to inspect."""
        return h["status"] in ("skipped", "queued")

    def _latest_exec(self, automation_id: str) -> dict | None:
        # Test records (§4.5) are draft-scoped and never count either.
        hs = [h for h in self.execs.values()
              if h["automation_id"] == automation_id and not self.never_ran(h) and not is_test(h)]
        return max(hs, key=lambda h: h["started_at"] or "") if hs else None

    def queued_execs(self, automation_id: str) -> list[dict]:
        """§6 firing queue, oldest first — the queue *is* the automation's
        `queued` records, so there is no second structure to keep in sync."""
        q = [h for h in self.execs.values()
             if h["automation_id"] == automation_id and h["status"] == "queued"]
        q.sort(key=lambda h: h.get("queued_at") or h["started_at"] or "")
        return q

    # ---------- automation writes ----------
    def _write_toplevel(self, a: dict) -> None:
        save_yaml(self.auto_dir(a) / "automation.yaml", {
            "id": a["id"],
            "name": a["name"],
            "description": a.get("description", ""),
            "current_version": a["current_version"],
            "triggers": a["triggers"],
            "agent_id": a["agent_id"],
            "enabled_agents": a["enabled_agents"],
            "allowed_secrets": a["allowed_secrets"],
            "memory_snapshots": a["memory_snapshots"],
            "param_values": a["param_values"],
            "max_parallel": a["max_parallel"],
            "max_queued": a["max_queued"],
            "created_at": a["created_at"],
            "updated_at": a["updated_at"],
        })

    def _write_version_folder(self, vd: Path, ver: dict, extra: dict | None = None) -> None:
        """`extra` merges additional keys into automation.yaml — used by the
        §4.4 pending create-mode slot for its identity fields.

        Crash-safe by write order (§5): step scripts and spec land first, the
        manifest (automation.yaml) last — it is the commit point (`_load_automation`
        ignores a folder without it), so a crash mid-write leaves either the old
        consistent folder or an ignorable partial, never a half-adopted version.
        Stale files from a previous draft save are pruned only after the new
        manifest is in place."""
        vd.mkdir(parents=True, exist_ok=True)
        keep = {"automation.yaml", "spec.md", "instructions.md", "notes.md"}
        manifest_steps = []
        for i, s in enumerate(ver["steps"], 1):
            fname = safe_step_filename(s.get("file"), i, s.get("name"), keep)
            entry: dict[str, Any] = {"file": fname, "name": s["name"], "description": s.get("description", "")}
            if s.get("agent"):
                entry["agent"] = True
                entry["why"] = s.get("why", "")
                if s.get("agents"):
                    entry["agents"] = list(s["agents"])
            if s.get("secrets"):
                entry["secrets"] = list(s["secrets"])
            if s.get("packages"):
                entry["packages"] = list(s["packages"])
            # §4.1 per-step time limit + §7 retry pair. The internal shape is
            # snake_case only — the API boundary normalizes the camelCase
            # client spelling before anything reaches storage.
            if s.get("timeout"):
                entry["timeout"] = int(s["timeout"])
            if s.get("no_timeout"):
                entry["no_timeout"] = True
            if s.get("retries"):
                entry["retries"] = int(s["retries"])
            if s.get("infinite_retries"):
                entry["infinite_retries"] = True
            manifest_steps.append(entry)
            keep.add(fname)
            atomic_write_text(vd / fname, s.get("code", ""))
        atomic_write_text(vd / "spec.md", blocks_to_md(ver.get("spec", [])))
        if ver.get("instructions"):
            atomic_write_text(vd / "instructions.md", ver["instructions"].strip() + "\n")
        elif (vd / "instructions.md").exists():
            (vd / "instructions.md").unlink()
        # §4.1 notes — the agent-owned working-knowledge doc; absent when empty
        if (ver.get("notes") or "").strip():
            atomic_write_text(vd / "notes.md", ver["notes"].strip() + "\n")
        elif (vd / "notes.md").exists():
            (vd / "notes.md").unlink()
        # §6.2: statuses are transient (draft payload / API only) — the stored
        # manifest keeps just the declaration; absent when none are declared.
        pkgs = [{"pip": p.get("pip"), "import": p.get("import"),
                 **({"why": p["why"]} if p.get("why") else {})}
                for p in ver.get("packages", []) or []]
        save_yaml(vd / "automation.yaml", {
            "when": ver.get("when"),
            "note": ver.get("note"),
            "params": ver.get("params", []),
            **({"packages": pkgs} if pkgs else {}),
            # §4.4 draft-only grant selections + trigger list + §11 dirty-gate
            # state — never present for real versions
            **({"step_agents": ver["step_agents"]} if ver.get("step_agents") is not None else {}),
            **({"allowed_secrets": ver["allowed_secrets"]} if ver.get("allowed_secrets") is not None else {}),
            **({"triggers": ver["triggers"]} if ver.get("triggers") is not None else {}),
            **({"param_values": ver["param_values"]} if ver.get("param_values") is not None else {}),
            **({"concurrency": ver["concurrency"]} if ver.get("concurrency") is not None else {}),
            **({"test_values": ver["test_values"]} if ver.get("test_values") is not None else {}),
            **({"out_of_sync": True} if ver.get("out_of_sync") else {}),
            "steps": manifest_steps,
            **(extra or {}),
        })
        for f in vd.iterdir():
            if f.is_file() and f.name not in keep and not f.name.startswith(".ad-tmp-"):
                f.unlink()

    def create_automation(self, ver: dict, name: str, agent_id: str | None,
                          triggers: list[dict] | None = None,
                          enabled_agents: list[str] | None = None,
                          allowed_secrets: list[str] | None = None) -> dict:
        with self.lock:
            automation_id = new_id()
            now = timefmt.now_iso()
            a = {
                # §4.1: the create manifest seeds desc; user-owned from here on
                "id": automation_id, "name": name, "description": ver.get("description", ""), "current_version": 1,
                "triggers": triggers or [],
                "agent_id": agent_id,
                # §4.1: an explicit empty list is a real choice ("no step
                # agents") — only a missing field falls back to the drafter.
                "enabled_agents": (list(enabled_agents) if enabled_agents is not None
                                   else ([agent_id] if agent_id else [])),
                "allowed_secrets": allowed_secrets or [],
                "memory_snapshots": {"pre_version": True, "pre_clear": True, "pre_restore": True},
                "param_values": {}, "created_at": now, "updated_at": now,
                "max_parallel": DEFAULT_MAX_PARALLEL, "max_queued": DEFAULT_MAX_QUEUED,
                "versions": {}, "draft": None,
                # §4.1 `live` is a set: maxParallel may allow several at once.
                "_last_status": "none", "_last_exec_at": None, "_live": set(),
            }
            ver = {**ver, "when": now, "note": ver.get("note") or "Created"}
            self._write_version_folder(self.auto_dir(a) / "versions" / "v1", ver)
            (self.auto_dir(a) / "memory").mkdir(parents=True, exist_ok=True)
            a["versions"][1] = self._load_version_folder(self.auto_dir(a) / "versions" / "v1")
            self._write_toplevel(a)
            self.autos[automation_id] = a
            return a

    def save_new_version(self, a: dict, ver: dict) -> int:
        """§4.4/§5: write vN+1 folder, then flip the pointer atomically."""
        with self.lock:
            n = a["current_version"] + 1
            while n in a["versions"]:
                n += 1
            ver = {**ver, "when": timefmt.now_iso()}
            vd = self.auto_dir(a) / "versions" / f"v{n}"
            self._write_version_folder(vd, ver)
            a["versions"][n] = self._load_version_folder(vd)
            a["current_version"] = n
            a["updated_at"] = timefmt.now_iso()
            self._write_toplevel(a)
            return n

    def restore_version(self, a: dict, v: int) -> int:
        with self.lock:
            n = a["current_version"] + 1
            while n in a["versions"]:
                n += 1
            dst = self.auto_dir(a) / "versions" / f"v{n}"
            # §5: restore writes through the version-folder writer from vX's
            # loaded content — never a tree copy — so the manifest lands last
            # as the commit point and a crash mid-restore leaves no adoptable
            # folder, just an incomplete directory the next save overwrites.
            self._write_version_folder(dst, {**a["versions"][v],
                                             "when": timefmt.now_iso(),
                                             "note": f"Restored from v{v}"})
            a["versions"][n] = self._load_version_folder(dst)
            a["current_version"] = n
            a["updated_at"] = timefmt.now_iso()
            self._write_toplevel(a)
            return n

    def draft_dir(self, a: dict | None) -> Path:
        """§5/§19: the one draft-container location rule — the pending
        create-mode slot (`<root>/draft/`, owner `pending`) or the
        automation's `draft/`; everything else about the container is shared."""
        return paths.pending_draft_dir() if a is None else self.auto_dir(a) / "draft"

    @staticmethod
    def _recover_draft_swap(container: Path) -> None:
        """§5 crash recovery for the save_draft staged swap: a previous save
        died between the two renames — the aside dir is the sole complete
        copy, put it back. Leftover temps from any other crash point are
        stale and go."""
        dd = container / "automation"
        old = container / ".ad-old-automation"
        new = container / ".ad-new-automation"
        if not dd.exists() and old.exists():
            old.rename(dd)
        for stale in (old, new):
            if stale.exists():
                shutil.rmtree(stale, ignore_errors=True)

    def save_draft(self, a: dict | None, ver: dict, *, name: str | None = None,
                   agent_id: str | None = None, triggers: list | None = None,
                   chat: list | None = None) -> None:
        """§19: ONE write path for both /draft/{owner} owners (a=None →
        pending). §5: draft/ is a container — only the automation/ working
        copy is replaced; memory/ (§4.4) survives re-saves from the editor.
        The working copy is written whole beside the container and swapped in
        by rename (§5 staged-dir swap) — a crash at any point leaves the old
        or the new copy complete, never a mix of the two.
        For the pending owner the identity keyword args land as create-only
        keys in automation.yaml (§5) — no automation record exists to hold
        them; they are ignored for an automation owner."""
        with self.lock:
            container = self.draft_dir(a)
            self._recover_draft_swap(container)
            dd = container / "automation"
            new = container / ".ad-new-automation"
            old = container / ".ad-old-automation"
            if a is None:
                prev = load_yaml(dd / "automation.yaml", {}) or {}
                now = timefmt.now_iso()
                self._write_version_folder(new, ver, extra={
                    "name": name, "description": ver.get("description", ""), "agent_id": agent_id,
                    "triggers": triggers or [],
                    "created_at": prev.get("created_at") or now, "updated_at": now,
                })
            else:
                self._write_version_folder(new, ver)
            if dd.exists():
                dd.rename(old)
            new.rename(dd)
            shutil.rmtree(old, ignore_errors=True)
            if a is not None:
                a["draft"] = self._load_version_folder(dd)
            self.save_chat(container, chat)

    # ---------- §11 chat thread (§5 chat.jsonl in the draft container) ----------
    _CHAT_KEYS = ("id", "kind", "text", "title", "blockers", "source", "diagnosed",
                  "dismissed", "resolved", "at")

    def save_chat(self, container: Path, chat: list | None) -> None:
        """§4.4/§5: the thread rides the draft payload as `chat` and lands as
        the container's chat.jsonl, rewritten whole on every draft save. None
        leaves the file untouched (a caller that didn't send the key); an
        empty list deletes it."""
        if chat is None:
            return
        f = container / "chat.jsonl"
        entries = [{k: e[k] for k in self._CHAT_KEYS if k in e}
                   for e in chat if isinstance(e, dict) and e.get("kind")]
        if not entries:
            f.unlink(missing_ok=True)
            return
        container.mkdir(parents=True, exist_ok=True)
        atomic_write_text(f, "".join(json.dumps(e, ensure_ascii=False) + "\n"
                                     for e in entries))

    @staticmethod
    def chat_json(container: Path) -> list[dict]:
        """The container's §11 thread; [] when none. A malformed line is
        skipped, never fatal — the file is hand-editable like everything else."""
        f = container / "chat.jsonl"
        try:
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return []
        out = []
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(e, dict) and e.get("kind"):
                out.append(e)
        return out

    # ---------- pending create-mode draft (§4.4: the <root>/draft/ slot) ----------
    def open_draft(self, a: dict | None) -> None:
        """§4.4/§19 POST /draft/{owner}/open: make the container (draft/ with
        an empty memory/ — §11 tests execute as execution records) exist —
        the create flow calls it on open, before any drafting; never touches
        contents already there."""
        with self.lock:
            (self.draft_dir(a) / "memory").mkdir(parents=True, exist_ok=True)

    def load_pending_draft(self) -> dict | None:
        """The slot's draft + identity keys; None when the slot is empty."""
        with self.lock:
            self._recover_draft_swap(paths.pending_draft_dir())  # §5 swap repair
            dd = paths.pending_draft_dir() / "automation"
            if not (dd / "automation.yaml").exists():
                return None
            meta = load_yaml(dd / "automation.yaml", {}) or {}
            return {**self._load_version_folder(dd),
                    "name": meta.get("name"), "description": meta.get("description", ""),
                    "agent_id": meta.get("agent_id"),
                    "triggers": meta.get("triggers", []) or []}

    def delete_draft(self, a: dict | None) -> None:
        """§19: ONE delete path for both /draft/{owner} owners. Settles the
        container (discard, save, Create, or Start over); §11 test records die
        with it (automationId null for the pending owner)."""
        with self.lock:
            shutil.rmtree(self.draft_dir(a), ignore_errors=True)
            if a is not None:
                a["draft"] = None
            self.delete_test_execs(a["id"] if a is not None else None)

    def pending_draft_summary(self) -> dict | None:
        """§19 GET /state `pendingDraft`: the slot's identity summary — backs
        the §9.1 Resume draft button; None when the slot holds no draft."""
        with self.lock:
            dd = paths.pending_draft_dir() / "automation"
            if not (dd / "automation.yaml").exists():
                return None
            meta = load_yaml(dd / "automation.yaml", {}) or {}
            return {"name": meta.get("name") or "New automation",
                    "updatedAt": meta.get("updated_at")}

    def draft_container_json(self, a: dict | None) -> dict:
        """§19 GET /draft/{owner} → `{ draft, agentId }` — the same envelope
        for both owners; the pending owner's agentId rides the slot's identity
        keys (§5), an automation owner's rides its record."""
        with self.lock:
            if a is None:
                meta = load_yaml(paths.pending_draft_dir() / "automation" / "automation.yaml", {}) or {}
                agent_id = meta.get("agent_id")
            else:
                agent_id = a.get("agent_id")
            return {"draft": self.draft_json(a), "agentId": agent_id}

    def patch_automation(self, a: dict, patch: dict) -> None:
        """User-owned fields only (§19 PATCH)."""
        with self.lock:
            if "name" in patch and patch["name"] and patch["name"] != a["name"]:
                # §5: directories are named by id — a rename touches only the name field.
                a["name"] = patch["name"]
            if "description" in patch:
                # §4.1: desc is optional — blank clears it.
                a["description"] = patch["description"] or ""
            for k_api, k_int in [("agentId", "agent_id"),
                                 ("stepAgents", "enabled_agents"), ("allowedSecrets", "allowed_secrets")]:
                if k_api in patch:
                    a[k_int] = patch[k_api]
            if "triggers" in patch:
                # Whole-list replace (§19) — the API validated + normalized it.
                a["triggers"] = patch["triggers"]
            if "paramValues" in patch:
                a["param_values"].update(patch["paramValues"])
            for k_api, k_int, clamp in [("maxParallel", "max_parallel", clamp_max_parallel),
                                        ("maxQueued", "max_queued", clamp_max_queued)]:
                if k_api in patch:
                    # §19 validated the range already; clamp is the last line of
                    # defense for any other caller.
                    a[k_int] = clamp(patch[k_api])
            if "snapshotSettings" in patch:
                # §6.3 toggles — partial object, sent keys merged over the stored ones.
                sent = patch["snapshotSettings"] or {}
                for k_api, k_int in [("preVersion", "pre_version"), ("preClear", "pre_clear"),
                                     ("preRestore", "pre_restore")]:
                    if k_api in sent:
                        a["memory_snapshots"][k_int] = bool(sent[k_api])
            a["updated_at"] = timefmt.now_iso()
            self._write_toplevel(a)

    def consume_trigger(self, a: dict, trigger_id: str) -> None:
        """§4.3 one-shot consumption: a fired or skipped `time` trigger leaves the list."""
        with self.lock:
            a["triggers"] = [t for t in a["triggers"] if t["id"] != trigger_id]
            self._write_toplevel(a)

    def trigger_json(self, t: dict) -> dict:
        label, short = triggerlib.trigger_display(t)
        out = {**t, "label": label, "short": short}
        if t["kind"] == "discord":
            # §4.3 `connection` — the listener manager's state for the trigger's
            # token secret; derived at serialization time, never stored.
            out["connection"] = self.listener_status.get(
                t["secret"], {"state": "connecting"})
        elif t["kind"] == "imessage":
            # §4.3: every imessage trigger shares the one §6 watcher's state.
            out["connection"] = self.listener_status.get(
                "imessage", {"state": "connecting"})
        return out

    def delete_automation(self, a: dict) -> None:
        with self.lock:
            shutil.rmtree(self.auto_dir(a), ignore_errors=True)
            self.autos.pop(a["id"], None)
            self.delete_test_execs(a["id"])  # §11 — real records stay (automationDeleted)

    # ---------- executions ----------
    # §5 header projection — the fields the DB index carries per execution and
    # the whole in-memory shape of any record that isn't live (startup-loaded
    # rows, records demoted on their terminal transition).
    EXEC_HEADER_KEYS = ("id", "automation_id", "automation_name", "kind", "version", "status",
                        "trigger", "trigger_sender", "queued_at", "started_at", "finished_at",
                        "duration_ms", "note", "chip", "chip_status", "error")

    @classmethod
    def exec_header(cls, h: dict) -> dict:
        return {k: h.get(k) for k in cls.EXEC_HEADER_KEYS}

    def create_execution(self, auto: dict, kind: str, version: int | None, trigger: str,
                         steps: list[dict], note: str | None = None,
                         status: str = "executing", params: list[dict] | None = None,
                         trigger_payload: dict | None = None) -> dict:
        """`kind`/`version` are the §4.5 stored pair (version | draft | test);
        `trigger` is the §4.5 machine kind — labels are derived at serialization."""
        with self.lock:
            now = timefmt.now_iso()
            h = {
                "id": new_id(), "automation_id": auto["id"], "automation_name": auto["name"],
                "kind": kind, "version": version, "status": status, "trigger": trigger,
                "trigger_payload": trigger_payload,
                # §4.5/§5: the header's triggerSender is stamped once, here at
                # record creation — every reader takes it from this field alone,
                # never by reaching into the payload.
                "trigger_sender": (trigger_payload or {}).get("sender"),
                # §4.5: set only for a §6 queue entry; kept after promotion so the
                # record still shows how long it waited.
                "queued_at": now if status == "queued" else None,
                "params": params or [],
                "started_at": now,
                "finished_at": None,
                "duration_ms": None, "note": note, "chip": None, "chip_status": None,
                "error": None, "redacted_secrets": [],
                "steps": [{"name": s["name"], "file": s.get("file"),
                           "agent": bool(s.get("agent")),
                           **({"sha": s["sha"]} if s.get("sha") else {}),
                           "status": s.get("status", "queued"),
                           "duration_ms": s.get("duration_ms"),
                           "attempts": s.get("attempts", [])} for s in steps],
            }
            d = self.exec_dir(h["id"])
            (d / "workspace").mkdir(parents=True, exist_ok=True)
            (d / "result").mkdir(parents=True, exist_ok=True)
            (d / "logs").mkdir(parents=True, exist_ok=True)
            self.write_exec_yaml(h)
            self.execdb.upsert(h)
            self.execs[h["id"]] = h
            # §4.5/§5: test executions never touch the automation's derived
            # display state or the §6 concurrency gate. A `queued` record doesn't
            # either — it hasn't run, so it must not claim a slot or shadow
            # lastStatus (§4.1); it counts only against maxQueued.
            if status == "executing" and kind != "test":
                auto["_live"].add(h["id"])
                auto["_latest"] = h
                auto["_last_status"] = "executing"
                auto["_last_exec_at"] = h["started_at"]
            return h

    def promote_execution(self, h: dict, steps: list[dict],
                          params: list[dict] | None = None) -> dict:
        """§6: a queued firing becomes the execution it was always going to be —
        same record, steps filled in, `queued` → `executing`. `started_at` is
        re-stamped so the duration measures execution rather than waiting;
        `queued_at` stays so the record still shows the wait."""
        with self.lock:
            h["status"] = "executing"
            h["started_at"] = timefmt.now_iso()
            h["params"] = params or []
            h["steps"] = [{"name": s["name"], "file": s.get("file"),
                           "agent": bool(s.get("agent")),
                           **({"sha": s["sha"]} if s.get("sha") else {}),
                           "status": s.get("status", "queued"),
                           "duration_ms": s.get("duration_ms"),
                           "attempts": s.get("attempts", [])} for s in steps]
            self.update_execution(h)  # writes yaml + db and re-derives live/latest
            return h

    def update_execution(self, h: dict) -> None:
        with self.lock:
            self.write_exec_yaml(h)
            self.execdb.upsert(h)
            if h["status"] not in ("executing", "queued") and h["id"] in self.execs:
                # §5 slim-on-finish: on a terminal transition the stored record
                # demotes to the header projection the DB index uses — the body
                # stays lazy behind the just-written execution.yaml, re-read on
                # the next open like any settled execution, so full bodies are
                # never pinned in memory for the backend's lifetime. Callers
                # keep their own full `h`; a retry re-inflates via exec_full.
                self.execs[h["id"]] = self.exec_header(h)
            if is_test(h):
                return  # §4.5: derived display state ignores test executions
            a = self.autos.get(h["automation_id"])
            if h["status"] == "executing":
                # in-place retry flips a terminal record back to executing (§7),
                # as does a §6 queue promotion
                if a:
                    a["_live"].add(h["id"])
                    a["_latest"] = h
                    a["_last_status"] = "executing"
                    a["_last_exec_at"] = h["started_at"]
            else:
                if a:
                    a["_live"].discard(h["id"])
                if a:
                    latest = self._latest_exec(a["id"])
                    a["_latest"] = latest
                    if latest:
                        a["_last_status"] = latest["status"]
                        a["_last_exec_at"] = latest["started_at"]

    # ---------- execution record yaml (§5 execution.yaml) ----------
    def exec_yaml_path(self, execution_id: str) -> Path:
        return self.exec_dir(execution_id) / "execution.yaml"

    def write_exec_yaml(self, h: dict) -> None:
        save_yaml(self.exec_yaml_path(h["id"]), {
            "id": h["id"],
            "automation_id": h["automation_id"],
            "automation_name": h["automation_name"],
            "kind": h["kind"],
            "version": h.get("version"),
            "status": h["status"],
            "trigger": h["trigger"],
            "trigger_payload": h.get("trigger_payload"),
            "trigger_sender": h.get("trigger_sender"),
            "queued_at": h.get("queued_at"),
            "started_at": h["started_at"],
            "finished_at": h["finished_at"],
            "duration_ms": h["duration_ms"],
            "note": h["note"],
            "chip": h.get("chip"),
            "chip_status": h.get("chip_status"),
            "error": h.get("error"),
            "redacted_secrets": h["redacted_secrets"],
            "params": h.get("params", []),
            "steps": h["steps"],
            # §4.5 pgid: on-disk only — startup recovery kills the orphaned
            # step group a crashed backend left behind.
            "pgid": h.get("pgid"),
        })

    def read_exec_yaml(self, execution_id: str) -> dict | None:
        y = load_yaml(self.exec_yaml_path(execution_id))
        if not y or not isinstance(y, dict):
            return None
        return {
            "id": y.get("id", execution_id), "automation_id": y.get("automation_id"),
            "automation_name": y.get("automation_name"),
            "kind": y.get("kind"), "version": y.get("version"),
            "status": y.get("status"), "trigger": y.get("trigger"),
            "trigger_payload": y.get("trigger_payload"),
            "trigger_sender": y.get("trigger_sender"),
            "queued_at": y.get("queued_at"),
            "started_at": y.get("started_at"), "finished_at": y.get("finished_at"),
            "duration_ms": y.get("duration_ms"), "note": y.get("note"),
            "chip": y.get("chip"), "chip_status": y.get("chip_status"),
            "error": y.get("error"), "redacted_secrets": y.get("redacted_secrets") or [],
            "params": y.get("params") or [], "steps": y.get("steps") or [],
            "pgid": y.get("pgid"),
        }

    def exec_full(self, execution_id: str) -> dict | None:
        """Full record: the live/in-memory record when it already has a body,
        else the header merged with `execution.yaml` (§5 bodies-lazily)."""
        with self.lock:
            h = self.execs.get(execution_id)
            if h is None:
                return None
            if "steps" in h:
                return h
            body = self.read_exec_yaml(execution_id)
            return {**h, **body} if body else {**h, "steps": [], "redacted_secrets": [], "params": []}

    # ---------- logs (§5 logs/, one file per step attempt) ----------
    EXEC_LOG = "execution.ndjson"
    # §5 line cap: a log file stops appending at this many lines — one final
    # `sys` marker line records the truncation, then nothing more lands in the
    # file (the step itself keeps executing). Applies to per-attempt files and
    # execution.ndjson alike; a runaway step can't fill the disk through logs.
    MAX_LOG_LINES = 10_000

    @staticmethod
    def log_name(step_file: str | None, index: int, attempt: int) -> str:
        stem = Path(step_file).stem if step_file else f"{index + 1:02d}-step"
        return f"{stem}.a{attempt}.ndjson"

    def log_file(self, execution_id: str, name: str) -> Path:
        return self.exec_dir(execution_id) / "logs" / name

    def append_log_line(self, execution_id: str, name: str, line: dict) -> None:
        p = self.log_file(execution_id, name)
        key = (execution_id, name)
        count = self._log_counts.get(key)
        if count is None:
            # The count lives in memory per file key; the one-time seed counts
            # the existing file (mirrors the engine's `_log_seq` resume). A
            # restart mid-execution just re-seeds from disk here.
            try:
                with open(p, encoding="utf-8") as f:
                    count = sum(1 for _ in f)
            except OSError:
                count = 0
        if count > self.MAX_LOG_LINES:
            self._log_counts[key] = count
            return  # already truncated — the marker is the file's last line
        if count == self.MAX_LOG_LINES:
            line = {"timestamp": timefmt.now_iso(), "kind": "sys",
                    "sequence": line.get("sequence", count + 1),
                    "text": f"Log truncated at {self.MAX_LOG_LINES} lines — "
                            "further output is discarded (the step keeps executing)"}
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
        self._log_counts[key] = count + 1

    def read_log(self, execution_id: str, step_idx: int | None = None,
                 attempt: int | None = None) -> list[dict]:
        if step_idx is None:
            name = self.EXEC_LOG
        else:
            full = self.exec_full(execution_id)
            steps = (full or {}).get("steps") or []
            if step_idx < 0 or step_idx >= len(steps):
                return []
            name = self.log_name(steps[step_idx].get("file"), step_idx, attempt or 1)
        p = self.log_file(execution_id, name)
        if not p.exists():
            return []
        out = []
        for ln in p.read_text(encoding="utf-8").splitlines():
            try:
                line = json.loads(ln)
            except ValueError:
                continue
            # §5: the stored line carries only the UTC `timestamp`; the local clock
            # label `time` is derived here, at serialization.
            if line.get("timestamp") and not line.get("time"):
                try:
                    line["time"] = timefmt.parse_local(line["timestamp"]).strftime("%H:%M:%S")
                except ValueError:
                    line["time"] = ""
            out.append(line)
        return out

    def result_files(self, execution_id: str) -> list[dict]:
        """§4.5: the file list IS the directory listing."""
        d = self.exec_dir(execution_id) / "result"
        if not d.exists():
            return []
        out = []
        for f in sorted(d.iterdir(), key=lambda p: p.name.lower()):
            try:
                st = f.stat()
            except OSError:
                continue  # deleted mid-listing (concurrent retention sweep)
            if stat.S_ISREG(st.st_mode):
                out.append({"name": f.name, "size": size_label(st.st_size)})
        return out

    def result_json(self, h: dict) -> dict | None:
        """§4.5 result object: header chip + files listing + dir path.
        An execution with only output files (no builder calls) still has a result."""
        files = self.result_files(h["id"])
        if not files and not h.get("chip"):
            return None
        out = {"files": files, "path": str(self.exec_dir(h["id"]) / "result")}
        if h.get("chip"):
            out["chip"] = h["chip"]
            out["chipStatus"] = h.get("chip_status") or "ok"
        return out

    def delete_execution(self, execution_id: str) -> None:
        with self.lock:
            h = self.execs.pop(execution_id, None)
            shutil.rmtree(self.exec_dir(execution_id), ignore_errors=True)
            self.execdb.delete(execution_id)
            for k in [k for k in self._log_counts if k[0] == execution_id]:
                del self._log_counts[k]
            # Keep `_latest` honest inside the mutator — no caller should have
            # to remember to recompute after deleting.
            if h:
                a = self.autos.get(h["automation_id"])
                if a and (a.get("_latest") or {}).get("id") == execution_id:
                    latest = self._latest_exec(a["id"])
                    a["_latest"] = latest
                    a["_last_status"] = latest["status"] if latest else "none"
                    a["_last_exec_at"] = latest["started_at"] if latest else None

    def delete_test_execs(self, automation_id: str | None) -> None:
        """§11: test executions live only as long as their draft container —
        called when a draft settles, when a new test starts (keep-latest), and
        when the automation is deleted. `automation_id` None targets create-mode test
        records (§4.5 null automationId). Live records are skipped (the §19 409
        keeps one from existing at draft-settle time in practice)."""
        with self.lock:
            for h in list(self.execs.values()):
                if is_test(h) and h["automation_id"] == automation_id and h["status"] != "executing":
                    self.delete_execution(h["id"])

    def retention_cleanup(self) -> int:
        with self.lock:
            if self.settings.get("keepForever"):
                return 0
            days = max(1, int(self.settings.get("days", 90)))
            cutoff = datetime.now().timestamp() - days * 86400
            doomed = []
            for h in self.execs.values():
                # §5: `queued` records ARE the §6 firing queue — deleting one
                # would silently drop a firing that never ran.
                if h["status"] in ("executing", "queued") or not h["started_at"]:
                    continue
                try:
                    if datetime.fromisoformat(h["started_at"]).timestamp() < cutoff:
                        doomed.append(h["id"])
                except ValueError:
                    # One unparsable row must never abort the whole sweep.
                    log.warning("retention: unparsable started_at on %s — skipping it", h["id"])
            for eid in doomed:
                self.delete_execution(eid)  # maintains each automation's `_latest`
            return len(doomed)

    # ---------- agents / secrets / settings ----------
    def save_agents(self) -> None:
        save_yaml(paths.agents_file(), {"agents": self.agents,
                                        "default_agent": self.default_agent_id})

    def save_secrets(self) -> None:
        save_yaml(paths.secrets_file(), {"secrets": self.secrets})

    def save_settings(self) -> None:
        save_yaml(paths.settings_file(), self.settings)

    def secret_used_by(self, name: str) -> list[str]:
        used = []
        for a in self.autos.values():
            cur = a["versions"].get(a["current_version"], {})
            for s in cur.get("steps", []):
                if (any(e.get("name") == name for e in s.get("secrets", []))
                        or name in SECRET_REF_RE.findall(s.get("code", ""))):
                    used.append(a["name"])
                    break
        return used

    # ---------- API serialization (§4 shapes) ----------
    def memory_stats(self, a: dict) -> dict:
        d = self.auto_dir(a) / "memory"
        size = 0
        newest: float | None = None
        for st in iter_file_stats(d):
            size += st.st_size
            newest = max(newest or 0, st.st_mtime)
        label = size_label(size) if size else "empty"
        updated = timefmt.date_label(datetime.fromtimestamp(newest)) if newest else "never written"
        return {"size": label, "updated": updated, "path": str(d)}

    def clear_memory(self, a: dict) -> None:
        d = self.auto_dir(a) / "memory"
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

    def memory_files(self, a: dict) -> list[dict]:
        """§19 read-only memory listing: memory-relative posix path, size in
        bytes, updated label; sorted by name. Lock-free — §6 atomic commit
        means a whole file is always seen; an entry vanishing mid-walk is
        skipped, like iter_file_stats."""
        d = self.auto_dir(a) / "memory"
        out: list[dict] = []
        if not d.exists():
            return out
        for f in d.rglob("*"):
            try:
                st = f.stat()
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                out.append({"name": f.relative_to(d).as_posix(), "size": st.st_size,
                            "updated": timefmt.date_label(datetime.fromtimestamp(st.st_mtime))})
        out.sort(key=lambda e: e["name"])
        return out

    def memory_file_path(self, a: dict, name: str) -> Path | None:
        """Resolve a memory-relative file name; None when it escapes the
        memory dir (absolute, `..`, or a symlink resolving outside) — §19
        422 vs 404 is the caller's split, so existence isn't checked here."""
        d = (self.auto_dir(a) / "memory").resolve()
        try:
            p = (d / name).resolve()
        except (OSError, ValueError):
            return None
        if d not in p.parents:
            return None
        return p

    # ---------- memory snapshots (§6.3) ----------
    def snapshots_dir(self, a: dict) -> Path:
        return self.auto_dir(a) / "memory-snapshots"

    def _snapshot_dir(self, a: dict, sid: str) -> Path | None:
        if not re.fullmatch(r"[0-9a-f-]{36}", sid):
            return None
        return self.snapshots_dir(a) / sid

    def _memory_file_stats(self, d: Path) -> tuple[int, int]:
        size = files = 0
        for st in iter_file_stats(d):
            size += st.st_size
            files += 1
        return size, files

    @staticmethod
    def _snapshot_meta_ok(m) -> bool:
        """§5: snapshot.yaml is hand-editable — a damaged one (non-mapping
        root, missing fields, unparsable created_at) is skipped, never fatal
        to the automation detail that serializes it."""
        if not isinstance(m, dict) or not m.get("id") or not m.get("reason"):
            return False
        try:
            timefmt.parse_local(str(m.get("created_at")))
        except ValueError:
            return False
        return True

    def list_snapshots(self, a: dict) -> list[dict]:
        """§6.3: read from disk on demand, newest first; orphan dirs (no
        snapshot.yaml) and damaged metadata skipped."""
        out = []
        root = self.snapshots_dir(a)
        if root.exists():
            for d in root.iterdir():
                if d.is_dir():
                    meta = load_yaml(d / "snapshot.yaml")
                    if self._snapshot_meta_ok(meta):
                        out.append(meta)
                    elif meta:
                        log.warning("snapshot %s has unusable snapshot.yaml — skipping it", d.name)
        return sorted(out, key=lambda m: m.get("created_at") or "", reverse=True)

    def get_snapshot(self, a: dict, sid: str) -> dict | None:
        d = self._snapshot_dir(a, sid)
        meta = load_yaml(d / "snapshot.yaml") if d else None
        return meta if self._snapshot_meta_ok(meta) else None

    def snapshot_memory(self, a: dict, reason: str, name: str | None = None,
                        version: str | None = None, keep: str | None = None) -> dict | None:
        """§6.3 create: memory copy first, snapshot.yaml last; empty memory → None.
        Automatic reasons toggled off (§6.3 memory_snapshots) → None, so no call
        site needs its own check. Sweeps crash orphans, then prunes unnamed
        snapshots beyond the newest 5 (`keep` is exempt — restore passes the
        snapshot it is about to copy from)."""
        with self.lock:
            if reason != "manual" and not a["memory_snapshots"][reason.replace("-", "_")]:
                return None
            mem = self.auto_dir(a) / "memory"
            size, files = self._memory_file_stats(mem)
            if files == 0:
                return None
            root = self.snapshots_dir(a)
            root.mkdir(parents=True, exist_ok=True)
            for d in root.iterdir():
                if d.is_dir() and not (d / "snapshot.yaml").exists():
                    shutil.rmtree(d, ignore_errors=True)
            sid = new_id()
            shutil.copytree(mem, root / sid / "memory")
            meta = {"id": sid, "name": name or None, "reason": reason,
                    "created_at": timefmt.now_iso(),
                    "version": version or f"v{a['current_version']}",
                    "size": size, "files": files}
            save_yaml(root / sid / "snapshot.yaml", meta)
            unnamed = [m for m in self.list_snapshots(a) if not m.get("name")]
            for m in unnamed[5:]:
                if m["id"] != keep:
                    shutil.rmtree(root / m["id"], ignore_errors=True)
            return meta

    def rename_snapshot(self, a: dict, sid: str, name: str | None) -> dict | None:
        with self.lock:
            meta = self.get_snapshot(a, sid)
            if not meta:
                return None
            meta["name"] = (name or "").strip() or None
            save_yaml(self.snapshots_dir(a) / sid / "snapshot.yaml", meta)
            return meta

    def delete_snapshot(self, a: dict, sid: str) -> bool:
        with self.lock:
            d = self._snapshot_dir(a, sid)
            if not d or not (d / "snapshot.yaml").exists():
                return False
            shutil.rmtree(d)
            return True

    def restore_snapshot(self, a: dict, sid: str) -> dict | None:
        """§6.3 restore: pre-restore snapshot of current memory, then replace it."""
        with self.lock:
            meta = self.get_snapshot(a, sid)
            src = self.snapshots_dir(a) / sid / "memory"
            if not meta or not src.exists():
                return None
            mem = self.auto_dir(a) / "memory"
            tmp = mem.parent / ".ad-tmp-memory"
            old = mem.parent / ".ad-old-memory"
            # Crash recovery (§6.3): a previous restore died inside the swap —
            # memory/ was renamed aside but the staged copy never took its
            # place. The aside dir is the sole surviving copy; put it back
            # before anything else can delete it.
            if not mem.exists() and old.exists():
                old.rename(mem)
            if tmp.exists():
                shutil.rmtree(tmp)
            if old.exists():
                shutil.rmtree(old)
            # `keep=sid`: the prune inside must never delete the snapshot being
            # restored — §6.3 says restore is repeatable.
            self.snapshot_memory(a, "pre-restore", keep=sid)
            # Stage first, swap by rename (§5 disk-first): no point in the
            # sequence leaves zero surviving copies — with the pre-restore
            # toggle off there is no snapshot to recover from, so rmtree'ing
            # memory/ before the staged copy lands would be a data-loss window.
            shutil.copytree(src, tmp)
            if mem.exists():
                mem.rename(old)
            tmp.rename(mem)
            shutil.rmtree(old, ignore_errors=True)
            return meta

    def snapshot_json(self, m: dict) -> dict:
        dt = timefmt.parse_local(m["created_at"])
        return {"id": m["id"], "name": m.get("name"), "reason": m["reason"],
                "when": timefmt.date_label(dt), "version": m.get("version"),
                "size": size_label(int(m.get("size") or 0)), "files": int(m.get("files") or 0)}

    def merged_params(self, a: dict, ver: dict) -> list[dict]:
        out = []
        for d in ver.get("params", []):
            v = resolve_param_value(d, a["param_values"])
            # Full definition, default included — edit mode seeds the draft's
            # params from this shape, and a §11 test resolves off those defs.
            p = dict(d)
            kind = d.get("kind")
            if kind == "toggle":
                p["on"] = bool(v)
            elif kind == "list":
                p["lines"] = list(v)
            elif kind == "kv":
                p["rows"] = [{"key": r.get("key", ""), "value": r.get("value", "")} for r in v]
            else:
                p["value"] = v
            out.append(p)
        return out

    def version_json(self, a: dict, n: int, ver: dict) -> dict:
        when = ver.get("when")
        when_label = ""
        if when:
            dt = timefmt.parse_local(when)
            # Year always included — "created Jul 18" is ambiguous a year later.
            when_label = ("created" if n == 1 else "updated") + f" {dt.strftime('%b')} {dt.day}, {dt.year}"
        return {"version": n, "when": when_label, "note": ver.get("note"),
                "spec": ver.get("spec", []), "instructions": ver.get("instructions") or "",
                "notes": ver.get("notes") or "",
                "steps": [self.step_json(s) for s in ver.get("steps", [])],
                "params": ver.get("params", []),
                "packages": ver.get("packages", [])}

    def step_json(self, s: dict) -> dict:
        """One step-serialization for versions, drafts, and the pending slot."""
        out = {"name": s.get("name", ""), "description": s.get("description", ""), "code": s.get("code", ""), "file": s.get("file")}
        if s.get("secrets"):
            out["secrets"] = list(s["secrets"])
        if s.get("packages"):
            out["packages"] = list(s["packages"])
        if s.get("agent"):
            out["agent"] = True
            out["agents"] = list(s.get("agents") or [])
            out["why"] = s.get("why", "")
        if s.get("timeout"):
            out["timeout"] = int(s["timeout"])
        if s.get("no_timeout"):
            out["noTimeout"] = True
        if s.get("retries"):
            out["retries"] = int(s["retries"])
        if s.get("infinite_retries"):
            out["infiniteRetries"] = True
        return out

    def draft_json(self, a: dict | None) -> dict | None:
        """§19: the ONE draft serializer behind /draft/{owner} — one container
        shape for both owners (a=None → the pending slot). Only the identity
        extras differ: the pending payload carries the name/description no
        automation record exists to hold (§4.4). None when the container is
        empty or absent."""
        with self.lock:
            if a is None:
                ver = self.load_pending_draft()
                extra = {"name": ver.get("name"), "description": ver.get("description", "")} if ver else {}
            else:
                ver = a["draft"]
                extra = {}
            if not ver:
                return None
            out = {
                **extra,
                "note": ver.get("note"),
                "spec": ver.get("spec", []), "instructions": ver.get("instructions") or "",
                "notes": ver.get("notes") or "",
                "steps": [self.step_json(s) for s in ver.get("steps", [])],
                "params": ver.get("params", []),
                "packages": ver.get("packages", []),
                # §4.4 draft-only keys: the editor's grant selections + trigger
                # list + §11 dirty-gate state
                **({"stepAgents": ver["step_agents"]} if ver.get("step_agents") is not None else {}),
                **({"allowedSecrets": ver["allowed_secrets"]} if ver.get("allowed_secrets") is not None else {}),
                **({"triggers": ver["triggers"]} if ver.get("triggers") is not None else {}),
                **({"paramValues": ver["param_values"]} if ver.get("param_values") is not None else {}),
                **({"concurrency": ver["concurrency"]} if ver.get("concurrency") is not None else {}),
                **({"testValues": ver["test_values"]} if ver.get("test_values") is not None else {}),
                **({"outOfSync": True} if ver.get("out_of_sync") else {}),
            }
            container = self.draft_dir(a)
            if t := self.draft_test_json(container):
                out["test"] = t
            if c := self.chat_json(container):
                out["chat"] = c
            return out

    def draft_test_json(self, container: Path) -> dict | None:
        """§11 last-test summary (`test.yaml` in the draft container, §5) —
        rides the draft payload as `test`; None when no test has finished."""
        t = load_yaml(container / "test.yaml", None)
        if not t or not t.get("status"):
            return None
        when = ""
        if t.get("when"):
            when = timefmt.started_label(timefmt.parse_local(t["when"]))
        return {"status": t["status"], "when": when, "executionId": t.get("execution_id")}

    def latest_result_json(self, a: dict) -> dict | None:
        hs = [h for h in self.execs.values()
              if h["automation_id"] == a["id"] and h["status"] != "executing" and not is_test(h)]
        for h in sorted(hs, key=lambda x: x["started_at"] or "", reverse=True):
            r = self.result_json(h)
            if r:
                dt = timefmt.parse_local(h["started_at"])
                return {**r, "executionId": h["id"], "when": f"from {timefmt.started_label(dt)}"}
        return None

    def auto_json(self, a: dict, full: bool = True) -> dict:
        cur = a["versions"].get(a["current_version"], {})
        last_at = a.get("_last_exec_at")
        last_dt = timefmt.parse_local(last_at) if last_at else None
        # §4.1 `live` is a list (maxParallel may allow several), ordered oldest
        # first so the UI can name "the current execution" deterministically.
        live_ids = sorted(a.get("_live") or (),
                          key=lambda i: (self.execs.get(i, {}).get("started_at") or "", i))
        latest_h = a.get("_latest")  # kept current by create/update_execution — no per-call scan
        chip = None
        chip_status = None  # tints the chip everywhere (§7 colors), incl. the list row
        if latest_h and latest_h["status"] == "succeeded":
            chip = latest_h.get("chip")
            chip_status = latest_h.get("chip_status") if chip else None
        elif latest_h and latest_h["status"] == "failed":
            chip = "Needs attention"
            chip_status = "attention"
        nxt = triggerlib.next_at(a["triggers"])
        when = a["versions"].get(a["current_version"], {}).get("when")
        spec_meta = f"v{a['current_version']}"
        if when:
            dt = timefmt.parse_local(when)
            spec_meta += f" · updated {timefmt.date_label(dt)}"
        out: dict[str, Any] = {
            "id": a["id"],
            "name": a["name"],
            "description": a.get("description", ""),
            "version": a["current_version"],
            "triggers": [self.trigger_json(t) for t in a["triggers"]],
            "triggerChip": triggerlib.trigger_chip(a["triggers"]),
            "triggersOff": bool(a["triggers"]) and all(not t["enabled"] for t in a["triggers"]),
            "nextAt": int(nxt.timestamp() * 1000) if nxt else None,
            "instructions": cur.get("instructions") or "",
            "notes": cur.get("notes") or "",
            "lastStatus": a.get("_last_status", "none"),
            "live": live_ids,
            "maxParallel": a.get("max_parallel", DEFAULT_MAX_PARALLEL),
            "maxQueued": a.get("max_queued", DEFAULT_MAX_QUEUED),
            "resultChip": chip,
            "resultStatus": chip_status,
            "lastExecutionLabel": "executing…" if live_ids else (timefmt.date_label(last_dt) if last_dt else ""),
            "agentId": a["agent_id"],
            "stepAgents": a["enabled_agents"],
            "allowedSecrets": a["allowed_secrets"],
            "snapshotSettings": {"preVersion": a["memory_snapshots"]["pre_version"],
                                 "preClear": a["memory_snapshots"]["pre_clear"],
                                 "preRestore": a["memory_snapshots"]["pre_restore"]},
            "specMeta": spec_meta,
        }
        if full:
            out.update({
                "latest": self.latest_result_json(a),
                "params": self.merged_params(a, cur),
                "memory": self.memory_stats(a),
                "snapshots": [self.snapshot_json(m) for m in self.list_snapshots(a)],
                "steps": [self.step_json(s) for s in cur.get("steps", [])],
                "spec": cur.get("spec", []),
                "packages": cur.get("packages", []),
                "versions": [self.version_json(a, n, v)
                             for n, v in sorted(a["versions"].items(), reverse=True)
                             if n != a["current_version"]],
                "draft": self.draft_json(a),
            })
        return out

    def step_attempts_json(self, s: dict) -> list[dict]:
        out = []
        for a in s.get("attempts", []):
            adt = timefmt.parse_local(a["started_at"]) if a.get("started_at") else None
            out.append({"number": a["number"], "status": a["status"],
                        "duration": timefmt.dur_label(a["duration_ms"]) if a.get("duration_ms") else "",
                        "startedMs": int(adt.timestamp() * 1000) if adt else 0})
        return out

    def exec_json(self, h: dict, full: bool = False) -> dict:
        dt = timefmt.parse_local(h["started_at"]) if h["started_at"] else None
        fin = timefmt.parse_local(h["finished_at"]) if h.get("finished_at") else None
        out: dict[str, Any] = {
            "id": h["id"], "automationId": h["automation_id"],
            "automationName": (self.autos.get(h["automation_id"], {}) or {}).get("name") or h["automation_name"],
            # §4.5: create-mode tests (null automationId) never had an automation to lose.
            "automationDeleted": h["automation_id"] is not None and h["automation_id"] not in self.autos,
            # §4.5 derived display pair + trigger label — the stored fields are
            # kind/version and the trigger's machine kind.
            "ver": exec_ver_label(h), "status": h["status"],
            "trigger": trigger_label(h["trigger"]),
            # §4.5 triggerSender rides on every row; the full payload stays
            # full-record-only. Stamped once at record creation (§5) — every
            # shape carries the field itself.
            "triggerSender": h.get("trigger_sender"),
            "test": is_test(h),
            "duration": timefmt.dur_label(h["duration_ms"]),
            "started": timefmt.started_label(dt) if dt else "",
            "startedMs": int(dt.timestamp() * 1000) if dt else 0,
            "endedMs": int(fin.timestamp() * 1000) if fin else 0,
            # §4.5: how long this firing waited in the §6 queue, if it waited at all
            "queuedMs": int(datetime.fromisoformat(h["queued_at"]).timestamp() * 1000)
                        if h.get("queued_at") else 0,
            "note": h["note"],
            "error": h.get("error"),
        }
        if full:
            f = h if "steps" in h else (self.exec_full(h["id"]) or {**h, "steps": [], "redacted_secrets": [], "params": []})
            out["steps"] = [{"name": s["name"], "status": s["status"],
                             "duration": timefmt.dur_label(s["duration_ms"]) if s.get("duration_ms") else "",
                             "attempts": self.step_attempts_json(s)}
                            for s in f["steps"]]
            out["result"] = self.result_json(h)
            # §4.5: full-record-only — backs the §7 "Show workspace in Finder" link
            out["workspace"] = str(self.exec_dir(h["id"]) / "workspace")
            # §4.5: a list — display surfaces join it themselves.
            out["redactedSecrets"] = f["redacted_secrets"] or None
            out["params"] = f.get("params", [])
            out["triggerPayload"] = f.get("trigger_payload")
        return out


store = Store()
