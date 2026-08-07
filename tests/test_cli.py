"""`autowright` CLI (§2/§3/§20): Client bootstrap errors, lookups, log follow,
and the command layer — every cmd_* driven through the real parser.

No real server anywhere — the Client's request layer is faked/stubbed.
"""
import copy
import io
import json

import pytest


# ---------------------------------------------------------------- Client boot

def test_client_exits_cleanly_when_backend_json_missing(home):
    from autowright import cli

    with pytest.raises(SystemExit) as ei:
        cli.Client()
    # sys.exit(str) → message is the exit code, printed to stderr — no traceback
    assert "backend isn't up" in str(ei.value.code)
    assert "no backend.json" in str(ei.value.code)


def test_client_exits_cleanly_on_stale_backend_json(home):
    # Staleness is detected by parse: a SIGKILL'd backend leaves a truncated
    # or garbage backend.json. (A well-formed file with a dead port passes the
    # constructor — that failure surfaces at request time, not here.)
    from autowright import cli, paths

    bj = paths.backend_json()
    bj.write_text('{"port": 51')  # truncated mid-write
    with pytest.raises(SystemExit) as ei:
        cli.Client()
    assert "stale or unreadable" in str(ei.value.code)

    bj.write_text(json.dumps({"pid": 999}))  # valid JSON, keys gone
    with pytest.raises(SystemExit) as ei:
        cli.Client()
    assert "stale or unreadable" in str(ei.value.code)


def test_client_reads_port_and_token_from_backend_json(home):
    from autowright import cli, paths

    paths.backend_json().write_text(json.dumps({"port": 5151, "token": "tok"}))
    c = cli.Client()
    assert c.base == "http://127.0.0.1:5151"
    assert c.token == "tok"


# ---------------------------------------------------------------- find_automation

class _ListClient:
    """Stub standing in for Client — find_automation only calls req GET /automations."""

    def __init__(self, autos):
        self.autos = autos

    def req(self, method, path, body=None):
        assert (method, path) == ("GET", "/automations")
        return self.autos


AUTOS = [
    {"id": "abc12345", "name": "Daily Report"},
    {"id": "def67890", "name": "Weekly Report"},
    {"id": "ghi00000", "name": "Backup"},
]


def test_find_auto_exact_id():
    from autowright.cli import find_automation

    assert find_automation(_ListClient(AUTOS), "abc12345")["name"] == "Daily Report"


def test_find_auto_exact_name_case_insensitive():
    from autowright.cli import find_automation

    assert find_automation(_ListClient(AUTOS), "dAiLy RePoRt")["id"] == "abc12345"


def test_find_auto_unique_substring():
    from autowright.cli import find_automation

    assert find_automation(_ListClient(AUTOS), "back")["id"] == "ghi00000"
    assert find_automation(_ListClient(AUTOS), "week")["id"] == "def67890"


def test_find_auto_ambiguous_substring_exits():
    from autowright.cli import find_automation

    with pytest.raises(SystemExit) as ei:
        find_automation(_ListClient(AUTOS), "report")  # Daily + Weekly both match
    msg = str(ei.value.code)
    assert "no unique automation" in msg
    assert "Daily Report" in msg and "Weekly Report" in msg


def test_find_auto_no_match_exits():
    from autowright.cli import find_automation

    with pytest.raises(SystemExit) as ei:
        find_automation(_ListClient([]), "zzz")
    assert "(none)" in str(ei.value.code)


# ---------------------------------------------------------------- follow_exec

class _FollowClient:
    """Scripted two-poll client: overlapping exec-log seqs across polls, and
    one step attempt that is terminal from the first poll onward."""

    def __init__(self):
        self.poll = 0
        self.step_log_fetches = 0

    @staticmethod
    def _ln(seq, text):
        return {"seq": seq, "t": f"T{seq}", "k": "log", "text": text}

    def req(self, method, path, body=None):
        assert method == "GET"
        if path == "/executions/e1":
            self.poll += 1
            return {
                "status": "executing" if self.poll == 1 else "succeeded",
                "dur": "2s",
                "steps": [{"attempts": [{"n": 1, "status": "ok"}]}],  # terminal
            }
        if path == "/executions/e1/logs":
            if self.poll == 1:
                return {"lines": [self._ln(1, "alpha"), self._ln(2, "beta")]}
            # poll 2 re-serves seqs 1-2 plus the new 3 — dedupe must hold
            return {"lines": [self._ln(1, "alpha"), self._ln(2, "beta"),
                              self._ln(3, "gamma")]}
        if path == "/executions/e1/logs?step=0&attempt=1":
            self.step_log_fetches += 1
            return {"lines": [self._ln(1, "step line")]}
        raise AssertionError(f"unexpected request: {path}")


def test_follow_exec_dedupes_seqs_and_settles_terminal_attempts(monkeypatch, capsys):
    from autowright import cli

    monkeypatch.setattr(cli.time, "sleep", lambda s: None)
    c = _FollowClient()
    cli.follow_exec(c, "e1")
    out = capsys.readouterr().out.splitlines()
    assert out == [
        "  T1 [log] alpha",
        "  T2 [log] beta",
        "  T1 [log] step line",
        "  T3 [log] gamma",          # only the new seq on poll 2
        "→ succeeded in 2s",
    ]
    assert out.count("  T1 [log] alpha") == 1  # overlapping seqs printed once
    # terminal attempt settled after its first fetch — never re-downloaded
    assert c.step_log_fetches == 1


# ---------------------------------------------------------------- workdir (§20)

FULL_AUTO = {
    "id": "abc12345-0000-0000-0000-000000000000", "name": "Daily Report",
    "desc": "Reports daily", "instr": "- keep it short",
    "spec": [{"k": "h1", "text": "Daily Report"}, {"k": "p", "text": "Fetch and report."}],
    "triggers": [
        {"id": "t1", "kind": "cron", "expr": "0 8 * * *", "off": True, "tz": "Asia/Tokyo",
         "label": "Daily at 8:00 (Tokyo)", "short": "Daily 8:00 (Tokyo)"},
        {"id": "t2", "kind": "app_start", "off": False, "label": "On app start",
         "short": "App start"},
    ],
    "params": [{"name": "sources", "kind": "list", "label": "URLs", "default": [],
                "lines": ["https://a.example/x"]}],
    "packages": [],
    "steps": [{"file": "01-fetch.py", "name": "Fetch", "desc": "fetch pages",
               "code": "import json\nprint('hi')\n", "secrets": ["API_TOKEN"]}],
    "stepAgents": [], "allowedSecrets": ["API_TOKEN"],
}


