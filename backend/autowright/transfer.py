"""Transfer archives (§5.1): export an automation to a `.autowright` zip and
import one on any machine.

References plus safe metadata travel; credentials, grants, uuids, and local
state never do. Import validates the whole archive first (`TransferError` →
§19 422) and writes nothing on failure.
"""
from __future__ import annotations

import io
import json
import re
import urllib.error
import urllib.request
import zipfile
from datetime import datetime
from urllib.parse import urlsplit

import yaml

from . import __version__, harness, timefmt, triggers as triggerlib
from .drafting import STEP_FILE_RE
from .specmd import blocks_to_md, md_to_blocks
from .storage import AGENT_REF_RE, SECRET_REF_RE, Store, new_id

FORMAT_VERSION = 1
SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")
# §5.1 identity translation: inside an archive, NAMES are the reference format
# (uuids are install-local and never travel). Export rewrites the §4.1/§6.1 id
# references — step `agents:`/`secrets:` entries, the `secrets["<id>"]` /
# `agents["<id>"]` code subscripts, and a discord trigger's `secret` — to
# names; import rewrites them back to the matched/created records' local ids.
# These regexes match the archive's name-form code subscripts.
ARCHIVE_SECRET_REF_RE = re.compile(r"\bsecrets\[\s*[\"']([A-Z][A-Z0-9_]*)[\"']\s*\]")
ARCHIVE_AGENT_REF_RE = re.compile(r"\bagents\[\s*[\"']([^\"'\n]+)[\"']\s*\]")
PARAM_KINDS = ("text", "number", "toggle", "list", "kv")
MODES = ("default", "ollama", "custom")
# Any well-formed uuid passes the §4.3 field validator — the archive form
# carries the secret's NAME instead, checked separately (§5.1).
_PROBE_SECRET_ID = "00000000-0000-4000-8000-000000000000"


class TransferError(Exception):
    """Archive rejected — the message is the §19 422 detail."""


def safe_filename(name: str) -> str:
    """§19: the automation name sanitized for a filesystem filename."""
    cleaned = re.sub(r'[/\\:*?"<>|\x00-\x1f]+', " ", name).strip().strip(".")
    return cleaned or "automation"


# ---------- export ----------
class _RefResolver:
    """§5.1 export-side id → name translation. Every resolution failure is a
    TransferError naming what dangles — a reference with no stored record has
    no name to travel by, so the automation must be repaired first (§5.1)."""

    def __init__(self, store: Store):
        self.secrets_by_id = {s["id"]: s for s in store.secrets}
        self.agents_by_id = {g["id"]: g for g in store.agents}

    def secret_name(self, sid: str, where: str) -> str:
        s = self.secrets_by_id.get(sid)
        if s is None:
            raise TransferError(f"{where} references a secret that no longer exists "
                                f"({sid[:8]}…) — repair it before exporting")
        return s["name"]

    def agent_name(self, aid: str, where: str) -> str:
        g = self.agents_by_id.get(aid)
        if g is None:
            raise TransferError(f"{where} references an agent that no longer exists "
                                f"({aid[:8]}…) — repair it before exporting")
        name = harness.grant_name(g)
        if any(c in name for c in "\"'\\\n"):
            # The name lands inside a double-quoted code subscript on export —
            # a quote or backslash would corrupt the step's code.
            raise TransferError(f"agent name {name!r} can't travel in an archive — "
                                "rename it without quotes or backslashes, then export again")
        return name

    def code(self, code: str, where: str) -> str:
        """Rewrite the §6.1 id subscripts to the archive's name form. Existing
        trailing `# NAME` comments stay — they name the name, still accurate."""
        code = SECRET_REF_RE.sub(
            lambda m: f'secrets["{self.secret_name(m.group(1), where)}"]', code)
        return AGENT_REF_RE.sub(
            lambda m: f'agents["{self.agent_name(m.group(1), where)}"]', code)


def _referenced_secret_names(refs: _RefResolver, ver: dict,
                             triggers: list[dict] | None = None) -> list[str]:
    """Union of every step's `secrets:` entry ids and code-referenced ids plus
    every discord trigger's token secret — resolved to names (§5.1)."""
    names: set[str] = set()
    for s in ver.get("steps", []):
        where = f"step {s.get('name')!r}"
        names |= {refs.secret_name(e["id"], where)
                  for e in s.get("secrets") or [] if e.get("id")}
        names |= {refs.secret_name(sid, where)
                  for sid in SECRET_REF_RE.findall(s.get("code", ""))}
    names |= {refs.secret_name(t["secret"], "a Discord trigger")
              for t in triggers or [] if t.get("kind") == "discord"}
    return sorted(names)


