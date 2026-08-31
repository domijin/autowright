"""§15 integration: the real CLI as a subprocess against a live backend."""
import json

import pytest

from .it_harness import create_auto, run_cli, wait_for, wait_status

pytestmark = pytest.mark.integration


def test_cli_list_and_agents(backend, client):
    create_auto(client, name="From HTTP")
    r = run_cli(backend.home, "automation", "list")
    assert r.returncode == 0, r.stderr
    assert "From HTTP" in r.stdout

    r = run_cli(backend.home, "agent", "list")
    assert r.returncode == 0, r.stderr


def test_cli_execute_follow_streams_to_exit(backend, client):
    a = create_auto(client, name="Followed")
    r = run_cli(backend.home, "automation", "execute", "Followed", "--follow")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "integration says hi" in r.stdout
    e = client.get("/executions").json()["executions"][0]
    assert e["automationId"] == a["id"]
    assert e["status"] == "succeeded"


def test_cli_export_import_roundtrip(backend, client, tmp_path):
    create_auto(client, name="Traveler")
    out = tmp_path / "traveler.autowright"
    r = run_cli(backend.home, "automation", "export", "Traveler", str(out))
    assert r.returncode == 0, r.stderr + r.stdout
    assert out.exists() and out.stat().st_size > 0

    r = run_cli(backend.home, "automation", "import", str(out))
    assert r.returncode == 0, r.stderr + r.stdout
    # §5.1: import always creates a new automation, and the §4.1 name dedupe
    # renames it because the archive's name is already taken.
    names = [x["name"] for x in client.get("/automations").json()]
    assert sorted(names) == ["Traveler", "Traveler 2"]
    # §20: the summary lines an agent parses: the dedupe notice and the
    # triggers-are-off reminder.
    assert "imported 'Traveler 2'" in r.stdout
    assert "renamed from 'Traveler' - that name already exists" in r.stdout
    assert "triggers imported off" in r.stdout


def test_cli_pull_edit_push_roundtrip(backend, client, tmp_path):
    """§20 authoring loop: pull → edit a step file → push saves v2 whose code
    actually executes."""
    create_auto(client, name="Editable")
    wd = tmp_path / "wd"
    r = run_cli(backend.home, "automation", "pull", "Editable", str(wd))
    assert r.returncode == 0, r.stderr + r.stdout
    assert (wd / "spec.md").exists() and (wd / "manifest.yaml").exists()
    step = wd / "01-say.py"
    step.write_text(step.read_text().replace("integration says hi",
                                             "integration says v2"))
    r = run_cli(backend.home, "automation", "push", "Editable", str(wd),
                "--note", "cli tweak")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "as v2" in r.stdout

    r = run_cli(backend.home, "automation", "execute", "Editable", "--follow")
    assert r.returncode == 0, r.stderr + r.stdout
    assert "integration says v2" in r.stdout
    full = client.get("/automations").json()
    a = next(x for x in full if x["name"] == "Editable")
    # `versions` is the history list (current v2 excluded): v1 remains restorable
    versions = client.get(f"/automations/{a['id']}").json()["versions"]
    assert [v["version"] for v in versions] == [1]


def test_cli_execution_cancel(backend, client):
    """§7 cancel through the CLI: a live sleeper settles `cancelled`."""
    a = create_auto(client, name="CliSleeper", steps=[
        {"file": "01-sleep.py", "name": "Sleep", "description": "hangs",
         "code": 'from autowright import log\nimport time\nlog("sleeping")\ntime.sleep(60)\n'},
    ])
    execution_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["executionId"]
    # the cancel must land on a genuinely live step, not a queued one
    wait_for(lambda: any("sleeping" in ln["text"] for ln in
                         client.get(f"/executions/{execution_id}/logs",
                                    params={"step": 0, "attempt": 1}).json()["lines"]),
             30, "step to log")
    r = run_cli(backend.home, "execution", "cancel", execution_id[:8])
    assert r.returncode == 0, r.stderr + r.stdout
    e = wait_status(client, execution_id)
    assert e["status"] == "cancelled"