class _WorkdirClient:
    """Recorded stub: GET answers from a small table, writes are captured."""

    def __init__(self, auto=None, install_result=None):
        self.auto = auto or FULL_AUTO
        self.posted = []
        self.install_result = install_result

    def req(self, method, path, body=None):
        if method == "GET" and path == "/automations":
            return [self.auto]
        if method == "GET" and path == f"/automations/{self.auto['id']}":
            return self.auto
        if method == "GET" and path == "/agents":
            return [{"id": "ag1", "name": "Fast local", "harness": "OpenCode",
                     "model": "qwen3"}]
        if method == "GET" and path == "/secrets":
            return [{"name": "API_TOKEN", "set": True, "usedBy": []}]  # §4.8: a list
        self.posted.append((method, path, body))
        if method == "POST" and path == "/packages/install":
            return {"packages": self.install_result or []}
        return {"version": 2, "execId": "e9", "id": "new-id", "name": "Daily Report",
                "triggers": [{}], "triggerChip": "2 triggers"}


def test_workdir_pull_push_round_trip(tmp_path):
    """pull writes the §20 workdir; an untouched push round-trips: same spec
    blocks, same steps, and the stored trigger list unchanged (§4.3 merge keeps
    ids/off on matched crons and every non-cron trigger)."""
    from autowright import cli

    c = _WorkdirClient()
    d = tmp_path / "wd"
    written = cli.write_workdir(d, FULL_AUTO)
    assert set(written) == {"spec.md", "manifest.yaml", "01-fetch.py", "instructions.md"}
    assert (d / "spec.md").read_text().startswith("# Daily Report")

    draft = cli.validate_workdir(c, d)
    assert draft["spec"] == FULL_AUTO["spec"]
    assert draft["instr"] == "- keep it short"
    assert [s["file"] for s in draft["steps"]] == ["01-fetch.py"]
    assert draft["steps"][0]["code"] == "import json\nprint('hi')\n"
    assert draft["steps"][0]["secrets"] == ["API_TOKEN"]

    merged = cli.merge_draft_triggers(FULL_AUTO["triggers"], draft["triggers"])
    assert {t["kind"] for t in merged} == {"cron", "app_start"}
    cron = next(t for t in merged if t["kind"] == "cron")
    assert cron["id"] == "t1" and cron["off"] is True  # matched: keeps id + off state


def test_workdir_notes_round_trip(tmp_path):
    """§20: pull writes notes.md when the automation has notes; push reads it
    back and saves it verbatim into the draft."""
    from autowright import cli

    auto = {**FULL_AUTO, "notes": "watch the rate limit"}
    d = tmp_path / "wd"
    written = cli.write_workdir(d, auto)
    assert set(written) == {"spec.md", "manifest.yaml", "01-fetch.py",
                            "instructions.md", "notes.md"}
    assert (d / "notes.md").read_text() == "watch the rate limit\n"

    draft = cli.validate_workdir(_WorkdirClient(auto), d)
    assert draft["notes"] == "watch the rate limit"

    c = _WorkdirClient(auto)
    _run(c, "automation", "push", "Daily Report", str(d))
    _method, path, body = c.posted[-1]
    assert path == f"/automations/{auto['id']}/versions"
    assert body["draft"]["notes"] == "watch the rate limit"

    # no notes → no notes.md written on pull
    d2 = tmp_path / "wd2"
    assert "notes.md" not in cli.write_workdir(d2, FULL_AUTO)
    assert not (d2 / "notes.md").exists()


def test_workdir_manifest_step_camel_flags_become_snake(tmp_path):
    """§20: the CLI pulls API step JSON (camelCase noTimeout/infiniteRetries)
    — the written manifest and the pushed draft carry the snake_case internal
    spellings."""
    import yaml

    from autowright import cli

    step = {**FULL_AUTO["steps"][0], "noTimeout": True, "infiniteRetries": True}
    auto = {**FULL_AUTO, "steps": [step]}
    d = tmp_path / "wd"
    cli.write_workdir(d, auto)
    manifest = yaml.safe_load((d / "manifest.yaml").read_text())
    assert manifest["steps"][0]["no_timeout"] is True
    assert manifest["steps"][0]["infinite_retries"] is True
    assert "noTimeout" not in manifest["steps"][0]
    assert "infiniteRetries" not in manifest["steps"][0]

    draft = cli.validate_workdir(_WorkdirClient(auto), d)
    assert draft["steps"][0]["no_timeout"] is True
    assert draft["steps"][0]["infinite_retries"] is True


def test_workdir_params_round_trip_without_values(tmp_path):
    """§20: pulled manifests carry definitions with defaults, never the
    resolved value fields — values are user-owned, set via `param set`."""
    import yaml

    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, FULL_AUTO)
    manifest = yaml.safe_load((d / "manifest.yaml").read_text())
    assert manifest["params"] == [{"name": "sources", "kind": "list", "label": "URLs",
                                  "default": []}]
    assert manifest["triggers"] == [{"cron": "0 8 * * *", "tz": "Asia/Tokyo"}]


def test_validate_workdir_prints_errors_and_exits(tmp_path, capsys):
    from autowright import cli

    d = tmp_path / "wd"
    d.mkdir()
    (d / "spec.md").write_text("no title, just prose\n")
    (d / "manifest.yaml").write_text("steps:\n  - { file: 01-x.py, name: X }\n")
    (d / "01-x.py").write_text("import os\ndef broken(:\n")
    with pytest.raises(SystemExit) as ei:
        cli.validate_workdir(_WorkdirClient(), d)
    assert ei.value.code == 1
    err = capsys.readouterr().err
    assert "must start with a # title" in err
    assert "syntax error" in err