def _referenced_agents(store: Store, refs: _RefResolver, a: dict, ver: dict) -> list[dict]:
    """The drafting agent + every step-referenced agent (manifest entry ids
    and agents["<id>"] code subscripts, §4.1) — deduped by record id, archive
    order stable."""
    by_id: dict[str, dict] = {}
    drafting = next((g for g in store.agents if g["id"] == a["agent_id"]), None)
    if drafting:
        by_id[drafting["id"]] = drafting
    for s in ver.get("steps", []):
        where = f"step {s.get('name')!r}"
        ids = {e["id"] for e in s.get("agents") or [] if e.get("id")}
        ids |= set(AGENT_REF_RE.findall(s.get("code", "")))
        for aid in sorted(ids):
            refs.agent_name(aid, where)  # raises on a dangling id
            by_id.setdefault(aid, refs.agents_by_id[aid])
    return [{"name": harness.grant_name(g), "description": g.get("description") or "",
             "harness": g.get("harness"), "mode": g.get("mode", "default"),
             "model": g.get("model")} for g in by_id.values()]


def export_automation(store: Store, a: dict, include_values: bool = True) -> bytes:
    """The §5.1 archive for an automation's current version, as zip bytes."""
    with store.lock:
        ver = a["versions"][a["current_version"]]
        refs = _RefResolver(store)
        manifest: dict = {
            "format_version": FORMAT_VERSION,
            "exported_at": timefmt.now_iso(),
            "app_version": __version__,
            "name": a["name"],
        }
        drafting = next((g for g in store.agents if g["id"] == a["agent_id"]), None)
        if drafting:
            manifest["agent"] = harness.grant_name(drafting)
        # §5.1: cron, app_start, discord, and imessage — one-shot `time`
        # triggers are moments in time; no ids, no enabled state. A discord
        # trigger's §4.3 secret id is resolved to the token secret's *name*
        # (the archive reference format) — never the value.
        triggers = []
        for t in a["triggers"]:
            if t["kind"] == "cron":
                triggers.append({"kind": "cron", "expression": t["expression"],
                                 **({"timezone": t["timezone"]} if t.get("timezone") else {})})
            elif t["kind"] == "app_start":
                triggers.append({"kind": "app_start"})
            elif t["kind"] == "discord":
                triggers.append({"kind": "discord", "channel": t["channel"],
                                 "secret": refs.secret_name(t["secret"], "a Discord trigger"),
                                 **({"pattern": t["pattern"]} if t.get("pattern") else {}),
                                 **({"mention": True} if t.get("mention") else {}),
                                 **({"author": t["author"]} if t.get("author") else {})})
            elif t["kind"] == "imessage":
                triggers.append({"kind": "imessage", "from": t["from"],
                                 **({"pattern": t["pattern"]} if t.get("pattern") else {})})
        manifest["triggers"] = triggers
        if include_values:
            manifest["param_values"] = {
                k: v for k, v in a["param_values"].items()
                if any(p.get("name") == k for p in ver.get("params", []))}
        meta: dict = {"description": a.get("description", ""), "params": ver.get("params", [])}
        pkgs = [{"pip": p.get("pip"), "import": p.get("import"),
                 **({"why": p["why"]} if p.get("why") else {})}
                for p in ver.get("packages", []) or []]
        if pkgs:
            meta["packages"] = pkgs
        steps = []
        for s in ver["steps"]:
            where = f"step {s.get('name')!r}"
            entry = {"file": s["file"], "name": s.get("name", ""), "description": s.get("description", "")}
            if s.get("agent"):
                entry["agent"] = True
                entry["why"] = s.get("why", "")
                if s.get("agents"):
                    # §5.1: id entries translate to the archive's { name, why? }
                    # form — a dangling id raises above nothing being written.
                    entry["agents"] = [
                        {"name": refs.agent_name(e["id"], where),
                         **({"why": e["why"]} if e.get("why") else {})}
                        for e in s["agents"] if e.get("id")]
            if s.get("secrets"):
                entry["secrets"] = [
                    {"name": refs.secret_name(e["id"], where),
                     **({"why": e["why"]} if e.get("why") else {})}
                    for e in s["secrets"] if e.get("id")]
            if s.get("packages"):
                entry["packages"] = list(s["packages"])
            # §4.1 per-step time limits travel — a no_timeout long-runner must
            # not silently regain the default watchdog on another Mac.
            if s.get("timeout"):
                entry["timeout"] = int(s["timeout"])
            if s.get("no_timeout"):
                entry["no_timeout"] = True
            # §4.1 retry pair travels the same way (§8: same shape rules as the
            # timeout pair) — an infinite_retries listener must not become
            # single-attempt on another Mac.
            if s.get("retries"):
                entry["retries"] = int(s["retries"])
            if s.get("infinite_retries"):
                entry["infinite_retries"] = True
            steps.append(entry)
        meta["steps"] = steps
        agents = _referenced_agents(store, refs, a, ver)
        secret_desc = {s["name"]: s.get("description") or "" for s in store.secrets}
        secrets = [{"name": n, "description": secret_desc.get(n, "")}
                   for n in _referenced_secret_names(refs, ver, a["triggers"])]
        files: list[tuple[str, str]] = [
            ("manifest.yaml", yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)),
            ("automation/automation.yaml", yaml.safe_dump(meta, sort_keys=False, allow_unicode=True)),
            ("automation/spec.md", blocks_to_md(ver.get("spec", []))),
        ]
        if ver.get("instructions"):
            files.append(("automation/instructions.md", ver["instructions"].strip() + "\n"))
        if (ver.get("notes") or "").strip():
            files.append(("automation/notes.md", ver["notes"].strip() + "\n"))
        for s in ver["steps"]:
            # §5.1: the code's id subscripts travel in name form.
            files.append((f"automation/{s['file']}",
                          refs.code(s.get("code", ""), f"step {s.get('name')!r}")))
        files.append(("agents.yaml", yaml.safe_dump({"agents": agents}, sort_keys=False, allow_unicode=True)))
        files.append(("secrets.yaml", yaml.safe_dump({"secrets": secrets}, sort_keys=False, allow_unicode=True)))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path, text in files:
            z.writestr(path, text)
    return buf.getvalue()