def test_cli_executions_lists_the_run(backend, client):
    a = create_auto(client, name="Historied")
    execution_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["executionId"]
    wait_status(client, execution_id)
    r = run_cli(backend.home, "execution", "list")
    assert r.returncode == 0, r.stderr
    assert "Historied" in r.stdout


def test_cli_automation_show_reads_the_live_record(backend, client):
    """§20 read verb: `automation show` renders the real serialized record
    (header, description, steps), and `--json` hands back the raw API shape,
    §4.1 `problems` field included."""
    a = create_auto(client, name="Shown")
    r = run_cli(backend.home, "automation", "show", "Shown")
    assert r.returncode == 0, r.stderr + r.stdout
    assert f"Shown [{a['id']}]" in r.stdout
    assert "Integration automation" in r.stdout          # description line
    assert "step 1: Say" in r.stdout and "step 2: Finish" in r.stdout

    # an id prefix resolves the same record (§20 references)
    r = run_cli(backend.home, "automation", "show", a["id"][:8], "--json")
    assert r.returncode == 0, r.stderr + r.stdout
    full = json.loads(r.stdout)
    assert full["id"] == a["id"] and full["name"] == "Shown"
    assert [s["name"] for s in full["steps"]] == ["Say", "Finish"]
    # §4.1 problems is derived at serialization: a healthy automation has none,
    # and the CLI's machine mode carries the field either way.
    assert full["problems"] == []
    # a healthy automation prints no needs-fixing marker in the list either
    r = run_cli(backend.home, "automation", "list")
    assert r.returncode == 0, r.stderr
    assert "needs fixing" not in r.stdout


def test_cli_automation_show_unknown_reference_exits_1(backend, client):
    """§20 exit codes: a bad reference is a plain message on stderr and exit 1,
    never 2 (the follow-failure signal) and never a traceback."""
    create_auto(client, name="Shown")
    r = run_cli(backend.home, "automation", "show", "no-such-automation")
    assert r.returncode == 1, r.stdout + r.stderr
    assert "no automation matches" in r.stderr
    assert "Traceback" not in r.stderr

    # and a usage error, which argparse would otherwise exit 2 on
    r = run_cli(backend.home, "automation", "nosuchverb")
    assert r.returncode == 1, r.stdout + r.stderr
    assert "Traceback" not in r.stderr


def test_cli_execution_list_filters_and_json(backend, client):
    """§20: `execution list` filters by automation and status, caps with -n, and
    `--json` returns the raw rows."""
    quiet = create_auto(client, name="Quiet")
    noisy = create_auto(client, name="Noisy")
    for _ in range(2):
        wait_status(client, client.post(f"/automations/{noisy['id']}/execute",
                                        json={}).json()["executionId"])
    wait_status(client, client.post(f"/automations/{quiet['id']}/execute",
                                    json={}).json()["executionId"])

    r = run_cli(backend.home, "execution", "list", "--automation", "Noisy")
    assert r.returncode == 0, r.stderr + r.stdout
    rows = [ln for ln in r.stdout.splitlines() if ln.strip()]
    assert len(rows) == 2 and all("Noisy" in ln for ln in rows)

    r = run_cli(backend.home, "execution", "list", "--automation", "Noisy", "-n", "1")
    assert r.returncode == 0, r.stderr + r.stdout
    assert len([ln for ln in r.stdout.splitlines() if ln.strip()]) == 1

    r = run_cli(backend.home, "execution", "list", "--status", "succeeded", "--json")
    assert r.returncode == 0, r.stderr + r.stdout
    execs = json.loads(r.stdout)
    assert len(execs) == 3
    assert {e["status"] for e in execs} == {"succeeded"}
    assert {e["automationName"] for e in execs} == {"Noisy", "Quiet"}

    r = run_cli(backend.home, "execution", "list", "--status", "failed", "--json")
    assert r.returncode == 0, r.stderr + r.stdout
    assert json.loads(r.stdout) == []