def test_push_and_create_install_declared_packages(tmp_path, capsys):
    """§20: a successful push/create runs the §6.2 ensure for the declared
    packages and prints per-package status; a failure warns, the save stands."""
    from types import SimpleNamespace

    from autowright import cli

    auto = copy.deepcopy(FULL_AUTO)
    auto["packages"] = [{"pip": "pandas", "import": "pandas"},
                        {"pip": "ghostlib", "import": "ghostlib"}]
    result = [
        {"pip": "pandas", "import": "pandas", "status": "installed", "version": "2.2.0"},
        {"pip": "ghostlib", "import": "ghostlib", "status": "failed",
         "error": "no matching distribution"}]
    d = tmp_path / "wd"
    cli.write_workdir(d, auto)

    c = _WorkdirClient(auto, install_result=result)
    cli.cmd_automation_push(c, SimpleNamespace(
        automation="Daily Report", dir=str(d), note=None,
        grant_agent=[], grant_secret=[]))
    out = capsys.readouterr().out
    assert "saved 'Daily Report' as v2" in out
    assert "package pandas 2.2.0 installed" in out
    assert "warning: package ghostlib failed to install — no matching distribution" in out
    _, _, body = next(p for p in c.posted if p[1] == "/packages/install")
    assert body == {"packages": auto["packages"]}

    c = _WorkdirClient(auto, install_result=result)
    cli.cmd_automation_create(c, SimpleNamespace(
        dir=str(d), name=None, agent=None,
        grant_agent=[], grant_secret=["API_TOKEN"]))
    out = capsys.readouterr().out
    assert "package pandas 2.2.0 installed" in out
    assert "warning: package ghostlib failed to install" in out
    assert any(p[1] == "/packages/install" for p in c.posted)


def test_push_without_packages_skips_install(tmp_path, capsys):
    """§20: no declared packages → no install call, nothing printed."""
    from types import SimpleNamespace

    from autowright import cli

    c = _WorkdirClient()
    d = tmp_path / "wd"
    cli.write_workdir(d, FULL_AUTO)
    cli.cmd_automation_push(c, SimpleNamespace(
        automation="Daily Report", dir=str(d), note=None,
        grant_agent=[], grant_secret=[]))
    assert not any(p[1] == "/packages/install" for p in c.posted)
    assert "package" not in capsys.readouterr().out


def test_import_installs_declared_packages(tmp_path, capsys):
    """§20: import runs the ensure for the summary's declared packages instead
    of deferring them to the first execution."""
    from types import SimpleNamespace

    from autowright import cli

    c = _WorkdirClient(install_result=[
        {"pip": "pandas", "import": "pandas", "status": "installed", "version": "2.2.0"}])
    c.req_raw = lambda method, path, data=None: json.dumps(
        {"auto": {"name": "Shared", "id": "abcd1234-0000"},
         "summary": {"packages": [{"pip": "pandas", "import": "pandas"}]}}).encode()
    f = tmp_path / "x.autowright"
    f.write_bytes(b"archive")
    cli.cmd_automation_import(c, SimpleNamespace(path=str(f)))
    out = capsys.readouterr().out
    assert "package pandas 2.2.0 installed" in out
    _, _, body = next(p for p in c.posted if p[1] == "/packages/install")
    assert body == {"packages": [{"pip": "pandas", "import": "pandas"}]}


def test_merge_draft_triggers_drops_unlisted_and_adds_new():
    from autowright import cli

    stored = [{"id": "t1", "kind": "cron", "expr": "0 8 * * *", "off": True},
              {"id": "t3", "kind": "time", "at": "2027-01-01T09:00", "off": False},
              {"id": "t4", "kind": "discord", "channel": "1", "secret": "S", "off": False}]
    drafted = [{"kind": "cron", "expr": "0 9 * * 1", "off": False}]
    merged = cli.merge_draft_triggers(stored, drafted)
    # one-shot and discord survive, the unlisted cron drops, the new cron arrives enabled
    assert [(t["kind"], t.get("expr") or t.get("at") or t.get("channel")) for t in merged] == [
        ("time", "2027-01-01T09:00"), ("discord", "1"), ("cron", "0 9 * * 1")]


def test_merge_draft_triggers_message_entries_additive():
    from autowright import cli

    stored = [{"id": "t1", "kind": "imessage", "from": "+15551234567", "off": True},
              {"id": "t2", "kind": "discord", "channel": "1", "secret": "S", "off": False}]
    drafted = [{"kind": "imessage", "from": "+15551234567", "off": False},   # matches t1
               {"kind": "imessage", "from": "a@b.co", "off": False},          # new → adds
               {"kind": "discord", "channel": "1", "secret": "S", "off": False,
                "pattern": "go"},                                             # pattern differs → adds
               {"kind": "discord", "channel": "1", "secret": "S", "off": False,
                "author": "777"},                                             # author differs → adds
               {"kind": "time", "at": "2030-01-01T09:00", "off": False}]      # never drafted → dropped
    merged = cli.merge_draft_triggers(stored, drafted)
    assert [(t["kind"], t.get("id")) for t in merged] == [
        ("imessage", "t1"), ("discord", "t2"), ("imessage", None), ("discord", None),
        ("discord", None)]
    assert merged[0]["off"] is True  # matched entry keeps its off state


def test_trigger_add_discord():
    from types import SimpleNamespace

    from autowright import cli

    c = _WorkdirClient()
    cli.cmd_trigger_add(c, SimpleNamespace(
        automation="Daily Report", discord="123", secret="BOT_TOKEN",
        pattern="go", mention=True, author="777", imessage=None, app_start=False,
        at=None, expr=None, tz=None))
    method, path, body = c.posted[-1]
    assert (method, path) == ("PATCH", f"/automations/{FULL_AUTO['id']}")
    assert body["triggers"][-1] == {"kind": "discord", "channel": "123",
                                    "secret": "BOT_TOKEN", "pattern": "go",
                                    "mention": True, "author": "777", "off": False}
    # --discord without --secret exits with guidance, nothing sent
    with pytest.raises(SystemExit):
        cli.cmd_trigger_add(c, SimpleNamespace(
            automation="Daily Report", discord="123", secret=None, pattern=None,
            mention=False, author=None, imessage=None, app_start=False,
            at=None, expr=None, tz=None))


def test_trigger_add_imessage():
    from types import SimpleNamespace

    from autowright import cli

    c = _WorkdirClient()
    cli.cmd_trigger_add(c, SimpleNamespace(
        automation="Daily Report", discord=None, secret=None,
        pattern="deploy", mention=False, imessage="+15551234567",
        app_start=False, at=None, expr=None, tz=None))
    method, path, body = c.posted[-1]
    assert (method, path) == ("PATCH", f"/automations/{FULL_AUTO['id']}")
    assert body["triggers"][-1] == {"kind": "imessage", "from": "+15551234567",
                                    "pattern": "deploy", "off": False}


# ---------------------------------------------------------------- param parsing

@pytest.mark.parametrize("kind,raw,expected", [
    ("toggle", "on", True), ("toggle", "false", False),
    ("number", "42", 42),
    ("text", "hello there", "hello there"),
    ("list", "a, b, c", ["a", "b", "c"]),
    ("list", '["x", "y"]', ["x", "y"]),
    ("kv", "k1=v1,k2=v2", [{"k": "k1", "v": "v1"}, {"k": "k2", "v": "v2"}]),
    ("kv", '{"k1": "v1"}', [{"k": "k1", "v": "v1"}]),
])
def test_parse_param_value(kind, raw, expected):
    from autowright import cli

    assert cli.parse_param_value({"name": "p", "kind": kind}, raw) == expected