# ---------- import ----------
# Imported archives are untrusted input (§5.1) — cap the decompressed sizes so
# a crafted member can't balloon into memory. zipfile bounds each read by the
# declared file_size, so checking the directory up front is sufficient.
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024        # the upload itself
_MAX_MEMBER_BYTES = 32 * 1024 * 1024        # one member, decompressed
_MAX_TOTAL_BYTES = 256 * 1024 * 1024        # whole archive, decompressed


def _check_sizes(z: zipfile.ZipFile) -> None:
    total = 0
    for info in z.infolist():
        if info.file_size > _MAX_MEMBER_BYTES:
            raise TransferError(f"{info.filename} in the archive is unreasonably large")
        total += info.file_size
    if total > _MAX_TOTAL_BYTES:
        raise TransferError("the archive decompresses far beyond any real automation")


def _yaml_or_reject(z: zipfile.ZipFile, path: str, required: bool = True) -> dict:
    try:
        raw = z.read(path)
    except KeyError:
        if required:
            raise TransferError(f"the archive is missing {path}") from None
        return {}
    try:
        data = yaml.safe_load(raw.decode("utf-8"))
    except (yaml.YAMLError, UnicodeDecodeError) as e:
        raise TransferError(f"{path} isn't valid YAML: {e}") from None
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise TransferError(f"{path} must hold a YAML mapping")
    return data


def _text(z: zipfile.ZipFile, path: str, required: bool = True) -> str | None:
    try:
        return z.read(path).decode("utf-8")
    except KeyError:
        if required:
            raise TransferError(f"the archive is missing {path}") from None
        return None
    except UnicodeDecodeError:
        raise TransferError(f"{path} isn't valid UTF-8") from None


