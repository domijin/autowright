"""§15 integration: the real CLI as a subprocess against a live backend."""
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
    e = client.get("/executions").json()[0]
    assert e["autoId"] == a["id"]
    assert e["status"] == "succeeded"


def test_cli_export_import_roundtrip(backend, client, tmp_path):
    create_auto(client, name="Traveler")
    out = tmp_path / "traveler.autowright"
    r = run_cli(backend.home, "automation", "export", "Traveler", str(out))
    assert r.returncode == 0, r.stderr + r.stdout
    assert out.exists() and out.stat().st_size > 0

    r = run_cli(backend.home, "automation", "import", str(out))
    assert r.returncode == 0, r.stderr + r.stdout
    names = [x["name"] for x in client.get("/automations").json()]
    assert names.count("Traveler") == 2  # §5.1 import always creates a new automation


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
    assert [v["v"] for v in versions] == [1]


def test_cli_execution_cancel(backend, client):
    """§7 cancel through the CLI: a live sleeper settles `cancelled`."""
    a = create_auto(client, name="CliSleeper", steps=[
        {"file": "01-sleep.py", "name": "Sleep", "desc": "hangs",
         "code": 'from autowright import log\nimport time\nlog("sleeping")\ntime.sleep(60)\n'},
    ])
    exec_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["execId"]
    # the cancel must land on a genuinely live step, not a queued one
    wait_for(lambda: any("sleeping" in ln["text"] for ln in
                         client.get(f"/executions/{exec_id}/logs",
                                    params={"step": 0, "attempt": 1}).json()["lines"]),
             30, "step to log")
    r = run_cli(backend.home, "execution", "cancel", exec_id[:8])
    assert r.returncode == 0, r.stderr + r.stdout
    e = wait_status(client, exec_id)
    assert e["status"] == "cancelled"


def test_cli_executions_lists_the_run(backend, client):
    a = create_auto(client, name="Historied")
    exec_id = client.post(f"/automations/{a['id']}/execute", json={}).json()["execId"]
    wait_status(client, exec_id)
    r = run_cli(backend.home, "execution", "list")
    assert r.returncode == 0, r.stderr
    assert "Historied" in r.stdout
