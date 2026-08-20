"""Transfer archives (§5.1): export/import round-trips, grant rules, rejection."""
import io
import zipfile

import pytest
import yaml

from autowright import __version__, transfer
from autowright.storage import Store, new_id


def _agent(name, harness="Claude Code", mode="default", model=None):
    return {"id": new_id(), "name": name, "description": "", "harness": harness,
            "mode": mode, "model": model}


def _build(store: Store):
    """An automation exercising every archive surface: params + values, cron +
    app_start + time triggers, an agent step, declared + code-referenced
    secrets — all references by id (§4.1/§4.3/§4.8); export translates them
    to the archive's name form."""
    store.agents = [_agent("Researcher"),
                    _agent("Coder", harness="OpenCode", mode="custom", model="anthropic/x")]
    store.default_agent_id = store.agents[0]["id"]  # §4.7 single pointer
    store.save_agents()
    api_key, bot_token, mail_pass = new_id(), new_id(), new_id()
    store.secrets = [{"id": api_key, "name": "API_KEY", "description": "service key", "set": True},
                     {"id": bot_token, "name": "BOT_TOKEN", "description": "discord bot", "set": True},
                     {"id": mail_pass, "name": "MAIL_PASS", "description": "mail", "set": True}]
    store.save_secrets()
    coder_id = store.agents[1]["id"]
    ver = {
        "description": "Watches things",
        "params": [{"name": "count", "kind": "number", "label": "Count", "help": "", "default": 3}],
        "packages": [{"pip": "pandas", "import": "pandas", "why": "builds the table"}],
        "steps": [
            {"name": "Fetch", "description": "",
             "code": f'from autowright import secrets\nx = secrets["{api_key}"]  # API_KEY\n',
             "secrets": [{"id": mail_pass, "why": "sends the mail"}]},
            {"name": "Summarize", "description": "", "code": "print('hi')\n",
             "agent": True, "why": "judgment", "agents": [{"id": coder_id}]},
        ],
        "spec": [{"kind": "h1", "text": "Watch"}, {"kind": "p", "text": "Body."}],
        "instructions": "Keep it short.",
    }
    a = store.create_automation(
        ver, name="Watcher", agent_id=store.agents[0]["id"],
        triggers=[{"id": new_id(), "kind": "cron", "enabled": True, "expression": "0 8 * * *", "timezone": "America/New_York"},
                  {"id": new_id(), "kind": "app_start", "enabled": True},
                  {"id": new_id(), "kind": "time", "enabled": True, "at": "2999-01-01T09:00"},
                  {"id": new_id(), "kind": "discord", "enabled": True, "channel": "42",
                   "secret": bot_token, "pattern": "go", "author": ["111", "777"]},
                  {"id": new_id(), "kind": "imessage", "enabled": True,
                   "from": "+15551234567", "pattern": "run"}],
        enabled_agents=[g["id"] for g in store.agents],
        allowed_secrets=[api_key, mail_pass])
    store.patch_automation(a, {"paramValues": {"count": 7}})
    return a


@pytest.fixture(autouse=True)
def stub_check_ready(monkeypatch):
    """§5.1 summary readiness flag — stubbed so no test spawns a real harness
    status subprocess; the readiness test overrides this per harness."""
    monkeypatch.setattr(transfer.harness, "check_ready",
                        lambda name, model=None, mode="default": False)


def _fresh_home(monkeypatch, tmp_path_factory):
    home2 = tmp_path_factory.mktemp("home2")
    monkeypatch.setenv("AUTOWRIGHT_HOME", str(home2))
    from autowright import paths

    paths.ensure_dirs()
    s2 = Store()
    s2.load_all()
    return s2