def _validate(z: zipfile.ZipFile) -> dict:
    """Parse + validate everything up front; returns the parsed archive."""
    _check_sizes(z)
    manifest = _yaml_or_reject(z, "manifest.yaml")
    if manifest.get("format_version") != FORMAT_VERSION:
        raise TransferError(f"unsupported archive format {manifest.get('format_version')!r} — "
                            f"this app reads format {FORMAT_VERSION}")
    name = manifest.get("name")
    if not isinstance(name, str) or not name.strip():
        raise TransferError("the manifest has no automation name")
    triggers_in = manifest.get("triggers") or []
    if not isinstance(triggers_in, list):
        raise TransferError("manifest triggers must be a list")
    triggers = []
    for t in triggers_in:
        if not isinstance(t, dict) or t.get("kind") not in ("cron", "app_start",
                                                            "discord", "imessage"):
            raise TransferError(f"unsupported trigger in the archive: {t!r} — "
                                "only cron, app_start, discord, and imessage travel")
        if t["kind"] == "app_start" and any(x["kind"] == "app_start" for x in triggers):
            raise TransferError("the archive holds more than one app_start trigger")
        if t["kind"] == "discord":
            # §5.1: the archive's `secret` is the token secret's NAME (ids
            # never travel) — checked here; the §4.3 uuid rule applies only
            # after import maps it to the local record's id.
            sec = t.get("secret")
            if not isinstance(sec, str) or not SECRET_NAME_RE.match(sec.strip()):
                raise TransferError("invalid trigger in the archive: a Discord trigger "
                                    "needs the name of the secret holding the bot token")
        probe = ({"kind": "discord", "channel": t.get("channel"), "secret": _PROBE_SECRET_ID,
                  "pattern": t.get("pattern"), "mention": t.get("mention", False),
                  "author": t.get("author")}
                 if t["kind"] == "discord"
                 else {"kind": "imessage", "from": t.get("from"),
                       "pattern": t.get("pattern")}
                 if t["kind"] == "imessage"
                 else {"kind": t["kind"], "expression": t.get("expression"), "timezone": t.get("timezone")})
        if err := triggerlib.validate_trigger(probe):
            raise TransferError(f"invalid trigger in the archive: {err}")
        triggers.append({"kind": t["kind"],
                         **({"expression": t["expression"]} if t["kind"] == "cron" else {}),
                         **({"timezone": t["timezone"]} if t.get("timezone") and t["kind"] == "cron" else {}),
                         **({"channel": t["channel"].strip(), "secret": t["secret"].strip(),
                             **({"pattern": t["pattern"].strip()} if t.get("pattern") else {}),
                             **({"mention": True} if t.get("mention") else {}),
                             **({"author": triggerlib.normalize_authors(t["author"])}
                                if t.get("author") else {})}
                            if t["kind"] == "discord" else {}),
                         # §4.3: normalize like every other ingest path — a
                         # formatted number stored verbatim would never match
                         # chat.db's E.164 handles and the trigger would
                         # silently never fire.
                         **({"from": triggerlib.normalize_handle(t["from"]),
                             **({"pattern": t["pattern"].strip()} if t.get("pattern") else {})}
                            if t["kind"] == "imessage" else {})})
    values = manifest.get("param_values") or {}
    if not isinstance(values, dict):
        raise TransferError("manifest param_values must be a mapping")

    meta = _yaml_or_reject(z, "automation/automation.yaml")
    params = meta.get("params") or []
    if not isinstance(params, list):
        raise TransferError("param definitions must be a list")
    for p in params:
        if not isinstance(p, dict) or not p.get("name") or p.get("kind") not in PARAM_KINDS:
            raise TransferError(f"invalid parameter definition: {p!r}")
    packages = meta.get("packages") or []
    if not isinstance(packages, list) or any(
            not isinstance(p, dict) or not p.get("pip") or not p.get("import")
            for p in packages):
        raise TransferError("invalid packages declaration")
    steps_meta = meta.get("steps") or []
    if not isinstance(steps_meta, list) or not steps_meta:
        raise TransferError("the archive holds no steps")
    steps = []
    seen_files: set[str] = set()
    for i, s in enumerate(steps_meta, 1):
        if (not isinstance(s, dict) or not isinstance(s.get("file"), str)
                or not s["file"] or not s.get("name")):
            raise TransferError(f"invalid step manifest entry: {s!r}")
        if ("/" in s["file"] or "\\" in s["file"] or s["file"].startswith(".")
                or s["file"] in ("automation.yaml", "spec.md", "instructions.md", "notes.md")):
            # Reserved names would let a step's code overwrite (or be
            # overwritten by) the version folder's own files at write time.
            raise TransferError(f"invalid step filename: {s['file']!r}")
        # §5.1/§8: the NN-name.py rule in listed order, like every other ingest
        # path — a looser name would land a version the app's own save
        # endpoints later 422 on (and `automation pull` would silently drop).
        m = STEP_FILE_RE.match(s["file"])
        if not m or int(m.group(1)) != i:
            raise TransferError(
                f"step filename {s['file']!r} must follow NN-name.py in listed order ({i:02d}-…)")
        if s["file"] in seen_files:
            raise TransferError(f"duplicate step filename: {s['file']!r}")
        seen_files.add(s["file"])
        code = _text(z, f"automation/{s['file']}")
        # §5.1: ids never travel — an archive whose code still subscripts by
        # uuid was built outside the export path and would land dangling
        # references; reject it whole.
        if SECRET_REF_RE.search(code) or AGENT_REF_RE.search(code):
            raise TransferError(f"step {s['file']!r} references secrets or agents by "
                                "install-local id — archives carry names; re-export "
                                "the automation and import that archive")
        entry = {"file": s["file"], "name": s["name"], "description": s.get("description", ""),
                 "code": code}
        if s.get("agent"):
            entry["agent"] = True
            entry["why"] = s.get("why", "")
            # §5.1: agent grants travel as {name, why?} entries — the §4.1 id
            # form is rejected (ids never travel); other malformed foreign
            # entries are dropped, not imported.
            if any(isinstance(g, dict) and "id" in g for g in s.get("agents") or []):
                raise TransferError(f"step {s['file']!r} lists agents by install-local "
                                    "id — archives carry names; re-export the automation")
            entry["agents"] = [
                {"name": g["name"],
                 **({"why": str(g["why"]).strip()} if str(g.get("why") or "").strip() else {})}
                for g in (s.get("agents") or [])
                if isinstance(g, dict) and isinstance(g.get("name"), str)]
        if s.get("secrets"):
            # §5.1: like agents, secret grants travel as {name, why} entries —
            # the id form is rejected; malformed foreign entries are dropped.
            if any(isinstance(g, dict) and "id" in g for g in s["secrets"]):
                raise TransferError(f"step {s['file']!r} lists secrets by install-local "
                                    "id — archives carry names; re-export the automation")
            entry["secrets"] = [
                {"name": g["name"],
                 **({"why": str(g["why"]).strip()} if str(g.get("why") or "").strip() else {})}
                for g in s["secrets"]
                if isinstance(g, dict) and isinstance(g.get("name"), str)]
        if s.get("packages"):
            # §5.1: per-step package notes travel as {import, why} entries —
            # malformed foreign entries are dropped, not imported.
            entry["packages"] = [
                {"import": g["import"],
                 **({"why": str(g["why"]).strip()} if str(g.get("why") or "").strip() else {})}
                for g in s["packages"]
                if isinstance(g, dict) and isinstance(g.get("import"), str)]
        t = s.get("timeout")
        if t is not None:
            if not isinstance(t, int) or isinstance(t, bool) or t <= 0:
                raise TransferError(f"invalid step timeout: {t!r}")
            entry["timeout"] = t
        if s.get("no_timeout"):
            # §5.1: steps obey the §8 bounds — an archive can't land a step no
            # drafting call could produce.
            if t is not None:
                raise TransferError("a step can't combine timeout and no_timeout")
            entry["no_timeout"] = True
        r = s.get("retries")
        if r is not None:
            if not isinstance(r, int) or isinstance(r, bool) or not 1 <= r <= 10:
                raise TransferError(f"invalid step retries: {r!r}")
            entry["retries"] = r
        if s.get("infinite_retries"):
            if r is not None:
                raise TransferError("a step can't combine retries and infinite_retries")
            entry["infinite_retries"] = True
        steps.append(entry)

    agents = _yaml_or_reject(z, "agents.yaml", required=False).get("agents") or []
    for g in agents:
        if (not isinstance(g, dict) or not isinstance(g.get("name"), str) or not g["name"]
                or g.get("harness") not in harness.HARNESS_ID):
            raise TransferError(f"invalid agent in the archive: {g!r}")
        mode = g.get("mode", "default")
        if mode not in MODES:
            raise TransferError(f"invalid agent mode {mode!r}")
        if mode == "ollama" and g["harness"] not in harness.LOCAL_MODEL_HARNESSES:
            raise TransferError(
                "a local-model agent needs Claude Code, Codex, or OpenCode")
        if mode != "default" and not g.get("model"):
            raise TransferError(f"agent {g['name']!r} needs a model for mode {mode!r}")
    # §5.1: two archive agents sharing a name (case-insensitive, the §4.7
    # comparison) would make the archive's name-form step references ambiguous.
    lowered = [g["name"].lower() for g in agents]
    if len(set(lowered)) != len(lowered):
        raise TransferError("duplicate agent names in the archive - "
                            "agent names must be unique")
    secrets = _yaml_or_reject(z, "secrets.yaml", required=False).get("secrets") or []
    for s in secrets:
        if (not isinstance(s, dict) or not isinstance(s.get("name"), str)
                or not SECRET_NAME_RE.match(s["name"])):
            raise TransferError(f"invalid secret in the archive: {s!r}")

    # §5.1: every name-form reference the import must map to a local id has to
    # be resolvable — step grant entries against the archive's agents.yaml /
    # secrets.yaml, and each discord trigger's token secret likewise (the
    # matched-or-created record is what the reference becomes).
    agent_names = {g["name"] for g in agents if isinstance(g, dict)}
    secret_names = {s["name"] for s in secrets if isinstance(s, dict)}
    for t in triggers:
        if t["kind"] == "discord" and t["secret"] not in secret_names:
            raise TransferError(f"a Discord trigger references secret {t['secret']} "
                                "that isn't listed in the archive's secrets.yaml")
    for s in steps:
        for g in s.get("agents") or []:
            if g["name"] not in agent_names:
                raise TransferError(f"step {s['file']!r} references agent {g['name']!r} "
                                    "that isn't listed in the archive's agents.yaml")
        for g in s.get("secrets") or []:
            if g["name"] not in secret_names:
                raise TransferError(f"step {s['file']!r} references secret {g['name']} "
                                    "that isn't listed in the archive's secrets.yaml")

    agent_name = manifest.get("agent")
    if agent_name is not None and not isinstance(agent_name, str):
        # An unhashable name would crash the import mid-write later — the §5.1
        # promise is 422 up front, nothing written.
        raise TransferError("the manifest's agent must be a name string")

    spec_md = _text(z, "automation/spec.md")
    instr = _text(z, "automation/instructions.md", required=False)
    notes = _text(z, "automation/notes.md", required=False)
    return {"name": name.strip(), "agent": agent_name,
            "triggers": triggers, "param_values": values,
            "description": meta.get("description", ""), "params": params, "packages": packages,
            "steps": steps, "spec": md_to_blocks(spec_md), "instructions": (instr or "").strip() or None,
            "notes": (notes or "").strip(),
            "agents": agents, "secrets": secrets}


