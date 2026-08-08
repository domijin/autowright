"""Transfer archives (§5.1): export/import round-trips, grant rules, rejection."""
import io
import zipfile

import pytest
import yaml

from autowright import transfer
from autowright.storage import Store, new_id


def _agent(name, harness="Claude Code", mode="default", model=None):
    return {"id": new_id(), "name": name, "description": "", "harness": harness,
            "mode": mode, "model": model}


def _build(store: Store):
    """An automation exercising every archive surface: params + values, cron +
    app_start + time triggers, an agent step, declared + code-referenced secrets."""
    store.agents = [_agent("Researcher"),
                    _agent("Coder", harness="OpenCode", mode="custom", model="anthropic/x")]
    store.default_agent_id = store.agents[0]["id"]  # §4.7 single pointer
    store.save_agents()
    store.secrets = [{"name": "API_KEY", "description": "service key", "set": True},
                     {"name": "BOT_TOKEN", "description": "discord bot", "set": True},
                     {"name": "MAIL_PASS", "description": "mail", "set": True}]
    store.save_secrets()
    ver = {
        "description": "Watches things",
        "params": [{"name": "count", "kind": "number", "label": "Count", "help": "", "default": 3}],
        "packages": [{"pip": "pandas", "import": "pandas", "why": "builds the table"}],
        "steps": [
            {"name": "Fetch", "description": "", "code": "from autowright import secrets\nx = secrets.API_KEY\n",
             "secrets": [{"name": "MAIL_PASS", "why": "sends the mail"}]},
            {"name": "Summarize", "description": "", "code": "print('hi')\n",
             "agent": True, "why": "judgment", "agents": [{"name": "Coder"}]},
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
                   "secret": "BOT_TOKEN", "pattern": "go", "author": ["111", "777"]},
                  {"id": new_id(), "kind": "imessage", "enabled": True,
                   "from": "+15551234567", "pattern": "run"}],
        enabled_agents=[g["id"] for g in store.agents],
        allowed_secrets=["API_KEY", "MAIL_PASS"])
    store.patch_automation(a, {"paramValues": {"count": 7}})
    return a


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
    # everything the exporter wrote survives verbatim
    assert b["versions"][1]["spec"] == a["versions"][1]["spec"]
    assert [s["code"] for s in b["versions"][1]["steps"]] == \
        [s["code"] for s in a["versions"][1]["steps"]]
    assert b["versions"][1]["instructions"] == "Keep it short."
    assert b["param_values"] == {"count": 7}
    # every trigger lands off, with fresh ids — message triggers keep their fields
    assert all(not t["enabled"] for t in b["triggers"])
    assert {t["kind"] for t in b["triggers"]} == {"cron", "app_start", "discord", "imessage"}
    d = next(t for t in b["triggers"] if t["kind"] == "discord")
    assert (d["channel"], d["secret"], d["pattern"], d["author"]) == \
        ("42", "BOT_TOKEN", "go", ["111", "777"])
    im = next(t for t in b["triggers"] if t["kind"] == "imessage")
    assert (im["from"], im["pattern"]) == ("+15551234567", "run")
    # secrets became placeholders, agents were created — and only those granted
    assert summary["secretsCreated"] == ["API_KEY", "BOT_TOKEN", "MAIL_PASS"]
    assert summary["secretsExisting"] == []
    assert sorted(summary["agentsCreated"]) == ["Coder", "Researcher"]
    assert all(not s["set"] for s in s2.secrets)
    assert sorted(b["allowed_secrets"]) == ["API_KEY", "BOT_TOKEN", "MAIL_PASS"]
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
    # same name, different config → a second record with the same name (§5.1)
    coder = next(g for g in store.agents if g["name"] == "Coder")
    coder["mode"], coder["model"] = "default", None
    store.save_agents()
    b, summary = transfer.import_automation(store, data)
    assert summary["agentsCreated"] == ["Coder"]
    assert summary["agentsReused"] == ["Researcher"]
    coders = [g for g in store.agents if g["name"] == "Coder"]
    assert len(coders) == 2
    created = next(g for g in coders if g["mode"] == "custom")
    assert b["enabled_agents"] == [created["id"]]


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