@pytest.mark.parametrize("kind,raw", [
    ("toggle", "maybe"), ("number", "ten"), ("list", '[1, 2]'), ("kv", "novalue"),
])
def test_parse_param_value_rejects_bad_input(kind, raw):
    from autowright import cli

    with pytest.raises(SystemExit):
        cli.parse_param_value({"name": "p", "kind": kind}, raw)


# ---------------------------------------------------------------- exit codes

def test_followed_execution_failure_exits_2(monkeypatch, capsys):
    """§20: `automation execute -f` / `execution tail` exit 2 when the followed
    execution ends other than succeeded — harnesses branch on the code."""
    from autowright import cli

    class _FailClient:
        def req(self, method, path, body=None):
            if path == "/executions/e1":
                return {"status": "failed", "dur": "3s", "steps": []}
            return {"lines": []}

    with pytest.raises(SystemExit) as ei:
        cli._exit_by_status(cli.follow_exec(_FailClient(), "e1"))
    assert ei.value.code == 2
    assert "→ failed in 3s" in capsys.readouterr().out


def test_client_exits_cleanly_when_backend_port_is_dead(home):
    """§3: a well-formed backend.json pointing at a dead backend (SIGKILL
    leftovers) exits with restart guidance at request time — never a traceback."""
    import socket

    from autowright import cli, paths

    # A port that was just bound and released: connection refused, instantly.
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    paths.backend_json().write_text(json.dumps({"port": port, "token": "tok"}))
    c = cli.Client()
    with pytest.raises(SystemExit) as ei:
        c.req("GET", "/automations")
    assert "backend isn't reachable" in str(ei.value.code)
    assert "service restart" in str(ei.value.code)
    with pytest.raises(SystemExit) as ei:
        c.req_raw("GET", "/automations/x/export")
    assert "backend isn't reachable" in str(ei.value.code)


# ---------------------------------------------------------------- find_execution

class _ExecListClient:
    def __init__(self, execs):
        self.execs = execs

    def req(self, method, path, body=None):
        assert (method, path) == ("GET", "/executions")
        return self.execs


EXECS = [{"id": "e1111111-a"}, {"id": "e2222222-b"}, {"id": "f3333333-c"}]


def test_find_execution_defaults_to_latest():
    from autowright.cli import find_execution

    assert find_execution(_ExecListClient(EXECS), None)["id"] == "e1111111-a"


def test_find_execution_no_executions_exits():
    from autowright.cli import find_execution

    with pytest.raises(SystemExit) as ei:
        find_execution(_ExecListClient([]), None)
    assert "no execution found" in str(ei.value.code)


def test_find_execution_by_unique_prefix_and_ambiguity():
    from autowright.cli import find_execution

    assert find_execution(_ExecListClient(EXECS), "f3")["id"] == "f3333333-c"
    with pytest.raises(SystemExit) as ei:
        find_execution(_ExecListClient(EXECS), "e")  # two matches
    assert "no unique execution" in str(ei.value.code)


# ---------------------------------------------------------------- command layer

class _RouteClient:
    """Routing stub: GET answers come from a table (deep-copied so commands
    that mutate records can't leak across tests); writes are recorded and
    answered with `reply`; req_raw returns `raw` bytes."""

    base = "http://127.0.0.1:5151"

    def __init__(self, gets=None, reply=None, raw=b""):
        self.gets = {k: copy.deepcopy(v) for k, v in (gets or {}).items()}
        self.reply, self.raw = reply or {}, raw
        self.calls = []

    def req(self, method, path, body=None):
        if method == "GET":
            assert path in self.gets, f"unexpected GET {path}"
            return self.gets[path]
        self.calls.append((method, path, body))
        return self.reply

    def req_raw(self, method, path, data=None):
        self.calls.append((method, path, data))
        return self.raw


AUTO_ID = FULL_AUTO["id"]


def _auto_gets(auto=None, **extra):
    a = auto or FULL_AUTO
    return {"/automations": [a], f"/automations/{a['id']}": a, **extra}


def _run(client, *argv):
    """Parse real argv through build_parser and dispatch — covers the parser
    wiring and the command in one go."""
    from autowright import cli

    args = cli.build_parser(full=True).parse_args(list(argv))
    args.fn(client, args)
    return args


def test_parser_marks_service_as_clientless():
    from autowright import cli

    assert cli.build_parser(full=True).parse_args(["service", "status"]).client is False
    assert cli.build_parser(full=True).parse_args(["status"]).client is True


def test_shipped_cli_exposes_the_full_surface():
    """§20: the CLI is enabled — the parser main() ships is the full one."""
    from autowright import cli

    assert cli.CLI_ENABLED is True
    ap = cli.build_parser()  # the parser main() actually ships
    assert ap.parse_args(["service", "status"]).client is False
    assert ap.parse_args(["automation", "list"]).client is True
    assert ap.parse_args(["secret", "list"]).client is True


def test_disabled_parser_shape_exposes_only_service():
    """The CLI_ENABLED=False shape stays testable: only `service` registers."""
    import contextlib

    from autowright import cli

    ap = cli.build_parser(full=False)
    assert ap.parse_args(["service", "status"]).client is False

    for argv in (["status"], ["automation", "list"], ["secret", "list"],
                 ["secret", "set", "TOKEN"], ["execution", "list"],
                 ["automation", "execute", "x"], ["settings", "show"],
                 ["agent", "list"], ["instructions"]):
        with pytest.raises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            ap.parse_args(argv)


def test_cmd_status_prints_counts_and_json(capsys):
    gets = {"/health": {"version": "1.2.3"},
            "/state": {"autos": [1], "execs": [1, 2], "agents": [], "secrets": [1],
                       "pendingDraft": {"name": "New thing"}}}
    _run(_RouteClient(gets), "status")
    out = capsys.readouterr().out
    assert "backend 1.2.3 at http://127.0.0.1:5151" in out
    assert "1 automations · 2 executions · 0 agents · 1 secrets" in out
    assert "pending create draft: New thing" in out

    _run(_RouteClient(gets), "status", "--json")
    assert json.loads(capsys.readouterr().out)["version"] == "1.2.3"