def _open_archive(data: bytes) -> zipfile.ZipFile:
    if len(data) > MAX_ARCHIVE_BYTES:
        raise TransferError("the archive is larger than the 64 MB import limit")
    try:
        return zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise TransferError("not a valid .autowright archive") from None


def _agent_match(store: Store, g: dict) -> dict | None:
    """The §5.1 exact-config match: name + harness + mode + model."""
    model = g.get("model") if g.get("mode", "default") != "default" else None
    return next((x for x in store.agents
                 if harness.grant_name(x) == g["name"]
                 and x.get("harness") == g["harness"]
                 and x.get("mode", "default") == g.get("mode", "default")
                 and x.get("model") == model), None)


def _free_grant_name(store: Store, name: str) -> str:
    """§5.1/§4.7: a created agent's effective grant name dedupes by the §4.1
    suffix rule when a differently-configured local agent already holds it —
    §4.7 uniqueness holds across every write path, import included."""
    taken = {harness.grant_name(x).lower() for x in store.agents}
    if name.lower() not in taken:
        return name
    n = 2
    while f"{name} {n}".lower() in taken:
        n += 1
    return f"{name} {n}"


def preview_archive(store: Store, data: bytes) -> dict:
    """§5.2 preview: validate fully, write nothing, run the §5.1 match rules dry."""
    with _open_archive(data) as z:
        arch = _validate(z)
    with store.lock:
        secrets = [{"name": s["name"], "description": s.get("description") or "",
                    "exists": any(x["name"] == s["name"] for x in store.secrets)}
                   for s in arch["secrets"]]
        agents = [{"name": g["name"], "harness": g["harness"],
                   "mode": g.get("mode", "default"),
                   "model": g.get("model") if g.get("mode", "default") != "default" else None,
                   "reused": _agent_match(store, g) is not None}
                  for g in arch["agents"]]
    return {"name": arch["name"], "description": arch["description"],
            "steps": [{"name": s["name"], "description": s.get("description", ""),
                       "agent": bool(s.get("agent"))} for s in arch["steps"]],
            "params": [{"name": p["name"], "kind": p["kind"]} for p in arch["params"]],
            "triggers": arch["triggers"], "packages": arch["packages"],
            "agents": agents, "secrets": secrets}