def test_export_layout_and_sanitization(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    z = zipfile.ZipFile(io.BytesIO(data))
    names = set(z.namelist())
    assert {"manifest.yaml", "automation/automation.yaml", "automation/spec.md",
            "automation/instructions.md", "agents.yaml", "secrets.yaml"} <= names
    manifest = yaml.safe_load(z.read("manifest.yaml"))
    assert manifest["format_version"] == 1
    # §5.1: every export records the app version (not read on import today —
    # reserved for future version gating)
    assert manifest["app_version"] == __version__
    assert manifest["name"] == "Watcher"
    assert manifest["agent"] == "Researcher"
    # cron + app_start + discord + imessage, no ids/off; the one-shot time
    # trigger never travels
    assert manifest["triggers"] == [{"kind": "cron", "expression": "0 8 * * *", "timezone": "America/New_York"},
                                    {"kind": "app_start"},
                                    {"kind": "discord", "channel": "42",
                                     "secret": "BOT_TOKEN", "pattern": "go",
                                     "author": ["111", "777"]},
                                    {"kind": "imessage", "from": "+15551234567",
                                     "pattern": "run"}]
    assert manifest["param_values"] == {"count": 7}
    meta = yaml.safe_load(z.read("automation/automation.yaml"))
    assert "when" not in meta and "note" not in meta
    assert meta["packages"] == [{"pip": "pandas", "import": "pandas", "why": "builds the table"}]
    # both referenced agents travel, without ids or credentials
    agents = yaml.safe_load(z.read("agents.yaml"))["agents"]
    assert {g["name"] for g in agents} == {"Researcher", "Coder"}
    assert all("id" not in g for g in agents)
    # declared + code-referenced + trigger-token secrets, names and descs only
    secrets = yaml.safe_load(z.read("secrets.yaml"))["secrets"]
    assert secrets == [{"name": "API_KEY", "description": "service key"},
                       {"name": "BOT_TOKEN", "description": "discord bot"},
                       {"name": "MAIL_PASS", "description": "mail"}]
    raw = data.decode("latin-1")
    assert "mail-app" not in raw  # no values anywhere


def test_export_without_values(store):
    a = _build(store)
    z = zipfile.ZipFile(io.BytesIO(transfer.export_automation(store, a, include_values=False)))
    assert "param_values" not in yaml.safe_load(z.read("manifest.yaml"))


def test_import_on_fresh_machine(store, monkeypatch, tmp_path_factory):
    a = _build(store)
    data = transfer.export_automation(store, a)
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    b, summary = transfer.import_automation(s2, data)
    assert b["id"] != a["id"]
    assert b["current_version"] == 1
    assert b["versions"][1]["note"] == "Imported"
    # the exporter's content survives — with every reference rewritten to the
    # importing machine's LOCAL ids (§5.1 identity translation)
    assert b["versions"][1]["spec"] == a["versions"][1]["spec"]
    created_ids = {s["name"]: s["id"] for s in s2.secrets}
    fetch, summarize = b["versions"][1]["steps"]
    assert fetch["code"] == ('from autowright import secrets\n'
                             f'x = secrets["{created_ids["API_KEY"]}"]  # API_KEY\n')
    assert fetch["secrets"] == [{"id": created_ids["MAIL_PASS"], "why": "sends the mail"}]
    coder = next(g for g in s2.agents if g["name"] == "Coder")
    assert summarize["agents"] == [{"id": coder["id"]}]
    assert b["versions"][1]["instructions"] == "Keep it short."
    assert b["param_values"] == {"count": 7}
    # every trigger lands off, with fresh ids — message triggers keep their fields
    assert all(not t["enabled"] for t in b["triggers"])
    assert {t["kind"] for t in b["triggers"]} == {"cron", "app_start", "discord", "imessage"}
    d = next(t for t in b["triggers"] if t["kind"] == "discord")
    assert (d["channel"], d["secret"], d["pattern"], d["author"]) == \
        ("42", created_ids["BOT_TOKEN"], "go", ["111", "777"])
    im = next(t for t in b["triggers"] if t["kind"] == "imessage")
    assert (im["from"], im["pattern"]) == ("+15551234567", "run")
    # secrets became placeholders, agents were created — and only those granted
    assert summary["secretsCreated"] == ["API_KEY", "BOT_TOKEN", "MAIL_PASS"]
    assert summary["secretsExisting"] == []
    assert sorted(g["name"] for g in summary["agentsCreated"]) == ["Coder", "Researcher"]
    assert all(not s["set"] for s in s2.secrets)
    # §4.1: allowed_secrets holds the created placeholders' ids
    assert sorted(b["allowed_secrets"]) == sorted(
        created_ids[n] for n in ("API_KEY", "BOT_TOKEN", "MAIL_PASS"))
    assert set(b["enabled_agents"]) == {g["id"] for g in s2.agents}
    # drafting agent mapped by name
    drafting = next(g for g in s2.agents if g["name"] == "Researcher")
    assert b["agent_id"] == drafting["id"]
    # a fresh Store sees the same state after a reload (§5 disk-first)
    s3 = Store()
    s3.load_all()
    assert b["id"] in s3.autos


def test_step_limits_retry_pair_and_handle_normalization(store, monkeypatch, tmp_path_factory):
    """§5.1: the §4.1 timeout AND retry pairs travel — an infinite_retries
    listener must not become single-attempt on another Mac. A hand-edited
    archive's formatted iMessage handle normalizes on import (stored verbatim
    it would never match chat.db's E.164 handles and silently never fire)."""
    ver = {"description": "", "params": [], "packages": [],
           "steps": [{"name": "Long", "description": "", "code": "print('x')\n",
                      "timeout": 900, "retries": 4},
                     {"name": "Listen", "description": "", "code": "print('y')\n",
                      "no_timeout": True, "infinite_retries": True}],
           "spec": [{"kind": "h1", "text": "T"}], "instructions": ""}
    a = store.create_automation(
        ver, name="Limits", agent_id=None,
        triggers=[{"id": new_id(), "kind": "imessage", "enabled": True,
                   "from": "+15551234567"}])
    data = transfer.export_automation(store, a)
    zin = zipfile.ZipFile(io.BytesIO(data))
    meta = yaml.safe_load(zin.read("automation/automation.yaml"))
    s1, s2 = meta["steps"]
    assert s1["timeout"] == 900 and s1["retries"] == 4
    assert s2["no_timeout"] is True and s2["infinite_retries"] is True

    # hand-edit the archive: formatted number in the imessage trigger
    manifest = yaml.safe_load(zin.read("manifest.yaml"))
    for t in manifest["triggers"]:
        if t["kind"] == "imessage":
            t["from"] = "+1 (555) 123-4567"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zout:
        for n in zin.namelist():
            zout.writestr(n, yaml.safe_dump(manifest) if n == "manifest.yaml"
                          else zin.read(n))
    s2_store = _fresh_home(monkeypatch, tmp_path_factory)
    b, _summary = transfer.import_automation(s2_store, buf.getvalue())
    t1, t2 = b["versions"][1]["steps"]
    assert t1["timeout"] == 900 and t1["retries"] == 4
    # internal shape is snake_case only — no camelCase ever reaches storage
    assert t2.get("no_timeout") and t2.get("infinite_retries")
    assert b["triggers"][0]["from"] == "+15551234567"


def test_import_rejects_out_of_bounds_step_limits(store):
    """§5.1: imported steps obey the §8 bounds — retries 1-10, timeout never
    with no_timeout, retries never with infinite_retries. An archive can't
    land a step no drafting call could produce."""
    ver = {"description": "", "params": [], "packages": [],
           "steps": [{"name": "Only", "description": "", "code": "print('x')\n",
                      "timeout": 60, "retries": 2}],
           "spec": [{"kind": "h1", "text": "T"}], "instructions": ""}
    a = store.create_automation(ver, name="Bounds", agent_id=None, triggers=[])
    data = transfer.export_automation(store, a)
    before = len(store.autos)

    def rezip(edit):
        src = zipfile.ZipFile(io.BytesIO(data))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as out:
            for n in src.namelist():
                if n == "automation/automation.yaml":
                    meta = yaml.safe_load(src.read(n))
                    edit(meta["steps"][0])
                    out.writestr(n, yaml.safe_dump(meta))
                else:
                    out.writestr(n, src.read(n))
        return buf.getvalue()

    with pytest.raises(transfer.TransferError, match="invalid step retries: 11"):
        transfer.import_automation(store, rezip(lambda s: s.update(retries=11)))
    with pytest.raises(transfer.TransferError, match="invalid step retries: 0"):
        transfer.import_automation(store, rezip(lambda s: s.update(retries=0)))
    with pytest.raises(transfer.TransferError,
                       match="can't combine timeout and no_timeout"):
        transfer.import_automation(store, rezip(lambda s: s.update(no_timeout=True)))
    with pytest.raises(transfer.TransferError,
                       match="can't combine retries and infinite_retries"):
        transfer.import_automation(store, rezip(lambda s: s.update(infinite_retries=True)))
    assert len(store.autos) == before


def test_import_on_same_machine_grants_nothing_preexisting(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    b, summary = transfer.import_automation(store, data)
    # same names exist → nothing created, nothing granted
    assert summary["secretsCreated"] == []
    assert summary["secretsExisting"] == ["API_KEY", "BOT_TOKEN", "MAIL_PASS"]
    assert sorted(summary["agentsReused"]) == ["Coder", "Researcher"]
    assert summary["agentsCreated"] == []
    assert b["allowed_secrets"] == []
    assert b["enabled_agents"] == []
    # exact-config match reuses the record — the drafting agent maps to it
    assert b["agent_id"] == a["agent_id"]
    assert len(store.agents) == 2
    # existing secrets untouched
    assert all(s["set"] for s in store.secrets)


def test_import_agent_name_collision_creates_second_record(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    # same name, different config → a second record under a deduped grant
    # name (§5.1/§4.7: uniqueness holds across every write path)
    coder = next(g for g in store.agents if g["name"] == "Coder")
    coder["mode"], coder["model"] = "default", None
    store.save_agents()
    b, summary = transfer.import_automation(store, data)
    assert summary["agentsCreated"] == [{"name": "Coder 2", "ready": False}]
    assert summary["agentsReused"] == ["Researcher"]
    created = next(g for g in store.agents if g["name"] == "Coder 2")
    assert created["mode"] == "custom"
    # the archive's name-form step references map to the created record
    assert b["enabled_agents"] == [created["id"]]


def test_import_name_dedupe_previews_and_reports(store, monkeypatch, tmp_path_factory):
    """§4.1/§5.1: a taken automation name previews (`landsAs`) and lands
    deduped, and the summary carries `renamedFrom`; a free name previews as
    itself and the summary reports no rename."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    pv = transfer.preview_archive(store, data)
    assert pv["name"] == "Watcher"
    assert pv["landsAs"] == "Watcher 2"
    b, summary = transfer.import_automation(store, data)
    assert b["name"] == "Watcher 2"
    assert summary["renamedFrom"] == "Watcher"
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    pv2 = transfer.preview_archive(s2, data)
    assert pv2["landsAs"] == pv2["name"] == "Watcher"
    c, summary2 = transfer.import_automation(s2, data)
    assert c["name"] == "Watcher"
    assert summary2["renamedFrom"] is None


def test_import_rejects_unlisted_code_subscripts(store):
    """§5.1: a name-form code subscript resolving against neither agents.yaml
    nor secrets.yaml is a 422 up front, nothing written — never code that only
    fails at execution time."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = (len(store.autos), len(store.secrets), len(store.agents))

    def bad_secret(nm, body):
        if nm == "automation/01-fetch.py":
            return body.decode() + 'y = secrets["UNKNOWN"]\n'

    with pytest.raises(transfer.TransferError,
                       match="secret UNKNOWN.*secrets.yaml"):
        transfer.import_automation(store, _rezip(data, bad_secret))

    def bad_agent(nm, body):
        if nm == "automation/02-summarize.py":
            return body.decode() + 'z = agents["Nobody"]("hi")\n'

    with pytest.raises(transfer.TransferError,
                       match="agent 'Nobody'.*agents.yaml"):
        transfer.import_automation(store, _rezip(data, bad_agent))
    assert (len(store.autos), len(store.secrets), len(store.agents)) == before


def test_import_rejects_duplicate_archive_agent_names(store):
    # §5.1: two archive agents sharing a name (case-insensitive) would make
    # the archive's name-form step references ambiguous → 422, nothing lands.
    a = _build(store)
    data = transfer.export_automation(store, a)

    def edit(nm, body):
        if nm == "agents.yaml":
            doc = yaml.safe_load(body)
            dup = {**doc["agents"][0], "name": doc["agents"][0]["name"].upper()}
            doc["agents"].append(dup)
            return yaml.safe_dump(doc)

    before = len(store.autos)
    with pytest.raises(transfer.TransferError, match="must be unique"):
        transfer.import_automation(store, _rezip(data, edit))
    assert len(store.autos) == before


def test_import_summary_created_agents_carry_readiness(store, monkeypatch, tmp_path_factory):
    """§5.1: each created agent's summary entry carries `ready` — the §19
    check-ready rule run on the created agent's harness/mode/model."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    calls = []

    def fake_ready(name, model=None, mode="default"):
        calls.append((name, model, mode))
        return name == "Claude Code"

    monkeypatch.setattr(transfer.harness, "check_ready", fake_ready)
    _b, summary = transfer.import_automation(s2, data)
    assert {g["name"]: g["ready"] for g in summary["agentsCreated"]} == \
        {"Researcher": True, "Coder": False}
    # checked with each created agent's real config, once per config
    assert sorted(calls) == [("Claude Code", None, "default"),
                             ("OpenCode", "anthropic/x", "custom")]


def test_import_rejects_and_writes_nothing(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = (len(store.autos), len(store.secrets), len(store.agents))

    with pytest.raises(transfer.TransferError, match="not a valid"):
        transfer.import_automation(store, b"garbage")

    def rezip(edit):
        src = zipfile.ZipFile(io.BytesIO(data))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as out:
            for n in src.namelist():
                out.writestr(n, edit(n, src.read(n)) or src.read(n))
        return buf.getvalue()

    bad_version = rezip(lambda n, b: yaml.safe_dump(
        {**yaml.safe_load(b), "format_version": 99}).encode() if n == "manifest.yaml" else None)
    with pytest.raises(transfer.TransferError, match="unsupported archive format"):
        transfer.import_automation(store, bad_version)

    # a manifest step whose script file is missing from the zip
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n in src.namelist():
            if not n.endswith(".py"):
                out.writestr(n, src.read(n))
    with pytest.raises(transfer.TransferError, match="missing automation/"):
        transfer.import_automation(store, buf.getvalue())

    bad_agent = rezip(lambda n, b: yaml.safe_dump(
        {"agents": [{"name": "X", "harness": "Nope"}]}).encode() if n == "agents.yaml" else None)
    with pytest.raises(transfer.TransferError, match="invalid agent"):
        transfer.import_automation(store, bad_agent)

    assert (len(store.autos), len(store.secrets), len(store.agents)) == before


def test_import_local_model_agent_harness_rule(store):
    # §4.7: a local-model agent grant imports with Claude Code, Codex, or
    # OpenCode — never Gemini CLI.
    a = _build(store)
    data = transfer.export_automation(store, a)

    def with_extra_agent(g):
        src = zipfile.ZipFile(io.BytesIO(data))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as out:
            for n in src.namelist():
                body = src.read(n)
                if n == "agents.yaml":
                    body = yaml.safe_dump(
                        {"agents": (yaml.safe_load(body).get("agents") or []) + [g]}).encode()
                out.writestr(n, body)
        return buf.getvalue()

    for h in ("Claude Code", "Codex", "OpenCode"):
        transfer.import_automation(store, with_extra_agent(
            {"name": f"Local {h}", "harness": h, "mode": "ollama", "model": "qwen3:8b"}))
    with pytest.raises(transfer.TransferError, match="local-model agent"):
        transfer.import_automation(store, with_extra_agent(
            {"name": "Local G", "harness": "Gemini CLI", "mode": "ollama",
             "model": "qwen3:8b"}))


# ---------- §4.7 default-agent pointer on import ----------

def test_import_without_manifest_agent_uses_default_pointer(store):
    """§5.1/§4.7: an archive exported with no drafting agent lands on THE
    app-default agent — resolved through the single `default_agent` pointer,
    not a per-record flag (which no longer exists)."""
    store.agents = [_agent("Researcher"), _agent("Coder")]
    # the pointer names the SECOND agent, so a first-agent (or flag-based)
    # fallback would give the wrong answer
    store.default_agent_id = store.agents[1]["id"]
    store.save_agents()
    ver = {"description": "", "params": [], "packages": [],
           "steps": [{"name": "Only", "description": "", "code": "print('x')\n"}],
           "spec": [{"kind": "h1", "text": "T"}], "instructions": ""}
    a = store.create_automation(ver, name="Agentless", agent_id=None)
    data = transfer.export_automation(store, a)
    b, _summary = transfer.import_automation(store, data)
    assert b["agent_id"] == store.default_agent_id


def test_import_on_fresh_machine_sets_pointer_and_writes_no_flag(store, monkeypatch,
                                                                 tmp_path_factory):
    """§4.7: importing onto a machine with no agents makes the first created
    agent THE default via the pointer; agents.yaml records never carry a
    per-record `default` flag."""
    from autowright import paths

    a = _build(store)
    data = transfer.export_automation(store, a)
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    assert s2.agents == [] and s2.default_agent_id is None
    b, _summary = transfer.import_automation(s2, data)
    assert s2.default_agent_id == s2.agents[0]["id"]
    assert all("default" not in g for g in s2.agents)
    saved = yaml.safe_load(paths.agents_file().read_text(encoding="utf-8"))
    assert saved["default_agent"] == s2.default_agent_id
    assert all("default" not in g for g in saved["agents"])
    # the archive's drafting agent still maps by name, untouched by the pointer
    assert b["agent_id"] == next(g["id"] for g in s2.agents if g["name"] == "Researcher")


# ---------- appended coverage: caps, traversal, manifest rejects ----------

def _rezip(data, edit):
    """Rebuild the archive, letting `edit(name, bytes)` replace member content."""
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for nm in src.namelist():
            out.writestr(nm, edit(nm, src.read(nm)) or src.read(nm))
    return buf.getvalue()


def test_total_decompressed_size_cap(store):
    """Members individually under _MAX_MEMBER_BYTES whose sum crosses
    _MAX_TOTAL_BYTES → rejected up front, nothing written."""
    before = (len(store.autos), len(store.secrets), len(store.agents))
    member = bytes(30 * 1024 * 1024)                 # zeros — deflates tiny
    assert len(member) < transfer._MAX_MEMBER_BYTES
    n = transfer._MAX_TOTAL_BYTES // len(member) + 1  # sum > total cap
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i in range(n):
            z.writestr(f"pad{i}.bin", member)
    data = buf.getvalue()
    assert len(data) < transfer.MAX_ARCHIVE_BYTES     # the archive itself stays small
    with pytest.raises(transfer.TransferError, match="decompresses far beyond"):
        transfer.import_automation(store, data)
    assert (len(store.autos), len(store.secrets), len(store.agents)) == before


def test_step_filename_traversal_rejected(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = len(store.autos)

    def evil(nm, b):
        if nm == "automation/automation.yaml":
            meta = yaml.safe_load(b)
            meta["steps"][0]["file"] = "../evil.py"
            return yaml.safe_dump(meta).encode()
        return None

    with pytest.raises(transfer.TransferError, match="invalid step filename"):
        transfer.import_automation(store, _rezip(data, evil))
    assert len(store.autos) == before


def test_format_version_and_duplicate_app_start_rejected(store):
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = len(store.autos)

    def bump(nm, b):
        if nm == "manifest.yaml":
            return yaml.safe_dump({**yaml.safe_load(b), "format_version": 2}).encode()
        return None

    with pytest.raises(transfer.TransferError, match="unsupported archive format"):
        transfer.import_automation(store, _rezip(data, bump))

    def dupe(nm, b):
        if nm == "manifest.yaml":
            m = yaml.safe_load(b)
            m["triggers"] = [{"kind": "app_start"}, {"kind": "app_start"}]
            return yaml.safe_dump(m).encode()
        return None

    with pytest.raises(transfer.TransferError, match="more than one app_start"):
        transfer.import_automation(store, _rezip(data, dupe))
    assert len(store.autos) == before


# ---------- §5.2 URL import ----------

def test_resolve_url_rules():
    # https only
    with pytest.raises(transfer.TransferError, match="https"):
        transfer.resolve_url("http://example.com/a.autowright")
    # a direct .autowright link passes through, any host
    url = "https://example.com/dl/manga.autowright"
    assert transfer.resolve_url(url) == url
    # a non-github page with no archive suffix is rejected
    with pytest.raises(transfer.TransferError, match="direct link"):
        transfer.resolve_url("https://example.com/some/page")
    # an unrecognized github path is rejected
    with pytest.raises(transfer.TransferError, match="unrecognized github.com"):
        transfer.resolve_url("https://github.com/alice/repo/issues/3")


def test_resolve_github_release_tag_and_root_fallback(monkeypatch):
    def fake_api(path):
        table = {
            "/repos/alice/watcher/releases/latest": {"assets": [
                {"name": "notes.zip", "browser_download_url": "https://x/zip"},
                {"name": "watcher.autowright", "browser_download_url": "https://x/w"}]},
            "/repos/alice/watcher/releases/tags/v2": {"assets": [
                {"name": "watcher.autowright", "browser_download_url": "https://x/v2"}]},
            "/repos/alice/norel/releases/latest": None,
            "/repos/alice/norel/contents/": [
                {"type": "file", "name": "b.autowright", "download_url": "https://x/b"},
                {"type": "file", "name": "a.autowright", "download_url": "https://x/a"},
                {"type": "dir", "name": "c.autowright"}],
            "/repos/alice/empty/releases/latest": None,
            "/repos/alice/empty/contents/": [],
        }
        assert path in table, path
        return table[path]

    monkeypatch.setattr(transfer, "_github_api", fake_api)
    # repo page and /releases/latest → the release's .autowright asset
    assert transfer.resolve_url("https://github.com/alice/watcher") == "https://x/w"
    assert transfer.resolve_url("https://github.com/alice/watcher/releases/latest") == "https://x/w"
    # a tagged release resolves against that release's assets
    assert transfer.resolve_url("https://github.com/alice/watcher/releases/tag/v2") == "https://x/v2"
    # no release with an asset → repo root, first .autowright alphabetically
    assert transfer.resolve_url("https://github.com/alice/norel/") == "https://x/a"
    with pytest.raises(transfer.TransferError, match="no .autowright archive"):
        transfer.resolve_url("https://github.com/alice/empty")


class _FakeResp:
    def __init__(self, data, url="https://x/a.autowright"):
        self._buf, self._url = io.BytesIO(data), url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self, n=-1):
        return self._buf.read(n)

    def geturl(self):
        return self._url


def test_fetch_archive_download_cap_and_redirect_guard(monkeypatch):
    monkeypatch.setattr(transfer.urllib.request, "urlopen",
                        lambda req, timeout: _FakeResp(b"DATA"))
    data, resolved = transfer.fetch_archive("https://x/a.autowright")
    assert data == b"DATA" and resolved == "https://x/a.autowright"

    # the byte cap aborts mid-download
    monkeypatch.setattr(transfer, "MAX_ARCHIVE_BYTES", 4)
    monkeypatch.setattr(transfer.urllib.request, "urlopen",
                        lambda req, timeout: _FakeResp(b"toolarge"))
    with pytest.raises(transfer.TransferError, match="64 MB import limit"):
        transfer.fetch_archive("https://x/a.autowright")

    # a redirect off https is refused even though the pasted URL was https
    monkeypatch.setattr(transfer, "MAX_ARCHIVE_BYTES", 64 * 1024 * 1024)
    monkeypatch.setattr(transfer.urllib.request, "urlopen",
                        lambda req, timeout: _FakeResp(b"D", url="http://x/a.autowright"))
    with pytest.raises(transfer.TransferError, match="redirected off https"):
        transfer.fetch_archive("https://x/a.autowright")


def test_preview_archive_dry_match(store, monkeypatch, tmp_path_factory):
    a = _build(store)
    data = transfer.export_automation(store, a)

    # Same machine: every secret exists, every agent config matches — dry run,
    # nothing written.
    before = (len(store.autos), len(store.secrets), len(store.agents))
    p = transfer.preview_archive(store, data)
    assert (len(store.autos), len(store.secrets), len(store.agents)) == before
    assert p["name"] == "Watcher" and p["description"] == "Watches things"
    assert [s["name"] for s in p["steps"]] == ["Fetch", "Summarize"]
    assert [s["agent"] for s in p["steps"]] == [False, True]
    assert p["params"] == [{"name": "count", "kind": "number"}]
    assert {t["kind"] for t in p["triggers"]} == {"cron", "app_start", "discord", "imessage"}
    assert all(s["exists"] for s in p["secrets"])
    assert all(g["reused"] for g in p["agents"])
    assert p["packages"] == [{"pip": "pandas", "import": "pandas", "why": "builds the table"}]

    # Fresh machine: nothing exists yet.
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    p2 = transfer.preview_archive(s2, data)
    assert not any(s["exists"] for s in p2["secrets"])
    assert not any(g["reused"] for g in p2["agents"])
    assert len(s2.autos) == 0 and not s2.secrets and not s2.agents

    # A broken archive rejects with the §5.1 message.
    with pytest.raises(transfer.TransferError, match="not a valid .autowright archive"):
        transfer.preview_archive(store, b"junk")


def test_import_grants_ride_the_creation_call(store, monkeypatch, tmp_path_factory):
    """§5.1: created grants pass directly into create_automation — no
    post-create grant patch, so no window exists in which the automation is
    stored with different grants than it ends up with. The only patch left
    seeds param values, which creation can't take."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    patches = []
    orig = s2.patch_automation
    monkeypatch.setattr(s2, "patch_automation",
                        lambda auto, patch: (patches.append(dict(patch)),
                                             orig(auto, patch))[1])
    b, _ = transfer.import_automation(s2, data)
    assert patches == [{"paramValues": {"count": 7}}]
    assert set(b["enabled_agents"]) == {g["id"] for g in s2.agents}
    created_ids = sorted(s["id"] for s in s2.secrets
                         if s["name"] in ("API_KEY", "BOT_TOKEN", "MAIL_PASS"))
    assert sorted(b["allowed_secrets"]) == created_ids
    # the grants are already in the on-disk top-level yaml (the one write)
    top = yaml.safe_load((s2.auto_dir(b) / "automation.yaml").read_text())
    assert sorted(top["allowed_secrets"]) == created_ids
    assert set(top["enabled_agents"]) == set(b["enabled_agents"])

    # an archive without values patches nothing at all; everything referenced
    # now pre-exists, so the creation call grants the empty lists (not the
    # drafting-agent fallback)
    patches.clear()
    c, _ = transfer.import_automation(
        s2, transfer.export_automation(store, a, include_values=False))
    assert patches == []
    assert c["param_values"] == {}
    assert c["enabled_agents"] == [] and c["allowed_secrets"] == []


# ---------- archive member parse rejects (§5.1 untrusted input) ----------

def test_member_yaml_and_text_parse_rejects(store):
    """§5.1: a member that is missing, non-YAML, a non-mapping, or non-UTF-8
    text is a TransferError naming the member — never a stack trace, never a
    partial import."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = len(store.autos)

    def rejects(match, edit):
        with pytest.raises(transfer.TransferError, match=match):
            transfer.import_automation(store, _rezip(data, edit))

    # manifest.yaml gone entirely (rebuild without it)
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for nm in src.namelist():
            if nm != "manifest.yaml":
                out.writestr(nm, src.read(nm))
    with pytest.raises(transfer.TransferError, match="missing manifest.yaml"):
        transfer.import_automation(store, buf.getvalue())

    rejects("manifest.yaml isn't valid YAML",
            lambda nm, b: b"{ not: [valid" if nm == "manifest.yaml" else None)
    rejects("manifest.yaml must hold a YAML mapping",
            lambda nm, b: b"- just\n- a list\n" if nm == "manifest.yaml" else None)
    # an empty member parses to {} — rejected for what it lacks (no format
    # field), not with a parse crash
    rejects("unsupported archive format None",
            lambda nm, b: b"\n" if nm == "manifest.yaml" else None)
    # spec.md is read as text — non-UTF-8 bytes are named, not decoded lossily
    rejects("automation/spec.md isn't valid UTF-8",
            lambda nm, b: b"\xff\xfe broken" if nm == "automation/spec.md" else None)
    assert len(store.autos) == before


def test_manifest_and_meta_shape_rejects(store):
    """§5.1 _validate: each malformed manifest/automation.yaml shape gets its
    own clear reject — param_values, params, packages, steps."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    before = len(store.autos)

    def manifest_edit(**over):
        def edit(nm, b):
            if nm == "manifest.yaml":
                return yaml.safe_dump({**yaml.safe_load(b), **over}).encode()
            return None
        return edit

    def meta_edit(**over):
        def edit(nm, b):
            if nm == "automation/automation.yaml":
                return yaml.safe_dump({**yaml.safe_load(b), **over}).encode()
            return None
        return edit

    cases = [
        ("manifest param_values must be a mapping", manifest_edit(param_values=[1, 2])),
        ("param definitions must be a list", meta_edit(params={"name": "x"})),
        ("invalid parameter definition", meta_edit(params=[{"name": "x", "kind": "nope"}])),
        ("invalid packages declaration", meta_edit(packages=[{"pip": "pandas"}])),
        ("the archive holds no steps", meta_edit(steps=[])),
        ("invalid step manifest entry", meta_edit(steps=[{"file": "01-a.py"}])),
    ]
    for match, edit in cases:
        with pytest.raises(transfer.TransferError, match=match):
            transfer.import_automation(store, _rezip(data, edit))
    assert len(store.autos) == before


def test_github_api_error_mapping(monkeypatch):
    """§5.2 _github_api over a faked urllib: 404 → None, 403/429 → the
    rate-limit message, other codes → the generic one, network errors →
    'couldn't reach GitHub'; a 200 parses the JSON body."""
    import json as jsonlib
    import urllib.error

    def urlopen_for(result):
        def fake(req, timeout):
            assert req.full_url.startswith("https://api.github.com/")
            if isinstance(result, Exception):
                raise result
            return _FakeResp(jsonlib.dumps(result).encode())
        return fake

    def http_error(code):
        return urllib.error.HTTPError("https://api.github.com/x", code, "err", {}, None)

    monkeypatch.setattr(transfer.urllib.request, "urlopen",
                        urlopen_for({"assets": []}))
    assert transfer._github_api("/repos/a/b/releases/latest") == {"assets": []}

    monkeypatch.setattr(transfer.urllib.request, "urlopen", urlopen_for(http_error(404)))
    assert transfer._github_api("/repos/a/b/releases/latest") is None

    for code in (403, 429):
        monkeypatch.setattr(transfer.urllib.request, "urlopen", urlopen_for(http_error(code)))
        with pytest.raises(transfer.TransferError, match="rate-limited"):
            transfer._github_api("/repos/a/b/releases/latest")

    monkeypatch.setattr(transfer.urllib.request, "urlopen", urlopen_for(http_error(500)))
    with pytest.raises(transfer.TransferError, match="GitHub answered 500"):
        transfer._github_api("/repos/a/b/releases/latest")

    monkeypatch.setattr(transfer.urllib.request, "urlopen",
                        urlopen_for(urllib.error.URLError("no route to host")))
    with pytest.raises(transfer.TransferError, match="couldn't reach GitHub"):
        transfer._github_api("/repos/a/b/releases/latest")


def test_import_without_optional_members_succeeds(store):
    """§5.1: agents.yaml / secrets.yaml are optional — a reference-free archive
    stripped of them imports with no grants created rather than being rejected.
    An archive that DOES carry references can't lose the yaml its names must
    resolve against (§5.1 identity translation) — that strip is a 422."""
    def _strip(data):
        src = zipfile.ZipFile(io.BytesIO(data))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as out:
            for nm in src.namelist():
                if nm not in ("agents.yaml", "secrets.yaml"):
                    out.writestr(nm, src.read(nm))
        return buf.getvalue()

    ver = {"description": "", "params": [], "packages": [],
           "steps": [{"name": "Only", "description": "", "code": "print('x')\n"}],
           "spec": [{"kind": "h1", "text": "T"}], "instructions": ""}
    plain = store.create_automation(ver, name="Plain", agent_id=None, triggers=[])
    agents_before = len(store.agents)
    b, summary = transfer.import_automation(
        store, _strip(transfer.export_automation(store, plain)))
    assert b["id"] in store.autos
    assert len(store.agents) == agents_before  # nothing new created
    assert summary["agentsCreated"] == [] and summary["secretsCreated"] == []
    # reference-carrying archive: the stripped yaml leaves its names dangling
    a = _build(store)
    with pytest.raises(transfer.TransferError, match="isn't listed in the archive's"):
        transfer.import_automation(store, _strip(transfer.export_automation(store, a)))


def _rezip_manifest(data, edit):
    """Rewrite manifest.yaml through `edit` (a dict → dict function)."""
    src = zipfile.ZipFile(io.BytesIO(data))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        for n in src.namelist():
            out.writestr(n, yaml.safe_dump(edit(yaml.safe_load(src.read(n)))).encode()
                         if n == "manifest.yaml" else src.read(n))
    return buf.getvalue()


def test_export_records_os_and_same_platform_round_trip(store, monkeypatch, tmp_path_factory):
    """§5.1: every export records the exporting machine's platform token; a
    same-platform import stamps §4.1 originOs and flags nothing."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    manifest = yaml.safe_load(zipfile.ZipFile(io.BytesIO(data)).read("manifest.yaml"))
    assert manifest["os"] == "macos"
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    pv = transfer.preview_archive(s2, data)
    assert (pv["os"], pv["osMismatch"]) == ("macos", False)
    b, summary = transfer.import_automation(s2, data)
    assert (summary["os"], summary["osMismatch"]) == ("macos", False)
    assert b["origin_os"] == "macos"
    assert not any(p["kind"] == "os-mismatch" for p in s2.auto_json(b)["problems"])


def test_import_from_another_os_flags_needs_fixing(store, monkeypatch, tmp_path_factory):
    """§5.1/§4.1: a foreign platform token never rejects — it stamps originOs,
    rides preview/summary as osMismatch, and surfaces as the os-mismatch
    problem until an edit save clears it (a §5 reload keeps it)."""
    a = _build(store)
    win = _rezip_manifest(transfer.export_automation(store, a),
                          lambda m: {**m, "os": "windows"})
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    pv = transfer.preview_archive(s2, win)
    assert (pv["os"], pv["osMismatch"]) == ("windows", True)
    b, summary = transfer.import_automation(s2, win)
    assert (summary["os"], summary["osMismatch"]) == ("windows", True)
    assert b["origin_os"] == "windows"
    os_rows = [p for p in s2.auto_json(b)["problems"] if p["kind"] == "os-mismatch"]
    assert os_rows == [{"kind": "os-mismatch",
                        "label": "Built on Windows — its steps may need rewriting "
                                 "before they run on this Mac."}]
    # §5 disk-first: originOs survives a reload …
    s3 = Store()
    s3.load_all()
    b2 = s3.autos[b["id"]]
    assert b2["origin_os"] == "windows"
    # … and an edit save clears it (§4.1: a local rework supersedes
    # "built elsewhere")
    s3.save_new_version(b2, dict(b2["versions"][1]))
    assert "origin_os" not in b2
    s4 = Store()
    s4.load_all()
    assert "origin_os" not in s4.autos[b["id"]]


def test_import_os_token_rules(store, monkeypatch, tmp_path_factory):
    """§5.1: an absent token is legal (older archives — nothing stamps, nothing
    flags); an unrecognized token is legal and always mismatches (label shows
    it verbatim); a malformed token rejects."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    legacy = _rezip_manifest(data, lambda m: {k: v for k, v in m.items() if k != "os"})
    pv = transfer.preview_archive(s2, legacy)
    assert (pv["os"], pv["osMismatch"]) == (None, False)
    b, summary = transfer.import_automation(s2, legacy)
    assert (summary["os"], summary["osMismatch"]) == (None, False)
    assert "origin_os" not in b
    assert not any(p["kind"] == "os-mismatch" for p in s2.auto_json(b)["problems"])
    unknown = _rezip_manifest(data, lambda m: {**m, "os": "beos"})
    b2, summary2 = transfer.import_automation(s2, unknown)
    assert (summary2["os"], summary2["osMismatch"]) == ("beos", True)
    row = next(p for p in s2.auto_json(b2)["problems"] if p["kind"] == "os-mismatch")
    assert "Built on beos" in row["label"]
    with pytest.raises(transfer.TransferError, match="os must be a non-empty string"):
        transfer.import_automation(s2, _rezip_manifest(data, lambda m: {**m, "os": "  "}))


def test_failed_import_leaves_no_orphan_secrets_or_agents(store, monkeypatch,
                                                          tmp_path_factory):
    """§5.1: import writes nothing on failure. Secrets and agents land before
    the automation exists (their ids are what its steps reference), so a
    failure at creation time has to take them back out."""
    a = _build(store)
    data = transfer.export_automation(store, a)
    s2 = _fresh_home(monkeypatch, tmp_path_factory)
    assert s2.secrets == [] and s2.agents == []

    real_create = s2.create_automation

    def boom(*args, **kwargs):
        raise OSError("disk on fire")

    s2.create_automation = boom
    with pytest.raises(OSError):
        transfer.import_automation(s2, data)
    assert s2.secrets == [] and s2.agents == []
    assert s2.default_agent_id is None
    assert s2.autos == {}

    # the files on disk match memory - a reload sees nothing either
    s3 = Store()
    s3.load_all()
    assert s3.secrets == [] and s3.agents == []

    # and the retry lands cleanly, with no duplicates from the failed attempt
    s2.create_automation = real_create
    transfer.import_automation(s2, data)
    assert sorted(s["name"] for s in s2.secrets) == ["API_KEY", "BOT_TOKEN", "MAIL_PASS"]
    assert len(s2.agents) == 2