def test_cmd_instructions_prints_framework_text(capsys):
    gets = {"/instructions": {"framework": "## Contract\nrules here"}}
    _run(_RouteClient(gets), "instructions")
    assert "## Contract" in capsys.readouterr().out
    _run(_RouteClient(gets), "instructions", "--json")
    assert json.loads(capsys.readouterr().out) == {"framework": "## Contract\nrules here"}


def test_cmd_automation_list_row_format_and_json(capsys):
    autos = [{"id": "abc12345-x", "name": "Daily Report", "triggerChip": "Daily 8:00",
              "triggersOff": True, "lastStatus": "succeeded", "resultChip": "3 new"}]
    _run(_RouteClient({"/automations": autos}), "automation", "list")
    out = capsys.readouterr().out
    assert "Daily Report" in out and "Daily 8:00 (off)" in out
    assert "succeeded" in out and "3 new" in out and "[abc12345]" in out

    _run(_RouteClient({"/automations": autos}), "automation", "list", "--json")
    assert json.loads(capsys.readouterr().out) == autos


def test_cmd_automation_show_prints_record(capsys):
    full = dict(FULL_AUTO, specMeta="v2 · edited today", lastStatus="failed",
                resultChip="0 new", versions=[{"v": 1}, {"v": 2}], draft={"x": 1},
                triggers=[{"kind": "cron", "label": "Daily at 8:00", "off": True}])
    _run(_RouteClient(_auto_gets(full)), "automation", "show", "Daily Report")
    out = capsys.readouterr().out
    assert f"Daily Report [{AUTO_ID}] — v2 · edited today" in out
    assert "status: failed · 0 new" in out
    assert "trigger 1: Daily at 8:00 (off)" in out
    assert "param sources (list): ['https://a.example/x']" in out
    assert "step 1: Fetch [secrets: API_TOKEN]" in out
    assert "history: v1, v2" in out
    assert "has an unsaved draft" in out


def test_cmd_automation_delete_needs_yes(capsys):
    c = _RouteClient(_auto_gets())
    with pytest.raises(SystemExit) as ei:
        _run(c, "automation", "delete", "Daily Report")
    assert "--yes" in str(ei.value.code)
    assert c.calls == []  # nothing sent without confirmation

    _run(c, "automation", "delete", "Daily Report", "--yes")
    assert c.calls == [("DELETE", f"/automations/{AUTO_ID}", None)]
    assert "deleted 'Daily Report'" in capsys.readouterr().out


def test_cmd_automation_restore_parses_vN(capsys):
    c = _RouteClient(_auto_gets(), reply={"version": 5})
    _run(c, "automation", "restore", "Daily Report", "v3")
    assert c.calls == [("POST", f"/automations/{AUTO_ID}/restore", {"v": 3})]
    assert "restored v3 of 'Daily Report' as v5" in capsys.readouterr().out

    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(_auto_gets()), "automation", "restore", "Daily Report", "latest")
    assert "version must be vN" in str(ei.value.code)


def test_cmd_automation_execute_posts_manual_trigger(capsys):
    c = _RouteClient(_auto_gets(), reply={"execId": "e9"})
    _run(c, "automation", "execute", "Daily Report")
    assert c.calls == [("POST", f"/automations/{AUTO_ID}/execute", {"trigger": "manual"})]
    assert "started — execution e9" in capsys.readouterr().out

    c = _RouteClient(_auto_gets(), reply={"execId": "e9"})
    _run(c, "automation", "execute", "Daily Report", "--version", "draft")
    assert c.calls[-1][2] == {"trigger": "manual", "version": "draft"}


def test_cmd_automation_export_writes_archive(tmp_path, capsys):
    c = _RouteClient(_auto_gets(), raw=b"ZIPDATA")
    out_file = tmp_path / "out.autowright"
    _run(c, "automation", "export", "Daily Report", str(out_file), "--no-values")
    assert c.calls == [("GET", f"/automations/{AUTO_ID}/export?values=0", None)]
    assert out_file.read_bytes() == b"ZIPDATA"
    assert "exported 'Daily Report'" in capsys.readouterr().out


def test_cmd_automation_export_default_filename(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    c = _RouteClient(_auto_gets(), raw=b"Z")
    _run(c, "automation", "export", "Daily Report")
    assert c.calls == [("GET", f"/automations/{AUTO_ID}/export", None)]  # values kept
    assert (tmp_path / "Daily Report.autowright").read_bytes() == b"Z"


def test_cmd_automation_import_prints_summary(tmp_path, capsys):
    src = tmp_path / "in.autowright"
    src.write_bytes(b"ARCHIVE")
    raw = json.dumps({
        "auto": {"name": "Imported", "id": "deadbeef-1"},
        "summary": {"secretsCreated": ["BOT_TOKEN"], "secretsExisting": ["API_TOKEN"],
                    "agentsCreated": ["Fast local"], "agentsReused": ["Claude"],
                    "packages": [{"pip": "requests"}]},
    }).encode()
    c = _RouteClient(raw=raw, reply={"packages": [
        {"pip": "requests", "import": "requests", "status": "installed",
         "version": "2.32.3"}]})
    _run(c, "automation", "import", str(src))
    assert c.calls == [
        ("POST", "/automations/import", b"ARCHIVE"),
        ("POST", "/packages/install", {"packages": [{"pip": "requests"}]}),
    ]
    out = capsys.readouterr().out
    assert "imported 'Imported' [deadbeef]" in out
    assert "secrets that need values: BOT_TOKEN" in out
    assert "existing secrets to grant on the edit page: API_TOKEN" in out
    assert "agents added: Fast local" in out
    assert "agents reused: Claude" in out
    assert "package requests 2.32.3 installed" in out
    assert "triggers imported off" in out


def test_cmd_automation_import_missing_file_exits():
    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(), "automation", "import", "/nope/missing.autowright")
    assert "missing.autowright" in str(ei.value.code)


def test_cmd_automation_push_keeps_stored_grants(tmp_path, capsys):
    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, FULL_AUTO)
    c = _WorkdirClient()
    _run(c, "automation", "push", "Daily Report", str(d), "--note", "tweak")
    method, path, body = c.posted[-1]
    assert (method, path) == ("POST", f"/automations/{AUTO_ID}/versions")
    assert body["draft"]["note"] == "tweak"
    # §20 grant model: the stored grants ride along unchanged
    assert body["allowedSecrets"] == ["API_TOKEN"]
    # §4.3 merge: the untouched cron keeps its id, the app_start trigger survives
    kinds = {t["kind"] for t in body["draft"]["triggers"]}
    assert kinds == {"cron", "app_start"}
    assert "saved 'Daily Report' as v2" in capsys.readouterr().out