def import_automation(store: Store, data: bytes) -> tuple[dict, dict]:
    """Validate and land a §5.1 archive; returns (automation, summary)."""
    with _open_archive(data) as z:
        arch = _validate(z)
    with store.lock:
        # Secrets: a missing referenced name becomes a §4.8 placeholder;
        # an existing name is the same secret by definition — untouched.
        created_secrets, existing_secrets = [], []
        created_secret_ids: list[str] = []
        for s in arch["secrets"]:
            if any(x["name"] == s["name"] for x in store.secrets):
                existing_secrets.append(s["name"])
            else:
                rec = {"id": new_id(), "name": s["name"],
                       "description": s.get("description") or "", "set": False}
                store.secrets.append(rec)
                created_secrets.append(s["name"])
                created_secret_ids.append(rec["id"])
        if created_secrets:
            store.save_secrets()
        # Agents: exact config match (name + harness + mode + model) reuses the
        # local record; anything else is created, its grant name deduped
        # (§5.1) — the archive's name-form references map to the record here,
        # so the rename repoints nothing.
        created_recs, reused_agents = [], []
        created_ids: list[str] = []
        matched: dict[str, dict] = {}   # archive name → local record
        for g in arch["agents"]:
            model = g.get("model") if g.get("mode", "default") != "default" else None
            local = _agent_match(store, g)
            if local:
                matched[g["name"]] = local
                reused_agents.append(g["name"])
            else:
                rec = {"id": new_id(), "name": _free_grant_name(store, g["name"]),
                       "description": g.get("description") or "",
                       "harness": g["harness"], "mode": g.get("mode", "default"),
                       "model": model}
                store.agents.append(rec)
                if store.default_agent_id is None:
                    store.default_agent_id = rec["id"]  # §4.7: the first agent is the default
                matched[g["name"]] = rec
                created_recs.append(rec)
                created_ids.append(rec["id"])
        if created_recs:
            store.save_agents()
        # The drafting agent_id maps by name; no archive agents → local default.
        drafting = matched.get(arch["agent"]) if arch.get("agent") else None
        if drafting is None:
            drafting = next((x for x in store.agents
                             if x["id"] == store.default_agent_id), None)
        # §5.1: rewrite the archive's name-form references to the matched or
        # created records' LOCAL ids — step grant entries, code subscripts,
        # and each discord trigger's token secret. On disk, ids are the only
        # reference format (§4.1/§4.3/§4.8).
        secret_id_by_name = {s["name"]: s["id"] for s in store.secrets}
        agent_id_by_name = {name: rec["id"] for name, rec in matched.items()}

        def _local_code(code: str) -> str:
            code = ARCHIVE_SECRET_REF_RE.sub(
                lambda m: (f'secrets["{secret_id_by_name[m.group(1)]}"]'
                           if m.group(1) in secret_id_by_name else m.group(0)), code)
            return ARCHIVE_AGENT_REF_RE.sub(
                lambda m: (f'agents["{agent_id_by_name[m.group(1)]}"]'
                           if m.group(1) in agent_id_by_name else m.group(0)), code)

        steps = []
        for s in arch["steps"]:
            entry = dict(s)
            entry["code"] = _local_code(entry.get("code", ""))
            if entry.get("agents"):
                entry["agents"] = [
                    {"id": agent_id_by_name[g["name"]],
                     **({"why": g["why"]} if g.get("why") else {})}
                    for g in entry["agents"]]
            if entry.get("secrets"):
                entry["secrets"] = [
                    {"id": secret_id_by_name[g["name"]],
                     **({"why": g["why"]} if g.get("why") else {})}
                    for g in entry["secrets"]]
            steps.append(entry)
        ver = {"description": arch["description"], "note": "Imported", "params": arch["params"],
               "packages": arch["packages"], "steps": steps,
               "spec": arch["spec"], "instructions": arch["instructions"], "notes": arch["notes"]}
        triggers = [{"id": new_id(), "enabled": False,
                     **(t if t.get("kind") != "discord"
                        else {**t, "secret": secret_id_by_name[t["secret"]]})}
                    for t in arch["triggers"]]
        # §5.1 grants: only what this import created, passed directly into the
        # creation call as its grant lists (one write) — no post-create grant
        # patch, so no window ever exists in which the automation is stored
        # with different grants (an explicit empty list also overrides
        # create_automation's drafting-agent fallback).
        a = store.create_automation(ver, name=arch["name"],
                                    agent_id=drafting["id"] if drafting else None,
                                    triggers=triggers,
                                    enabled_agents=list(created_ids),
                                    allowed_secrets=list(created_secret_ids))
        if arch["param_values"]:
            # Values are the one manifest field creation can't seed.
            store.patch_automation(a, {"paramValues": arch["param_values"]})
    # §5.1 summary: each created agent carries `ready` — the one §19 check-ready
    # rule, run outside the store lock (it may spawn a status subprocess) and
    # memoized per harness config so agents sharing one harness check once.
    ready_memo: dict[tuple, bool] = {}

    def _ready(rec: dict) -> bool:
        key = (rec["harness"], rec["mode"], rec["model"])
        if key not in ready_memo:
            ready_memo[key] = harness.check_ready(rec["harness"], rec["model"], rec["mode"])
        return ready_memo[key]

    summary = {"secretsCreated": created_secrets, "secretsExisting": existing_secrets,
               "agentsCreated": [{"name": r["name"], "ready": _ready(r)} for r in created_recs],
               "agentsReused": reused_agents,
               "packages": arch["packages"]}
    return a, summary


# ---------- URL import (§5.2) ----------
FETCH_TIMEOUT = 30                          # seconds, connect + read
_FETCH_CHUNK = 256 * 1024

_GH_REPO_RE = re.compile(r"^/([^/]+)/([^/]+?)(?:\.git)?(?:/releases/latest)?$")
_GH_TAG_RE = re.compile(r"^/([^/]+)/([^/]+)/releases/tag/([^/]+)$")


def _headers() -> dict:
    return {"User-Agent": f"autowright/{__version__}"}


def _github_api(path: str):
    """Unauthenticated GitHub API GET; None on 404, TransferError otherwise."""
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={**_headers(), "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        if e.code in (403, 429):
            raise TransferError("GitHub rate-limited the lookup — try again in a "
                                "few minutes, or paste the direct .autowright link") from None
        raise TransferError(f"GitHub answered {e.code} for {path}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise TransferError(f"couldn't reach GitHub — {getattr(e, 'reason', e)}") from None


def _release_asset(release) -> str | None:
    for a in (release or {}).get("assets") or []:
        if isinstance(a, dict) and str(a.get("name", "")).endswith(".autowright"):
            return a.get("browser_download_url")
    return None


def resolve_url(url: str) -> str:
    """§5.2: turn a pasted URL into a direct archive URL, or reject with 422."""
    url = url.strip()
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise TransferError("only https:// URLs can be imported")
    if parts.path.endswith(".autowright"):
        return url
    if parts.hostname != "github.com":
        raise TransferError("the URL doesn't point to an .autowright archive — paste a "
                            "direct link to one, or a github.com repository page")
    path = parts.path.rstrip("/")
    if m := _GH_TAG_RE.match(path):
        owner, repo, tag = m.groups()
        asset = _release_asset(_github_api(f"/repos/{owner}/{repo}/releases/tags/{tag}"))
        if not asset:
            raise TransferError(f"release {tag!r} of {owner}/{repo} has no "
                                ".autowright asset")
        return asset
    if not (m := _GH_REPO_RE.match(path)):
        raise TransferError("unrecognized github.com URL — paste the repository page, a "
                            "release, or a direct .autowright link")
    owner, repo = m.groups()
    if asset := _release_asset(_github_api(f"/repos/{owner}/{repo}/releases/latest")):
        return asset
    listing = _github_api(f"/repos/{owner}/{repo}/contents/")
    files = sorted((f["name"], f.get("download_url"))
                   for f in (listing if isinstance(listing, list) else [])
                   if isinstance(f, dict) and f.get("type") == "file"
                   and str(f.get("name", "")).endswith(".autowright"))
    if files and files[0][1]:
        return files[0][1]
    raise TransferError(f"{owner}/{repo} has no .autowright archive — checked the latest "
                        "release's assets and the repository root")


def fetch_archive(url: str) -> tuple[bytes, str]:
    """§5.2 download: returns (archive bytes, resolved URL)."""
    resolved = resolve_url(url)
    req = urllib.request.Request(resolved, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
            # urllib follows redirects — a hop off https would sidestep the
            # §5.2 HTTPS-only rule, so re-check the landing URL.
            if urlsplit(r.geturl()).scheme != "https":
                raise TransferError("the download redirected off https")
            chunks, total = [], 0
            while chunk := r.read(_FETCH_CHUNK):
                total += len(chunk)
                if total > MAX_ARCHIVE_BYTES:
                    raise TransferError("the download is larger than the 64 MB import limit")
                chunks.append(chunk)
    except urllib.error.HTTPError as e:
        raise TransferError(f"download failed — the server answered {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise TransferError(f"download failed — {getattr(e, 'reason', e)}") from None
    return b"".join(chunks), resolved