def test_cmd_automation_push_never_widens_grants_silently(tmp_path):
    """§20 grant model: a pushed step needing an ungranted secret exits 1
    naming the flag to add — push never widens the stored grants on its own."""
    from autowright import cli

    auto = {**FULL_AUTO, "allowedSecrets": []}
    d = tmp_path / "wd"
    cli.write_workdir(d, auto)
    with pytest.raises(SystemExit) as ei:
        _run(_WorkdirClient(auto), "automation", "push", "Daily Report", str(d))
    assert "--grant-secret API_TOKEN" in str(ei.value.code)


def test_cmd_automation_push_grant_flag_widens(tmp_path, capsys):
    from autowright import cli

    auto = {**FULL_AUTO, "allowedSecrets": []}
    d = tmp_path / "wd"
    cli.write_workdir(d, auto)
    c = _WorkdirClient(auto)
    _run(c, "automation", "push", "Daily Report", str(d),
         "--grant-secret", "API_TOKEN")
    _, _, body = c.posted[-1]
    assert body["allowedSecrets"] == ["API_TOKEN"]


AGENT_STEP_AUTO = {
    **FULL_AUTO,
    "steps": [{**FULL_AUTO["steps"][0], "agent": True, "why": "judgment call",
               "agents": ["Fast local"]}],
}


def test_cmd_automation_create_grant_agent_saves_id(tmp_path, capsys):
    """§20 grant model: --grant-agent takes the §8 grant name but stepAgents
    stores the agent's id — the enablement list the engine resolves by id."""
    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, AGENT_STEP_AUTO)
    c = _WorkdirClient()
    _run(c, "automation", "create", str(d), "--grant-agent", "fast local",
         "--grant-secret", "API_TOKEN")
    _, _, body = c.posted[-1]
    assert body["stepAgents"] == ["ag1"]


def test_cmd_automation_push_stored_agent_id_satisfies_step_name(tmp_path, capsys):
    """§20: a stored stepAgents id maps back to its grant name for the
    needed-vs-granted check — no flag demanded for an already-granted agent."""
    from autowright import cli

    auto = {**AGENT_STEP_AUTO, "stepAgents": ["ag1"]}
    d = tmp_path / "wd"
    cli.write_workdir(d, auto)
    c = _WorkdirClient(auto)
    _run(c, "automation", "push", "Daily Report", str(d))
    _, _, body = c.posted[-1]
    assert body["stepAgents"] == ["ag1"]


def test_cmd_automation_push_ungranted_agent_names_flag(tmp_path):
    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, AGENT_STEP_AUTO)  # stepAgents: []
    with pytest.raises(SystemExit) as ei:
        _run(_WorkdirClient(AGENT_STEP_AUTO), "automation", "push",
             "Daily Report", str(d))
    assert "--grant-agent Fast local" in str(ei.value.code)


def test_cmd_automation_push_unnamed_agent_step_needs_a_grant(tmp_path):
    """§20: an `agent: true` step with no `agents:` list runs on the first
    enabled agent — with no granted agent the save exits asking for a flag."""
    from autowright import cli

    auto = {**AGENT_STEP_AUTO,
            "steps": [{k: v for k, v in AGENT_STEP_AUTO["steps"][0].items()
                       if k != "agents"}]}
    d = tmp_path / "wd"
    cli.write_workdir(d, auto)
    with pytest.raises(SystemExit) as ei:
        _run(_WorkdirClient(auto), "automation", "push", "Daily Report", str(d))
    assert "--grant-agent" in str(ei.value.code)
    assert "Fast local" in str(ei.value.code)


def test_cmd_automation_create_grants_only_the_flags(tmp_path, capsys):
    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, FULL_AUTO)
    c = _WorkdirClient()
    _run(c, "automation", "create", str(d), "--agent", "fast local",  # case-insensitive
         "--grant-secret", "API_TOKEN")
    method, path, body = c.posted[-1]
    assert (method, path) == ("POST", "/automations")
    assert body["agentId"] == "ag1"
    # §20 grant model: no all-on seed — exactly the flags
    assert body["stepAgents"] == []
    assert body["allowedSecrets"] == ["API_TOKEN"]
    assert body["name"] == "Daily Report"  # from the manifest
    assert "created 'Daily Report'" in capsys.readouterr().out


def test_cmd_automation_create_without_grants_exits_naming_flags(tmp_path):
    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, FULL_AUTO)
    with pytest.raises(SystemExit) as ei:
        _run(_WorkdirClient(), "automation", "create", str(d))
    assert "--grant-secret API_TOKEN" in str(ei.value.code)


def test_cmd_automation_create_unknown_grant_secret_exits(tmp_path):
    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, FULL_AUTO)
    with pytest.raises(SystemExit) as ei:
        _run(_WorkdirClient(), "automation", "create", str(d),
             "--grant-secret", "NOPE")
    assert "no stored secret named 'NOPE'" in str(ei.value.code)
    assert "API_TOKEN" in str(ei.value.code)


def test_cmd_automation_create_unknown_agent_exits(tmp_path):
    from autowright import cli

    d = tmp_path / "wd"
    cli.write_workdir(d, FULL_AUTO)
    with pytest.raises(SystemExit) as ei:
        _run(_WorkdirClient(), "automation", "create", str(d), "--agent", "nope")
    assert "no agent named 'nope'" in str(ei.value.code)
    assert "Fast local" in str(ei.value.code)


def test_cmd_param_list_and_set(capsys):
    _run(_RouteClient(_auto_gets()), "automation", "param", "list", "Daily Report")
    assert "sources" in capsys.readouterr().out

    c = _RouteClient(_auto_gets())
    _run(c, "automation", "param", "set", "Daily Report", "sources=a, b")
    assert c.calls == [("PATCH", f"/automations/{AUTO_ID}",
                        {"paramValues": {"sources": ["a", "b"]}})]
    assert "set sources on 'Daily Report'" in capsys.readouterr().out


def test_cmd_param_set_rejects_bad_input():
    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(_auto_gets()), "automation", "param", "set", "Daily Report",
             "sources")  # no '='
    assert "NAME=VALUE" in str(ei.value.code)

    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(_auto_gets()), "automation", "param", "set", "Daily Report",
             "nope=1")
    assert "no param named 'nope'" in str(ei.value.code)
    assert "sources" in str(ei.value.code)


def test_cmd_trigger_list_empty_prints_hint(capsys):
    _run(_RouteClient(_auto_gets(dict(FULL_AUTO, triggers=[]))),
         "automation", "trigger", "list", "Daily Report")
    assert "no triggers" in capsys.readouterr().out


def test_cmd_trigger_toggle_by_index(capsys):
    c = _RouteClient(_auto_gets())
    _run(c, "automation", "trigger", "on", "Daily Report", "1")
    method, path, body = c.calls[-1]
    assert (method, path) == ("PATCH", f"/automations/{AUTO_ID}")
    assert body["triggers"][0]["off"] is False
    assert "trigger 1 (Daily 8:00 (Tokyo)) now on" in capsys.readouterr().out

    c = _RouteClient(_auto_gets())
    _run(c, "automation", "trigger", "off", "Daily Report", "2")
    assert c.calls[-1][2]["triggers"][1]["off"] is True
    assert "now off" in capsys.readouterr().out


def test_cmd_trigger_bad_index_exits():
    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(_auto_gets()), "automation", "trigger", "off", "Daily Report", "9")
    assert "trigger index must be 1..2" in str(ei.value.code)


def test_cmd_trigger_remove_by_index(capsys):
    c = _RouteClient(_auto_gets())
    _run(c, "automation", "trigger", "remove", "Daily Report", "1")
    body = c.calls[-1][2]
    assert [t["kind"] for t in body["triggers"]] == ["app_start"]
    assert "removed trigger 1 (Daily 8:00 (Tokyo))" in capsys.readouterr().out


SNAPS = [{"id": "s1111111-a", "when": "today 10:00", "reason": "manual", "version": "v2",
          "size": "1 KB", "name": "before cleanup"},
         {"id": "s2222222-b", "when": "today 11:00", "reason": "pre-clear", "version": "v2",
          "size": "2 KB", "name": ""}]


def test_cmd_memory_and_snapshot_commands(capsys):
    auto = dict(FULL_AUTO, snapshots=SNAPS)

    c = _RouteClient(_auto_gets(auto))
    _run(c, "automation", "memory", "clear", "Daily Report")
    assert c.calls == [("POST", f"/automations/{AUTO_ID}/memory/clear", None)]
    assert "memory cleared" in capsys.readouterr().out

    _run(_RouteClient(_auto_gets(auto)), "automation", "snapshot", "list", "Daily Report")
    out = capsys.readouterr().out
    assert "s1111111" in out and "before cleanup" in out

    c = _RouteClient(_auto_gets(auto), reply={"snapshot": {"id": "s3333333-c"}})
    _run(c, "automation", "snapshot", "create", "Daily Report", "--name", "label")
    assert c.calls == [("POST", f"/automations/{AUTO_ID}/memory/snapshots", {"name": "label"})]
    assert "snapshot s3333333 created" in capsys.readouterr().out

    c = _RouteClient(_auto_gets(auto))
    _run(c, "automation", "snapshot", "restore", "Daily Report", "s1")
    assert c.calls == [("POST", f"/automations/{AUTO_ID}/memory/snapshots/s1111111-a/restore",
                        None)]

    c = _RouteClient(_auto_gets(auto))
    _run(c, "automation", "snapshot", "delete", "Daily Report", "s2")
    assert c.calls == [("DELETE", f"/automations/{AUTO_ID}/memory/snapshots/s2222222-b", None)]


def test_find_snapshot_ambiguous_prefix_exits():
    from autowright.cli import _find_snapshot

    c = _RouteClient(_auto_gets(dict(FULL_AUTO, snapshots=SNAPS)))
    with pytest.raises(SystemExit) as ei:
        _find_snapshot(c, {"id": AUTO_ID}, "s")  # both match
    assert "no unique snapshot" in str(ei.value.code)


FULL_EXEC = {
    "id": "e1234567-0000", "autoName": "Daily Report", "ver": "v2", "status": "failed",
    "dur": "3s", "trigger": "Discord", "started": "2026-07-29 08:00",
    "triggerPayload": {"kind": "discord", "sender": "dave", "channel": "42",
                       "channelName": "general", "guildName": "Ops",
                       "at": "08:00", "text": "go fetch"},
    "steps": [{"name": "Fetch", "status": "succeeded", "dur": "1s"},
              {"name": "Report", "status": "failed", "dur": "2s"}],
    "error": {"step": "Report", "message": "boom", "reason": "the API was down"},
    "result": {"chip": "0 new", "files": [{"name": "report.md", "size": "2 KB"}]},
}


def test_cmd_execution_list_filters_and_limit(capsys):
    execs = [dict(FULL_EXEC, id=f"e{i}") for i in range(3)]
    gets = _auto_gets(**{f"/executions?auto={AUTO_ID}&status=failed": execs})
    _run(_RouteClient(gets), "execution", "list", "-n", "2",
         "--automation", "Daily Report", "--status", "failed")
    out = capsys.readouterr().out.splitlines()
    assert len(out) == 2  # -n cap applied
    assert "Daily Report" in out[0] and "[e0]" in out[0]


def test_cmd_execution_show_prints_trigger_message_error_and_result(capsys):
    gets = {"/executions": [FULL_EXEC], f"/executions/{FULL_EXEC['id']}": FULL_EXEC}
    _run(_RouteClient(gets), "execution", "show")  # no ref → latest
    out = capsys.readouterr().out
    assert "Daily Report v2 — failed in 3s (Discord, 2026-07-29 08:00)" in out
    assert "trigger message: dave · #general · Ops · 08:00" in out and "go fetch" in out
    assert "step 2: Report" in out
    assert "error in 'Report': boom" in out
    assert "possible reason: the API was down" in out
    assert "result: 0 new" in out
    assert "file: report.md (2 KB)" in out


def test_cmd_execution_show_payload_fallbacks(capsys):
    # iMessage payload has no channel — must print sender · time, no KeyError
    e = dict(FULL_EXEC, triggerPayload={
        "kind": "imessage", "sender": "+15551234567", "messageId": "g1",
        "chat": "iMessage;-;+15551234567", "at": "08:00", "text": "hi"})
    gets = {"/executions": [e], f"/executions/{e['id']}": e}
    _run(_RouteClient(gets), "execution", "show")
    out = capsys.readouterr().out
    assert "trigger message: +15551234567 · 08:00" in out and "  hi" in out

    # Discord with no cached names falls back to the raw channel id
    e = dict(FULL_EXEC, triggerPayload=dict(
        FULL_EXEC["triggerPayload"], channelName=None, guildName=None))
    gets = {"/executions": [e], f"/executions/{e['id']}": e}
    _run(_RouteClient(gets), "execution", "show")
    assert "trigger message: dave · 42 · 08:00" in capsys.readouterr().out


def test_cmd_execution_cancel_and_retry(capsys):
    gets = {"/executions": [FULL_EXEC]}
    c = _RouteClient(gets)
    _run(c, "execution", "cancel", "e12")
    assert c.calls == [("POST", f"/executions/{FULL_EXEC['id']}/cancel", None)]
    assert "cancelled e1234567" in capsys.readouterr().out

    c = _RouteClient(gets)
    _run(c, "execution", "retry", "e12")
    assert c.calls == [("POST", f"/executions/{FULL_EXEC['id']}/retry", None)]
    assert "retrying e1234567 in place" in capsys.readouterr().out


def test_cmd_execution_skip_targets_first_executing_step(capsys):
    running = dict(FULL_EXEC, steps=[{"name": "A", "status": "succeeded"},
                                     {"name": "B", "status": "executing"}])
    gets = {"/executions": [running], f"/executions/{running['id']}": running}
    c = _RouteClient(gets)
    _run(c, "execution", "skip")
    assert c.calls == [("POST", f"/executions/{running['id']}/skip-step", {"index": 1})]
    assert "skipping step 2" in capsys.readouterr().out

    gets = {"/executions": [FULL_EXEC], f"/executions/{FULL_EXEC['id']}": FULL_EXEC}
    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(gets), "execution", "skip")
    assert "no step is executing" in str(ei.value.code)


def test_cmd_execution_result_lists_then_streams(capsysbinary):
    gets = {"/executions": [FULL_EXEC], f"/executions/{FULL_EXEC['id']}": FULL_EXEC}
    _run(_RouteClient(gets), "execution", "result")
    assert b"report.md (2 KB)" in capsysbinary.readouterr().out

    c = _RouteClient({"/executions": [FULL_EXEC]}, raw=b"\x00binary bytes")
    _run(c, "execution", "result", "e12", "report.md")
    assert c.calls == [("GET", f"/executions/{FULL_EXEC['id']}/result/report.md", None)]
    assert capsysbinary.readouterr().out == b"\x00binary bytes"


def test_cmd_secret_commands(monkeypatch, capsys):
    secrets = [{"name": "API_TOKEN", "set": True, "usedBy": ["Daily Report"]},
               {"name": "BOT_TOKEN", "set": False, "usedBy": []}]
    _run(_RouteClient({"/secrets": secrets}), "secret", "list")
    out = capsys.readouterr().out
    assert "API_TOKEN" in out and "used by: Daily Report" in out
    assert "BOT_TOKEN (not set)" in out
    assert "used by: not used yet" in out  # empty usedBy list

    # §20: a value never rides argv — there is no positional to pass it in.
    with pytest.raises(SystemExit):
        _run(_RouteClient(), "secret", "set", "API_TOKEN", "s3cret")

    # --stdin, for scripted use
    from autowright import cli

    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("piped-in\n"))
    c = _RouteClient()
    _run(c, "secret", "set", "API_TOKEN", "--stdin")
    assert c.calls == [("PUT", "/secrets/API_TOKEN", {"value": "piped-in"})]
    assert "saved to your Keychain" in capsys.readouterr().out

    # otherwise prompted, never echoed
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: "typed-in")
    c = _RouteClient()
    _run(c, "secret", "set", "API_TOKEN")
    assert c.calls == [("PUT", "/secrets/API_TOKEN", {"value": "typed-in"})]

    c = _RouteClient()
    _run(c, "secret", "delete", "API_TOKEN")
    assert c.calls == [("DELETE", "/secrets/API_TOKEN", None)]
    assert "removed from your Keychain" in capsys.readouterr().out


AGENTS = [{"id": "ag1", "name": "Fast local", "harness": "OpenCode", "model": "qwen3",
           "default": True},
          {"id": "ag2", "name": None, "harness": "Claude Code", "model": None}]


def test_cmd_agent_list_and_check(capsys):
    _run(_RouteClient({"/agents": AGENTS}), "agent", "list")
    out = capsys.readouterr().out
    assert "* Fast local" in out and "qwen3" in out
    assert "Claude Code" in out and "default model" in out

    c = _RouteClient({"/agents": AGENTS}, reply={"ok": True})
    _run(c, "agent", "check", "claude code")  # falls back to harness name
    assert c.calls == [("POST", "/agents/ag2/check", None)]
    assert json.loads(capsys.readouterr().out) == {"ok": True}

    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient({"/agents": AGENTS}), "agent", "check", "nope")
    assert "no agent named 'nope'" in str(ei.value.code)


def test_cmd_settings_show_and_set(capsys):
    _run(_RouteClient({"/settings": {"login": True, "days": 30, "keepAwake": True}}),
         "settings", "show")
    out = capsys.readouterr().out
    assert "login" in out and "True" in out
    assert "keepAwake" in out

    c = _RouteClient()
    _run(c, "settings", "set", "login=on", "days=14", "notif=failures")
    assert c.calls == [("PATCH", "/settings",
                        {"login": True, "days": 14, "notif": "failures"})]
    assert "set login, days, notif" in capsys.readouterr().out

    # keepAwake is a known bool key — both directions parse
    c = _RouteClient()
    _run(c, "settings", "set", "keepAwake=off")
    assert c.calls == [("PATCH", "/settings", {"keepAwake": False})]
    assert "set keepAwake" in capsys.readouterr().out
    c = _RouteClient()
    _run(c, "settings", "set", "keepAwake=on")
    assert c.calls == [("PATCH", "/settings", {"keepAwake": True})]


def test_cmd_settings_set_data_path_and_errors(capsys):
    c = _RouteClient()
    _run(c, "settings", "set", "dataPath=/Volumes/T7/aw")
    assert c.calls == [("POST", "/settings/data-path", {"path": "/Volumes/T7/aw"})]
    assert "execution data now at /Volumes/T7/aw" in capsys.readouterr().out

    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(), "settings", "set", "nope=1")
    assert "unknown setting 'nope'" in str(ei.value.code)

    with pytest.raises(SystemExit) as ei:
        _run(_RouteClient(), "settings", "set", "days=ten")
    assert "days takes an integer" in str(ei.value.code)


def test_cmd_service_dispatches_to_service_module(monkeypatch, capsys):
    from autowright import cli

    monkeypatch.setattr(cli.service, "status", lambda: "running (pid 42)")
    _run(None, "service", "status")
    assert "running (pid 42)" in capsys.readouterr().out
