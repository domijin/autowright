import time

from conftest import make_version, read_all_logs


def wait_done(engine, execution_id, timeout=30):
    t0 = time.time()
    while engine.is_live(execution_id):
        assert time.time() - t0 < timeout, "execution didn't finish in time"
        time.sleep(0.1)


def test_run_lifecycle_success(store):
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Exec Demo", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert [s["status"] for s in h["steps"]] == ["succeeded", "succeeded"]
    logs = read_all_logs(store, h["id"])
    assert any("hello x3" in l["text"] for l in logs)
    assert any(l["text"].startswith("▸ Step 1") for l in logs)
    # chip + status live on the execution header
    assert h["chip"] == "All good" and h["chip_status"] == "ok"
    # automation display state updated
    assert a["_last_status"] == "succeeded" and a["_live"] == set()


def test_chip_is_optional(store):
    """§4.5: an execution that never calls result.chip() has no chip anywhere."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-quiet.py", "name": "Quiet", "description": "",
         "code": 'from autowright import result\n(result.path / "result.md").write_text("done, no chip")\n'},
    ]
    a = store.create_automation(ver, "Chipless", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert h["chip"] is None and h["chip_status"] is None
    j = store.auto_json(a)
    assert j["resultChip"] is None and j["resultStatus"] is None
    assert j["latest"] and "chip" not in j["latest"]  # files still form a result


def test_failed_step_stops_run(store):
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Failer", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert h["steps"][0]["status"] == "failed"
    assert h["steps"][1]["status"] == "queued"  # never ran
    assert any("boom" in l["text"] for l in read_all_logs(store, h["id"]))


def test_missing_secret_stops_before_step_one(store):
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "from autowright import secrets\nx = secrets.NOT_THERE\n"
    a = store.create_automation(ver, "Secretless", None)
    store.patch_automation(a, {"allowedSecrets": ["NOT_THERE"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = read_all_logs(store, h["id"])
    assert any("isn't in your Keychain" in l["text"] for l in logs)
    # no step ever started
    assert not any(l["text"].startswith("▸ Step") for l in logs)


def test_secret_not_allowed_stops_before_step_one(store):
    """§6 pre-flight: a step referencing a secret outside allowedSecrets fails
    the execution before any step starts."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "from autowright import secrets\nx = secrets.FORBIDDEN\n"
    a = store.create_automation(ver, "NotAllowed", None)  # allowed_secrets stays []
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = read_all_logs(store, h["id"])
    assert any("secret FORBIDDEN isn't allowed for this automation" in l["text"] for l in logs)
    assert not any(l["text"].startswith("▸ Step") for l in logs)  # no step ever started
    assert h["error"]["step"] is None
    assert h["error"]["reason"] == \
        "A step references a secret this automation isn't allowed to use."
    assert all(s["status"] == "queued" for s in h["steps"])


def test_placeholder_secret_without_value_stops_before_step_one(store):
    """§4.8 pre-flight: a placeholder secret (set: False) with no Keychain value
    gets the clearer 'no value yet' message, not 'isn't in your Keychain'."""
    from autowright.engine import Engine

    engine = Engine(store)
    store.secrets.append({"name": "PENDING", "description": "", "set": False})
    ver = make_version()
    ver["steps"][0]["code"] = "from autowright import secrets\nx = secrets.PENDING\n"
    a = store.create_automation(ver, "Placeholder", None)
    store.patch_automation(a, {"allowedSecrets": ["PENDING"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = read_all_logs(store, h["id"])
    assert any("secret PENDING has no value yet — add it on the Secrets page" in l["text"]
               for l in logs)
    assert not any("isn't in your Keychain" in l["text"] for l in logs)
    assert h["error"]["step"] is None
    assert h["error"]["reason"] == \
        "A step references a secret whose value hasn't been added yet."


def test_package_install_failure_fails_execution_before_step_one(store, monkeypatch):
    """§7: a declared package that can't be installed fails the execution
    before step 1 — steps stay queued, the error names the package problem."""
    from autowright import packages
    from autowright.engine import Engine

    entry = {"pip": "leftpad", "import": "leftpad"}
    monkeypatch.setattr(packages, "check",
                        lambda entries: [{**entry, "status": "missing"}])
    monkeypatch.setattr(packages, "ensure",
                        lambda entries, on_progress=None, should_stop=None:
                        [{**entry, "status": "failed", "error": "no matching distribution"}])
    engine = Engine(store)
    a = store.create_automation(make_version(packages=[entry]), "PkgFail", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert h["error"]["step"] is None
    assert h["error"]["message"] == "leftpad: no matching distribution"
    assert h["error"]["reason"].startswith("A required package couldn't be installed")
    assert all(s["status"] == "queued" for s in h["steps"])
    logs = read_all_logs(store, h["id"])
    assert any("installing packages: leftpad" in l["text"] for l in logs)
    assert any("package install failed — leftpad: no matching distribution" in l["text"]
               for l in logs)
    assert not any(l["text"].startswith("▸ Step") for l in logs)


def test_missing_step_script_fails_execution(store):
    """§6: a step whose script file vanished fails the step with an 'is
    missing' diagnostic; later steps never run."""
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Scriptless", None)
    (store.auto_dir(a) / "versions" / "v1" / "01-say.py").unlink()
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert h["steps"][0]["status"] == "failed"
    assert h["steps"][1]["status"] == "queued"
    assert h["error"]["step"] == "Say hello"
    assert h["error"]["message"] == "step script 01-say.py is missing"
    assert h["error"]["reason"] is None  # MissingScript fits no §7 category
    att = h["steps"][0]["attempts"][0]
    assert att["status"] == "failed"
    assert att["error"]["message"] == "step script 01-say.py is missing"
    assert any("is missing" in l["text"] and l["kind"] == "err"
               for l in read_all_logs(store, h["id"]))


def test_sys_exit_semantics(store):
    """§6.1: sys.exit()/sys.exit(0) is an ordinary early exit (step succeeds);
    a nonzero or message exit fails the step keeping the author's diagnostic."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "import sys\nsys.exit()\n"
    a = store.create_automation(ver, "CleanExit", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert [s["status"] for s in h["steps"]] == ["succeeded", "succeeded"]

    ver2 = make_version()
    ver2["steps"][0]["code"] = "import sys\nsys.exit(2)\n"
    b = store.create_automation(ver2, "CodeExit", None)
    h2 = engine.start(b, "manual")
    wait_done(engine, h2["id"])
    assert h2["status"] == "failed"
    assert h2["error"]["message"] == "step exited with code 2"
    assert h2["steps"][1]["status"] == "queued"

    ver3 = make_version()
    ver3["steps"][0]["code"] = 'import sys\nsys.exit("why")\n'
    c = store.create_automation(ver3, "MsgExit", None)
    h3 = engine.start(c, "manual")
    wait_done(engine, h3["id"])
    assert h3["status"] == "failed"
    assert h3["error"]["message"] == "SystemExit: why"


def test_secret_redacted_from_logs(store):
    from autowright import keychain
    from autowright.engine import Engine

    keychain.set_secret("API_KEY", "super-secret-value-123")
    store.secrets.append({"name": "API_KEY", "description": ""})
    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'from autowright import log, secrets\nk = secrets.API_KEY\nlog(f"using {k} now")\n'
    a = store.create_automation(ver, "Leaky", None)
    store.patch_automation(a, {"allowedSecrets": ["API_KEY"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = read_all_logs(store, h["id"])
    assert not any("super-secret-value-123" in l["text"] for l in logs)
    assert any("•••" in l["text"] for l in logs)
    assert "API_KEY" in h["redacted_secrets"]


def test_multiline_secret_lines_redacted_from_logs(store):
    from autowright import keychain
    from autowright.engine import Engine

    pem = "-----BEGIN KEY-----\nabc123line\n-----END KEY-----"
    keychain.set_secret("PEM_KEY", pem)
    store.secrets.append({"name": "PEM_KEY", "description": ""})
    engine = Engine(store)
    ver = make_version()
    # Each log() call is a separate log line, so the whole value never
    # appears in one line — only its individual lines do.
    ver["steps"][0]["code"] = (
        "from autowright import log, secrets\nk = secrets.PEM_KEY\n"
        "for part in k.splitlines():\n"
        '    log(f"line: {part}")\n'
    )
    a = store.create_automation(ver, "PemLeaky", None)
    store.patch_automation(a, {"allowedSecrets": ["PEM_KEY"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = read_all_logs(store, h["id"])
    assert not any("abc123line" in l["text"] for l in logs)
    assert not any("BEGIN KEY" in l["text"] for l in logs)
    assert "PEM_KEY" in h["redacted_secrets"]


def test_retry_in_place_from_failed_step(store):
    """§7: retry re-executes the same record from the failed step — the failed
    step gains attempt 2, succeeded steps stay untouched, workspace persists."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ok.py", "name": "OK step", "description": "",
         "code": 'from autowright import log\nopen("state.txt", "w").write("from pass one")\nlog("fine")\n'},
        {"file": "02-flaky.py", "name": "Flaky step", "description": "",
         "code": 'from autowright import log\nimport os\nassert os.path.exists("flag"), "flaky"\n'
                 'log(open("state.txt").read())\n'},
    ]
    a = store.create_automation(ver, "Retry Me", None)
    h1 = engine.start(a, "manual")
    wait_done(engine, h1["id"])
    assert h1["status"] == "failed" and h1["steps"][1]["status"] == "failed"
    assert h1["error"]["step"] == "Flaky step"
    first_dur = h1["duration_ms"]
    (store.exec_dir(h1["id"]) / "workspace" / "flag").write_text("ok")
    h2 = engine.retry(a, h1)
    assert h2["id"] == h1["id"]  # same execution record
    wait_done(engine, h2["id"])
    assert h2["status"] == "succeeded"
    assert h2["error"] is None  # cleared by the successful retry pass
    assert h2["steps"][0]["status"] == "succeeded"
    assert len(h2["steps"][0]["attempts"]) == 1  # never re-executed
    assert [x["status"] for x in h2["steps"][1]["attempts"]] == ["failed", "succeeded"]
    assert h2["duration_ms"] > first_dur  # accumulated across passes
    # attempt 1 kept its error; attempt 2 has none
    assert h2["steps"][1]["attempts"][0]["error"]["message"].startswith("AssertionError")
    assert "error" not in h2["steps"][1]["attempts"][1]
    # each attempt streamed into its own log file; workspace was NOT copied
    logs_dir = store.exec_dir(h1["id"]) / "logs"
    assert (logs_dir / "02-flaky.a1.ndjson").exists()
    assert (logs_dir / "02-flaky.a2.ndjson").exists()
    assert any("from pass one" in l["text"]
               for l in store.read_log(h1["id"], 1, 2))


COUNTER_STEP = (  # fails until the workspace counter reaches the threshold
    "from autowright import log\nimport pathlib\n"
    "p = pathlib.Path('count.txt')\n"
    "n = int(p.read_text()) + 1 if p.exists() else 1\n"
    "p.write_text(str(n))\n"
    "log(f'try {n}')\n"
    "assert n >= THRESHOLD, f'not yet ({n})'\n"
)


def _counter_step(threshold, **fields):
    return {"file": "01-flaky.py", "name": "Flaky", "description": "",
            "code": COUNTER_STEP.replace("THRESHOLD", str(threshold)), **fields}


def test_step_retry_succeeds_within_budget(store):
    """§7 step retry: a failed attempt re-runs immediately; the execution stays
    one record, never goes failed, and later steps still run."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [_counter_step(3, retries=5),
                    {"file": "02-after.py", "name": "After", "description": "",
                     "code": 'from autowright import log\nlog("after ran")\n'}]
    a = store.create_automation(ver, "StepRetry", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert h["error"] is None
    assert [x["status"] for x in h["steps"][0]["attempts"]] == ["failed", "failed", "succeeded"]
    assert [x["number"] for x in h["steps"][0]["attempts"]] == [1, 2, 3]
    assert h["steps"][1]["status"] == "succeeded"
    # the failed attempts kept their errors; retry markers landed in the logs
    assert h["steps"][0]["attempts"][0]["error"]["message"].startswith("AssertionError")
    logs = read_all_logs(store, h["id"])
    assert any("attempt 1 failed — retrying (1 of 5)" in l["text"] for l in logs)
    assert any("attempt 2 failed — retrying (2 of 5)" in l["text"] for l in logs)


def test_step_retry_budget_spent_fails_execution(store):
    """§7: past the budget the step fails for real — execution failed, §4.5
    error set from the last attempt, later steps never run."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [_counter_step(99, retries=2),
                    {"file": "02-after.py", "name": "After", "description": "",
                     "code": 'from autowright import log\nlog("never")\n'}]
    a = store.create_automation(ver, "SpentBudget", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert [x["status"] for x in h["steps"][0]["attempts"]] == ["failed"] * 3
    assert h["error"]["step"] == "Flaky"
    assert h["steps"][1]["status"] == "queued"  # never ran


def test_manual_retry_pass_gets_fresh_step_budget(store):
    """§7: automatic and manual attempts never share a counter — a manual
    in-place retry re-arms the step's own budget."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [_counter_step(4, retries=1)]
    a = store.create_automation(ver, "FreshBudget", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"  # attempts 1+2, budget 1 spent
    assert [x["number"] for x in h["steps"][0]["attempts"]] == [1, 2]
    h2 = engine.retry(a, h)
    wait_done(engine, h2["id"])
    assert h2["status"] == "succeeded"  # attempt 3 (manual pass) + auto attempt 4
    assert [x["number"] for x in h2["steps"][0]["attempts"]] == [1, 2, 3, 4]
    assert h2["steps"][0]["attempts"][-1]["status"] == "succeeded"


def test_infinite_retries_until_success_and_attempt_prune(store, monkeypatch):
    """§7/§4.5: infinite_retries re-runs until green; attempts beyond the newest
    20 prune with their log files, `n` stays monotonic."""
    from autowright.engine import Engine

    monkeypatch.setenv("AUTOWRIGHT_STEP_RETRY_PAUSE_S", "0")
    engine = Engine(store)
    ver = make_version()
    # 22 attempts: the smallest count that proves repeated pruning past the
    # MAX_ATTEMPTS=20 window while keeping wall time down (real subprocesses).
    ver["steps"] = [_counter_step(22, infinite_retries=True)]
    a = store.create_automation(ver, "Forever", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"], timeout=120)
    assert h["status"] == "succeeded"
    atts = h["steps"][0]["attempts"]
    assert len(atts) == 20  # pruned to the newest 20
    assert atts[-1]["number"] == 22 and atts[0]["number"] == 3  # monotonic numbering kept
    logs_dir = store.exec_dir(h["id"]) / "logs"
    assert not (logs_dir / "01-flaky.a1.ndjson").exists()  # pruned with its entry
    assert (logs_dir / "01-flaky.a22.ndjson").exists()


def test_infinite_retries_cancel_wins(store, monkeypatch):
    """§7: cancel ends an endlessly retrying step — the execution finishes
    cancelled, nothing stays live."""
    import time

    from autowright.engine import Engine

    monkeypatch.setenv("AUTOWRIGHT_STEP_RETRY_PAUSE_S", "0")
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [_counter_step(10_000, infinite_retries=True)]
    a = store.create_automation(ver, "CancelForever", None)
    h = engine.start(a, "manual")
    t0 = time.time()
    while not h["steps"][0]["attempts"] or h["steps"][0]["attempts"][-1]["number"] < 3:
        assert time.time() - t0 < 30
        time.sleep(0.1)
    assert engine.cancel(h["id"]) is True
    wait_done(engine, h["id"])
    assert h["status"] == "cancelled"
    assert not engine.is_live(h["id"])


def test_infinite_retries_skip_wins(store, monkeypatch):
    """§7: skip beats a pending retry — the step goes skipped, the next step
    runs, and the execution succeeds."""
    import time

    from autowright.engine import Engine

    monkeypatch.setenv("AUTOWRIGHT_STEP_RETRY_PAUSE_S", "0")
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [_counter_step(10_000, infinite_retries=True),
                    {"file": "02-after.py", "name": "After", "description": "",
                     "code": 'from autowright import log\nlog("after ran")\n'}]
    a = store.create_automation(ver, "SkipForever", None)
    h = engine.start(a, "manual")
    t0 = time.time()
    while not h["steps"][0]["attempts"] or h["steps"][0]["attempts"][-1]["number"] < 3:
        assert time.time() - t0 < 30
        time.sleep(0.1)
    while not engine.skip_step(h["id"], 0):  # may land between attempts — retry
        assert time.time() - t0 < 30
        time.sleep(0.05)
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert h["steps"][0]["status"] == "skipped"
    assert h["steps"][1]["status"] == "succeeded"
    logs = read_all_logs(store, h["id"])
    assert any("after ran" in l["text"] for l in logs)


def test_retry_rejected_unless_failed(store):
    import pytest

    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "No Retry", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    with pytest.raises(RuntimeError, match="only failed"):
        engine.retry(a, h)


def test_retry_rejected_while_at_capacity(store):
    """§6/§7: a retry admits like a start — with every maxParallel slot taken
    it is refused with the same 'already executing' error."""
    import pytest

    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    # first execution fails fast; the second reaches the sleep and stays live
    ver["steps"] = [
        {"file": "01-gate.py", "name": "Gate", "description": "",
         "code": ("from autowright import memory\nimport time\n"
                  "n = memory.load('n', 0) + 1\nmemory.save('n', n)\n"
                  "if n == 1:\n    raise RuntimeError('first pass fails')\n"
                  "time.sleep(30)\n")},
    ]
    a = store.create_automation(ver, "BusyRetry", None)
    h1 = engine.start(a, "manual")
    wait_done(engine, h1["id"])
    assert h1["status"] == "failed"
    h2 = engine.start(a, "manual")  # occupies the only slot
    try:
        with pytest.raises(RuntimeError, match="already executing"):
            engine.retry(a, h1)
    finally:
        engine.cancel(h2["id"])
        wait_done(engine, h2["id"])


def test_retry_deleted_version_raises_lookup_error(store):
    """§7: a retry whose version no longer resolves (a settled draft) surfaces
    a LookupError naming the version — the §19 layer turns that into a 404."""
    import pytest

    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "GoneVer", None)
    dver = make_version()
    dver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    store.save_draft(a, dver)
    h = engine.start(a, "manual", version_label="Draft")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    store.delete_draft(a)
    with pytest.raises(LookupError, match="version Draft not found"):
        engine.retry(a, h)


def test_skip_live_step_continues_execution(store):
    """§7 skip: the live step's subprocess dies, the step goes `skipped`, the
    next step still executes, and the execution finishes `succeeded`."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-slow.py", "name": "Slow step", "description": "",
         "code": 'from autowright import log\nlog("started")\nimport time\ntime.sleep(30)\n'},
        {"file": "02-after.py", "name": "After step", "description": "",
         "code": 'from autowright import log\nlog("still ran")\n'},
    ]
    a = store.create_automation(ver, "Skipper", None)
    h = engine.start(a, "manual")
    t0 = time.time()
    while h["steps"][0]["status"] != "executing" or not engine._live[h["id"]].get("proc"):
        assert time.time() - t0 < 15
        time.sleep(0.05)
    time.sleep(0.3)  # let the step reach its sleep
    assert engine.skip_step(h["id"], 1) is False  # only the live step is skippable
    assert engine.skip_step(h["id"], 0) is True
    wait_done(engine, h["id"])
    assert h["steps"][0]["status"] == "skipped"
    assert h["steps"][0]["attempts"][0]["status"] == "skipped"
    assert "error" not in h["steps"][0]["attempts"][0]
    assert h["steps"][1]["status"] == "succeeded"
    assert h["status"] == "succeeded"  # skipped steps don't fail the execution
    step1_log = store.read_log(h["id"], 0, 1)
    assert any("step skipped by you" in l["text"] for l in step1_log)
    assert any("still ran" in l["text"] for l in store.read_log(h["id"], 1, 1))


def test_one_execution_at_a_time(store):
    import pytest

    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "import time\ntime.sleep(3)\n"
    a = store.create_automation(ver, "Slowpoke", None)
    h = engine.start(a, "manual")
    with pytest.raises(RuntimeError, match="already executing"):
        engine.start(a, "manual")
    engine.cancel(h["id"])
    wait_done(engine, h["id"])
    assert h["status"] == "cancelled"


def test_memory_persists_between_executions(store):
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-count.py", "name": "Count", "description": "",
         "code": 'from autowright import log, memory, result\nn = memory.load("n", 0) + 1\nmemory.save("n", n)\nlog(f"execution number {n}")\n'
                 'result.status("ok")\nresult.chip(str(n))\n'},
    ]
    a = store.create_automation(ver, "Memoryful", None)
    for expect in ("1", "2"):
        h = engine.start(a, "manual")
        wait_done(engine, h["id"])
        assert h["chip"] == expect


def test_execution_metadata_and_env_vars(store):
    """§6.1: steps see execution.* metadata; child processes see AUTOWRIGHT_* env vars."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-meta.py", "name": "Meta", "description": "",
         "code": (
             "from autowright import execution, log\nimport os, subprocess, sys\n"
             'log(f"meta={execution.automation_name}/{execution.step_index}/{execution.step_name}/{execution.trigger}")\n'
             'log("env=" + os.environ["AUTOWRIGHT_EXECUTION_ID"])\n'
             "child = subprocess.run([sys.executable, '-c',"
             " 'import os; print(os.environ[\"AUTOWRIGHT_AUTOMATION_NAME\"])'],"
             " capture_output=True, text=True)\n"
             'log("child=" + child.stdout.strip())\n'
             "try:\n"
             "    execution.step_index = 99\n"
             "except AttributeError:\n"
             '    log("readonly ok")\n'
         )},
    ]
    a = store.create_automation(ver, "MetaAuto", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = [l["text"] for l in read_all_logs(store, h["id"])]
    assert "meta=MetaAuto/1/Meta/Manual" in logs
    assert f"env={h['id']}" in logs
    assert "child=MetaAuto" in logs
    assert "readonly ok" in logs


def test_workspace_shared_between_steps(store):
    """§6: all steps of an execution share one workspace (cwd)."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-write.py", "name": "Write", "description": "",
         "code": 'import json\njson.dump({"x": 42}, open("data.json", "w"))\n'},
        {"file": "02-read.py", "name": "Read", "description": "",
         "code": 'from autowright import result\nimport json\nd = json.load(open("data.json"))\n'
                 'result.status("ok")\nresult.chip(str(d["x"]))\n'},
    ]
    a = store.create_automation(ver, "Workspacer", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert h["chip"] == "42"
    assert (store.exec_dir(h["id"]) / "workspace" / "data.json").exists()


def test_agent_step_query_only(store):
    from autowright.engine import Engine

    store.agents = [{"id": "mock", "harness": "Claude Code", "model": "x"}]
    store.default_agent_id = "mock"  # §4.7: pointer, not a per-record flag
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ask.py", "name": "Ask", "description": "", "agent": True, "why": "judgment",
         "code": 'from autowright import agent, log, result\nans = agent.ask("question: anything new?")\nlog(f"agent said: {ans}")\n'
                 'result.status("ok")\n'},
    ]
    a = store.create_automation(ver, "Asker", None, enabled_agents=["mock"])
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert any("Mock answer" in l["text"] for l in read_all_logs(store, h["id"]))


def test_step_timeout_resolution(monkeypatch):
    """§6: step field wins; no_timeout disables; env overrides the default only."""
    from autowright.engine import step_timeout_for

    monkeypatch.delenv("AUTOWRIGHT_STEP_TIMEOUT", raising=False)
    assert step_timeout_for({}) == 900
    assert step_timeout_for({"timeout": 60}) == 60.0
    assert step_timeout_for({"no_timeout": True}) is None
    monkeypatch.setenv("AUTOWRIGHT_STEP_TIMEOUT", "5")
    assert step_timeout_for({}) == 5.0
    assert step_timeout_for({"timeout": 60}) == 60.0


def test_per_step_timeout_field_kills_the_step(store):
    """§6: a step's own manifest `timeout` is enforced — no env var involved."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-hang.py", "name": "Hang", "description": "", "timeout": 1,
         "code": "import time\ntime.sleep(30)\n"},
    ]
    a = store.create_automation(ver, "FieldHanger", None)
    t0 = time.time()
    h = engine.start(a, "manual")
    wait_done(engine, h["id"], timeout=15)
    assert time.time() - t0 < 15
    assert h["status"] == "failed"
    logs = read_all_logs(store, h["id"])
    assert any(l["kind"] == "err" and "timed out after 1s" in l["text"] for l in logs)


def test_step_timeout_applies_to_silent_hang(store, monkeypatch):
    """§6: the per-step timeout must fire even when the step prints nothing."""
    from autowright.engine import Engine

    monkeypatch.setenv("AUTOWRIGHT_STEP_TIMEOUT", "1")
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-hang.py", "name": "Hang", "description": "",
         "code": "import time\ntime.sleep(30)\n"},  # zero output
    ]
    a = store.create_automation(ver, "Hanger", None)
    t0 = time.time()
    h = engine.start(a, "manual")
    wait_done(engine, h["id"], timeout=15)
    assert time.time() - t0 < 15
    assert h["status"] == "failed"
    assert h["steps"][0]["status"] == "failed"
    logs = read_all_logs(store, h["id"])
    assert any(l["kind"] == "err" and "timed out" in l["text"] for l in logs)


def test_run_draft_version_lowercase_label(store):
    """§19: POST /execute accepts version 'draft' (lowercase) as well as 'Draft'."""
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Drafty", None)
    dver = make_version()
    dver["steps"] = [
        {"file": "01-say.py", "name": "Draft step", "description": "",
         "code": 'from autowright import log\nlog("from the draft")\n'},
    ]
    store.save_draft(a, dver)
    h = engine.start(a, "manual", version_label="draft")
    wait_done(engine, h["id"])
    # §4.5: the record stores the kind; "Draft" is derived at serialization
    assert h["kind"] == "draft" and h.get("version") is None
    assert store.exec_json(h)["ver"] == "Draft"
    assert h["status"] == "succeeded"
    assert any("from the draft" in l["text"] for l in read_all_logs(store, h["id"]))


def test_draft_execution_uses_draft_memory(store):
    """§4.4: a Draft execution seeds draft/memory from the live memory once,
    then iterates on it — the live memory dir is never written."""
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Drafty Mem", None)
    live_mem = store.auto_dir(a) / "memory"
    (live_mem / "seen.yaml").write_text("count: 1\n")

    dver = make_version()
    dver["steps"] = [
        {"file": "01-bump.py", "name": "Bump", "description": "",
         "code": ('from autowright import log, memory\nn = (memory.load("seen") or {}).get("count", 0)\n'
                  'log(f"count was {n}")\n'
                  'memory.save("seen", {"count": n + 1})\n')},
    ]
    store.save_draft(a, dver)

    h1 = engine.start(a, "manual", version_label="Draft")
    wait_done(engine, h1["id"])
    assert h1["status"] == "succeeded"
    # seeded from live memory (count 1), bumped in the draft copy only
    assert any("count was 1" in l["text"] for l in read_all_logs(store, h1["id"]))
    assert (store.auto_dir(a) / "draft" / "memory" / "seen.yaml").exists()
    assert (live_mem / "seen.yaml").read_text() == "count: 1\n"

    # second Draft execution continues on the same draft memory
    h2 = engine.start(a, "manual", version_label="Draft")
    wait_done(engine, h2["id"])
    assert any("count was 2" in l["text"] for l in read_all_logs(store, h2["id"]))
    assert (live_mem / "seen.yaml").read_text() == "count: 1\n"


def test_runtime_import_allowlist_revalidated(store):
    """§6.2: the executor re-checks the curated allowlist before exec'ing a step."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "from autowright import log\nimport django\nlog('never executes')\n"
    a = store.create_automation(ver, "Importer", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = read_all_logs(store, h["id"])
    assert any(l["kind"] == "err" and "django" in l["text"] and "isn't allowed" in l["text"] for l in logs)
    assert not any("never executes" in l["text"] for l in logs)


def test_sdk_names_must_be_imported(store):
    """§6.1: nothing is injected into a step's globals — an SDK name used
    without importing it from `autowright` is an ordinary NameError."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'log("no import here")\n'
    a = store.create_automation(ver, "Globals", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert h["error"]["message"].startswith("NameError")

    ver2 = make_version()
    ver2["steps"][0]["code"] = 'from autowright import log\nlog("imported fine")\n'
    b = store.create_automation(ver2, "Imported", None)
    h2 = engine.start(b, "manual")
    wait_done(engine, h2["id"])
    assert h2["status"] == "succeeded"
    assert any("imported fine" in l["text"] for l in read_all_logs(store, h2["id"]))


def test_agent_audit_logs_full_prompt(store):
    """§6: the FULL redacted prompt/reply are written to the attempt log — the
    only size limits are the §6 200k-chars prompt/output caps, far above this."""
    from autowright.engine import Engine

    store.agents = [{"id": "mock", "harness": "Claude Code", "model": "x"}]
    store.default_agent_id = "mock"
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ask.py", "name": "Ask", "description": "", "agent": True, "why": "judgment",
         "code": 'from autowright import agent, result\nans = agent.ask("question: anything new?", data="x" * 6000)\n'
                 'result.status("ok")\n'},
    ]
    a = store.create_automation(ver, "Big Asker", None, enabled_agents=["mock"])
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = read_all_logs(store, h["id"])
    prompt_lines = [l for l in logs if l["text"].startswith("agent prompt:")]
    assert prompt_lines and len(prompt_lines[0]["text"]) > 6000  # not truncated
    assert any(l["text"].startswith("agent reply:") for l in logs)


def test_secrets_scoped_per_step(store):
    """§6 scoping: a step only gets the secrets its own source references."""
    from autowright import keychain
    from autowright.engine import Engine

    keychain.set_secret("API_ONE", "value-one")
    keychain.set_secret("API_TWO", "value-two")
    store.secrets += [{"name": "API_ONE", "description": ""}, {"name": "API_TWO", "description": ""}]
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        # references only API_ONE in source; sneaks at API_TWO via getattr
        {"file": "01-sneak.py", "name": "Sneak", "description": "",
         "code": 'from autowright import log, secrets\nok = secrets.API_ONE\nlog("got one")\n'
                 'x = getattr(secrets, "API_TWO")\nlog("got two")\n'},
        # makes API_TWO a known reference so the engine pre-check fetches it
        {"file": "02-legit.py", "name": "Legit", "description": "",
         "code": "from autowright import secrets\ny = secrets.API_TWO\n"},
    ]
    a = store.create_automation(ver, "Scoped", None)
    store.patch_automation(a, {"allowedSecrets": ["API_ONE", "API_TWO"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    logs = read_all_logs(store, h["id"])
    assert any("got one" in l["text"] for l in logs)
    assert not any("got two" in l["text"] for l in logs)
    # §6/§7: the diagnostic names the real fix (declare the secret on the
    # step), never "not in your Keychain" — the Keychain does hold it.
    assert any("API_TWO" in l["text"] and "wasn't injected into this step" in l["text"]
               for l in logs)


def test_log_files_per_step_attempt(store):
    """§5 logs/ layout: one NDJSON file per (step, attempt) named
    <stem>.a<n>.ndjson; stored lines are {timestamp, kind, sequence, text} with a per-file
    seq — read_log derives the local `t` label at serialization, which is
    what the shape assertion below sees."""
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Attributed", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    logs_dir = store.exec_dir(h["id"]) / "logs"
    assert (logs_dir / "01-say.a1.ndjson").exists()
    assert (logs_dir / "02-finish.a1.ndjson").exists()
    step1 = store.read_log(h["id"], 0, 1)
    for l in step1:
        assert set(l) == {"timestamp", "time", "kind", "sequence", "text"}
    assert [l["sequence"] for l in step1] == list(range(1, len(step1) + 1))
    texts = [l["text"] for l in step1]
    assert "▸ Step 1 — Say hello" in texts and "hello x3" in texts
    assert any("▸ Step 2 — Finish" in l["text"] for l in store.read_log(h["id"], 1, 1))
    # the full exec payload carries steps+attempts but never inline logs (§19)
    served = store.exec_json(h, full=True)
    assert "logs" not in served
    assert [s["attempts"][0]["number"] for s in served["steps"]] == [1, 1]


def test_execution_level_lines_go_to_execution_log(store):
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Attributed Fail", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    exec_log = store.read_log(h["id"])
    assert any(l["text"].startswith("execution failed") for l in exec_log)
    # the step's own lines are NOT in the execution log
    assert not any("boom" in l["text"] for l in exec_log)
    assert any("boom" in l["text"] for l in store.read_log(h["id"], 0, 1))


def test_finished_at_persisted_and_reloaded(store):
    import sqlite3
    from autowright.engine import Engine
    from autowright.storage import Store
    from datetime import datetime

    engine = Engine(store)
    a = store.create_automation(make_version(), "Finisher", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["finished_at"]
    datetime.fromisoformat(h["finished_at"])  # ISO 8601, same format as started_at
    db = sqlite3.connect(store.executions_dir() / "executions.db")
    (finished_ms,) = db.execute("SELECT finished_at FROM executions WHERE id=?", (h["id"],)).fetchone()
    db.close()
    # §5: the yaml keeps microseconds, the index column milliseconds — same instant
    assert abs(datetime.fromisoformat(h["finished_at"]).timestamp() * 1000 - finished_ms) < 1
    s2 = Store()
    s2.load_all()
    # reloaded header comes off the ms-precision index — same instant
    reloaded = s2.execs[h["id"]]["finished_at"]
    assert abs(datetime.fromisoformat(reloaded).timestamp()
               - datetime.fromisoformat(h["finished_at"]).timestamp()) < 0.001


def test_agent_step_without_enabled_agent_fails(store):
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ask.py", "name": "Ask", "description": "", "agent": True, "why": "judgment",
         "code": 'from autowright import agent\nagent.ask("hi")\n'},
    ]
    a = store.create_automation(ver, "Agentless", None, enabled_agents=[])
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert any("needs an agent" in l["text"] for l in read_all_logs(store, h["id"]))


def test_failure_diagnostics_on_execution_record(store):
    """§7: a failed step's exception becomes §4.5 `error` — step, message, reason."""
    from autowright.engine import Engine
    from autowright.storage import Store

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'd = {}\nprint(d["missing"])\n'
    a = store.create_automation(ver, "Diag", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    err = h["error"]
    assert err["step"] == "Say hello"
    assert err["message"].startswith("KeyError")
    assert "expected shape" in err["reason"]
    assert store.exec_json(h)["error"] == err
    # survives the DB round-trip at the next startup
    s2 = Store()
    s2.load_all()
    assert s2.execs[h["id"]]["error"] == err


def test_failure_reason_null_when_unclassified(store):
    """§7: a failure that fits no known category keeps message, reason null."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("the page had no rows")\n'
    a = store.create_automation(ver, "Plain fail", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["error"]["message"] == "RuntimeError: the page had no rows"
    assert h["error"]["reason"] is None


def test_failure_error_absent_on_success(store):
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Fine", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert h["error"] is None
    assert store.exec_json(h)["error"] is None


def test_failure_error_message_redacted(store):
    """§7: the error message is redacted like any log line."""
    from autowright import keychain
    from autowright.engine import Engine

    keychain.set_secret("API_KEY", "sekret-42")
    store.secrets.append({"name": "API_KEY", "description": ""})
    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'from autowright import secrets\nk = secrets.API_KEY\nraise RuntimeError(f"bad key {k}")\n'
    a = store.create_automation(ver, "Leaky fail", None)
    store.patch_automation(a, {"allowedSecrets": ["API_KEY"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert "sekret-42" not in h["error"]["message"]
    assert "•••" in h["error"]["message"]


def test_failure_reason_timeout(store, monkeypatch):
    """§7: a timed-out step gets the time-limit reason."""
    from autowright.engine import Engine

    monkeypatch.setenv("AUTOWRIGHT_STEP_TIMEOUT", "1")
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-hang.py", "name": "Hang", "description": "",
         "code": "import time\ntime.sleep(30)\n"},
    ]
    a = store.create_automation(ver, "Slow", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"], timeout=15)
    assert h["error"]["step"] == "Hang"
    assert "timed out" in h["error"]["message"]
    assert "time limit" in h["error"]["reason"]


def test_failure_reason_disallowed_import(store):
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "import numpy\n"
    a = store.create_automation(ver, "Bad import", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert "isn't allowed" in h["error"]["message"]
    assert h["error"]["reason"] == "The step imports a package outside the allowed list."


def test_failure_reason_missing_secret_before_step_one(store):
    """§7: the pre-step secret check sets `error` with a null step."""
    from autowright.engine import Engine

    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = "from autowright import secrets\nx = secrets.NOT_THERE\n"
    a = store.create_automation(ver, "No secret", None)
    store.patch_automation(a, {"allowedSecrets": ["NOT_THERE"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["error"]["step"] is None
    assert "isn't in your Keychain" in h["error"]["message"]
    assert "Keychain" in h["error"]["reason"]


def test_pre_version_snapshot_on_first_execution(store):
    # §6.3: the engine snapshots memory right before the first execution of a
    # version with no recorded execution yet — real versions only, never Draft.
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Snap Ver", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert store.list_snapshots(a) == []  # memory was empty → skipped

    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("x: 1\n")
    h2 = engine.start(a, "manual")
    wait_done(engine, h2["id"])
    assert store.list_snapshots(a) == []  # v1 already executed → not a first execution

    n = store.save_new_version(a, make_version())
    h3 = engine.start(a, "manual")
    wait_done(engine, h3["id"])
    snaps = store.list_snapshots(a)
    assert [s["reason"] for s in snaps] == ["pre-version"]
    assert snaps[0]["version"] == f"v{n}"

    h4 = engine.start(a, "manual")
    wait_done(engine, h4["id"])
    assert len(store.list_snapshots(a)) == 1  # vN's later executions don't snapshot again


def test_pre_version_snapshot_toggle_off(store):
    # §6.3: the pre_version toggle off → the first-execution snapshot is skipped.
    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "No Snap Ver", None)
    store.patch_automation(a, {"snapshotSettings": {"preVersion": False}})
    (store.auto_dir(a) / "memory" / "seen.yaml").write_text("x: 1\n")
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert store.list_snapshots(a) == []


def wait_test_summary(container, timeout=30):
    """The summary lands after the engine thread finishes — poll for it."""
    t0 = time.time()
    while not (container / "test.yaml").exists():
        assert time.time() - t0 < timeout, "test summary never landed"
        time.sleep(0.05)


def test_draft_test_is_a_test_execution_record(store, monkeypatch):
    """§11: a test is a §4.5 test execution record through the ordinary engine
    path — workspace/result/logs under executions/<uuid>/, scripts in steps/,
    result like any execution's — and never touches the automation's derived
    display state. The last-test summary carries the exec id."""
    from autowright import testexec as tr
    from autowright.engine import Engine

    monkeypatch.setattr(tr, "store", store)
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [{
        "file": "01-make.py", "name": "Make", "description": "",
        "code": ('from autowright import result\nopen("scratch.txt", "w").write("wip")\n'  # cwd = workspace
                 '(result / "out.md").write_text("# hi")\n'
                 'result.chip("Made it")\n'),
    }]
    a = store.create_automation(ver, "Draft Tester", None)
    store.save_draft(a, ver)

    eid = tr.start(engine, ver, a, [], [], {})
    wait_done(engine, eid)
    dd = store.auto_dir(a) / "draft"
    wait_test_summary(dd)

    h = store.execs[eid]
    assert h["kind"] == "test" and h["trigger"] == "test"
    assert store.exec_json(h)["test"] is True and store.exec_json(h)["ver"] == "Test"
    assert h["status"] == "succeeded"
    ed = store.exec_dir(eid)
    assert (ed / "steps" / "01-make.py").exists()
    assert (ed / "workspace" / "scratch.txt").read_text() == "wip"
    assert (ed / "result" / "out.md").read_text() == "# hi"
    res = store.result_json(h)
    assert res["chip"] == "Made it"
    assert {f["name"] for f in res["files"]} == {"out.md"}
    assert res["path"] == str(ed / "result")

    # §4.5: derived display state ignores test records
    assert a["_last_status"] == "none" and not a.get("_live")
    j = store.auto_json(a)
    assert j["lastStatus"] == "none" and j["latest"] is None

    # §11: the last-test summary rides draft.test with the exec id
    dj = j["draft"]
    assert dj["test"]["status"] == "succeeded"
    assert dj["test"]["when"]
    assert dj["test"]["executionId"] == eid

    # §11 keep-latest: the next test deletes the previous record …
    eid2 = tr.start(engine, ver, a, [], [], {})
    wait_done(engine, eid2)
    wait_test_summary(dd)
    assert eid not in store.execs and eid2 in store.execs

    # … and a settled draft deletes its test records.
    store.delete_draft(a)
    assert eid2 not in store.execs


def test_create_mode_test_records_without_automation(store, monkeypatch):
    """§11 create mode: no automation yet — the record carries automation_id None
    and the summary lands in the §4.4 pending slot."""
    from autowright import paths
    from autowright import testexec as tr
    from autowright.engine import Engine

    monkeypatch.setattr(tr, "store", store)
    engine = Engine(store)
    ver = make_version()
    ver["name"] = "Pending Tester"
    ver["steps"] = [{
        "file": "01-make.py", "name": "Make", "description": "",
        "code": ('from autowright import result\n(result / "out.md").write_text("# hi")\n'
                 'result.status("ok")\n'),
    }]

    eid = tr.start(engine, ver, None, [], [], {})
    wait_done(engine, eid)
    slot = paths.pending_draft_dir()
    wait_test_summary(slot)

    h = store.execs[eid]
    assert h["kind"] == "test" and h["automation_id"] is None and h["automation_name"] == "Pending Tester"
    assert h["status"] == "succeeded"
    res = store.result_json(h)
    assert {f["name"] for f in res["files"]} == {"out.md"}

    # §11: the summary persists in the slot and rides the pending payload
    store.save_pending_draft(ver, "Pending Tester", None, None)
    pj = store.pending_draft_json()
    assert pj["draft"]["test"]["status"] == "succeeded"
    assert pj["draft"]["test"]["executionId"] == eid

    # Settling the slot deletes its test records too.
    store.delete_pending_draft()
    assert eid not in store.execs


def test_agent_step_multiple_agents_pick_by_name(store):
    """§6: a step's `agents` grant names resolve in order — the first serves
    plain agent.ask, and agent.ask(..., agent="Name") picks another."""
    from autowright.engine import Engine

    store.agents = [
        {"id": "f", "name": "Fast", "harness": "Claude Code", "model": "x"},
        {"id": "s", "name": "Slow", "harness": "Claude Code", "model": "y"},
    ]
    store.default_agent_id = "f"
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-ask.py", "name": "Ask", "description": "", "agent": True, "why": "judgment",
         "agents": ["Slow", "Fast"],
         "code": 'from autowright import agent, result\na = agent.ask("question: one")\n'
                 'b = agent.ask("question: two", agent="Fast")\n'
                 'result.status("ok")\n'},
    ]
    a = store.create_automation(ver, "Multi", None, enabled_agents=["f", "s"])
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    logs = [l["text"] for l in read_all_logs(store, h["id"])]
    assert any(t.startswith("agent query → Slow") for t in logs)
    assert any(t.startswith("agent query → Fast") for t in logs)


def test_declared_step_secrets_injected(store):
    """§6: a secret declared in the step manifest is injected even when the
    code never references it as a literal secrets.NAME."""
    from autowright import keychain
    from autowright.engine import Engine

    keychain.set_secret("MY_TOKEN", "sekret")
    engine = Engine(store)
    ver = make_version()
    ver["steps"] = [
        {"file": "01-use.py", "name": "Use", "description": "", "secrets": ["MY_TOKEN"],
         "code": 'from autowright import log, result, secrets\nv = getattr(secrets, "MY" + "_TOKEN")\n'
                 'log(f"got {len(v)} chars")\nresult.status("ok")\n'},
    ]
    a = store.create_automation(ver, "Sec", None, allowed_secrets=["MY_TOKEN"])
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert any("got 6 chars" in l["text"] for l in read_all_logs(store, h["id"]))


def test_failure_reason_classification_direct():
    """§7 failure_reason: deterministic classification from exit code + the
    executor's structured error event."""
    from autowright.engine import failure_reason

    agent = "The step's agent call failed — the agent may be unreachable or misconfigured."
    net = "A network request failed — the site may be down, blocking, or unreachable."
    shape = "The data didn't have the expected shape — a page or file layout may have changed."
    assert failure_reason(1, {"type": "AgentCallError", "message": "agent exploded"}) == agent
    # HTTP: status code extracted from the message when present
    assert failure_reason(1, {"type": "HTTPError",
                              "message": "404 Client Error: Not Found for url: https://x"}) \
        == "The site answered with an error (HTTP 404)."
    assert failure_reason(1, {"type": "HTTPStatusError", "message": "boom"}) \
        == "The site answered with an error."
    # message-only match, no recognized type
    assert failure_reason(1, {"type": "RuntimeError",
                              "message": "503 Server Error: unavailable"}) \
        == "The site answered with an error (HTTP 503)."
    # network exception types (_NET_TYPES)
    for t in ("ConnectionError", "gaierror", "MaxRetryError", "SSLError", "TimeoutError"):
        assert failure_reason(1, {"type": t, "message": "x"}) == net
    # message-based network matches
    assert failure_reason(1, {"type": "RuntimeError",
                              "message": "couldn't fetch https://x"}) == net
    assert failure_reason(1, {"type": "RuntimeError",
                              "message": "robots.txt disallows fetching /page"}) == net
    # data-shape exceptions
    assert failure_reason(1, {"type": "IndexError", "message": "list index out of range"}) == shape
    assert failure_reason(1, {"type": "AttributeError", "message": "no attr"}) == shape
    # rc 3 + MissingSecret: the message picks the variant
    assert failure_reason(3, {"type": "MissingSecret",
                              "message": "secret X wasn't injected into this step — steps only "
                                         "receive the secrets they reference"}) \
        == "The step reads a secret it doesn't declare — add it to the step's secrets list."
    assert failure_reason(3, {"type": "MissingSecret",
                              "message": "secret X is not allowed for this automation"}) \
        == "The script references a secret that doesn't exist."
    # a script calling sys.exit(3) is just a script exiting 3, not a secret failure
    assert failure_reason(3, {"type": "RuntimeError", "message": "boom"}) is None
    # unclassified → None
    assert failure_reason(1, {"type": "RuntimeError", "message": "nothing known"}) is None
    assert failure_reason(1, None) is None


def _notify_recorder(monkeypatch):
    """Replace notify.post (already no-op'd by conftest) with a recorder —
    the engine calls it through the module attribute."""
    from autowright import notify

    calls = []
    monkeypatch.setattr(notify, "post", lambda title, body: calls.append((title, body)))
    return calls


def test_notification_gating_attention_setting(store, monkeypatch):
    """§4.9 default setting: success with an ordinary result is silent; a
    failure notifies with the automation name and the default body."""
    from autowright.engine import Engine

    calls = _notify_recorder(monkeypatch)
    assert store.settings.get("notifications", "attention") == "attention"
    engine = Engine(store)
    a = store.create_automation(make_version(), "Quiet Auto", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert calls == []  # result.status("ok") isn't interesting
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    b = store.create_automation(ver, "Loud Fail", None)
    h2 = engine.start(b, "manual")
    wait_done(engine, h2["id"])
    assert h2["status"] == "failed"
    assert calls == [("Loud Fail", "Execution failed")]


def test_notification_all_setting_and_body_precedence(store, monkeypatch):
    """§4.9 "all": success notifies too, body = the result chip; a step's
    notify() text overrides the chip."""
    from autowright.engine import Engine

    calls = _notify_recorder(monkeypatch)
    store.settings["notifications"] = "all"
    engine = Engine(store)
    a = store.create_automation(make_version(), "Chatty", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"
    assert calls == [("Chatty", "All good")]  # chip becomes the body
    ver = make_version()
    ver["steps"][1]["code"] = ('from autowright import notify, result\nresult.status("ok")\nresult.chip("Chip text")\n'
                               'notify("Custom notify text")\n')
    b = store.create_automation(ver, "Override", None)
    h2 = engine.start(b, "manual")
    wait_done(engine, h2["id"])
    assert h2["status"] == "succeeded"
    assert calls[-1] == ("Override", "Custom notify text")  # notify() beats the chip


def test_notification_title_param_overrides_automation_name(store, monkeypatch):
    from autowright.engine import Engine

    calls = _notify_recorder(monkeypatch)
    engine = Engine(store)
    ver = make_version()
    ver["params"].append({"name": "notification_title", "kind": "text",
                          "label": "Title", "help": "", "default": "My Title"})
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Titled", None)
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    assert calls == [("My Title", "Execution failed")]


def test_agents_for_step_duplicate_grant_names_first_enabled_wins():
    """§6/§8: two enabled agents sharing a grant name — the first enabled one
    serves the step; unknown names fall back to the first enabled agent."""
    from autowright.engine import agents_for_step

    a1 = {"id": "a1", "name": "Shared", "harness": "Claude Code", "model": "x"}
    a2 = {"id": "a2", "name": "Shared", "harness": "Codex", "model": "y"}
    agents = {"a1": a1, "a2": a2}
    assert agents_for_step(agents, ["a1", "a2"], {"agents": ["Shared"]}) == [a1]
    assert agents_for_step(agents, ["a2", "a1"], {"agents": ["Shared"]}) == [a2]
    # no resolvable names → first enabled agent
    assert agents_for_step(agents, ["a2", "a1"], {"agents": ["Nope"]}) == [a2]


def test_draft_retry_rejected_after_step_code_drift(store):
    """§7: a re-saved draft whose step code changed (same names/files, new sha)
    can't serve an in-place retry of the old failed record."""
    import pytest

    from autowright.engine import Engine

    engine = Engine(store)
    a = store.create_automation(make_version(), "Drifter", None)
    dver = make_version()
    dver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    store.save_draft(a, dver)
    h = engine.start(a, "manual", version_label="Draft")
    wait_done(engine, h["id"])
    assert h["status"] == "failed"
    dver2 = make_version()
    dver2["steps"][0]["code"] = 'from autowright import log\nlog("edited since the failure")\n'  # same file/name, new sha
    store.save_draft(a, dver2)
    with pytest.raises(RuntimeError, match="steps changed"):
        engine.retry(a, h)


def test_memory_save_commits_atomically(store, tmp_path):
    """§6: memory.save renames a fully-written temp file over the target, so a
    concurrent execution never reads a partial file and a crash mid-write leaves
    the previous version intact."""
    from autowright.executor import Memory

    m = Memory(str(tmp_path / "memory"))
    m.save("notes", {"a": 1})
    assert m.load("notes") == {"a": 1}

    # a failure while serializing leaves the previous value and no temp litter
    class Boom:
        pass

    try:
        m.save("notes", Boom())  # yaml can't represent it
    except Exception:
        pass
    assert m.load("notes") == {"a": 1}
    assert [p.name for p in (tmp_path / "memory").iterdir()] == ["notes.yaml"]

    m.save("notes", {"a": 2})  # overwrite still works
    assert m.load("notes") == {"a": 2}


def test_chip_and_notification_are_redacted(store, monkeypatch):
    """§6.1: the chip is persisted on the execution record and the notification
    body leaves the app entirely (osascript argv, Notification Center) — both
    get the same redaction a log line gets."""
    from autowright import keychain, notify
    from autowright.engine import Engine

    posted = []
    monkeypatch.setattr(notify, "post", lambda title, body: posted.append((title, body)))

    keychain.set_secret("API_KEY", "super-secret-value-123")
    store.secrets.append({"name": "API_KEY", "description": ""})
    engine = Engine(store)
    ver = make_version()
    # the last step owns the chip (the fixture's step 2 would overwrite it)
    ver["steps"][-1]["code"] = (
        "from autowright import notify, result, secrets\n"
        "k = secrets.API_KEY\n"
        # 'attention' so the §4.9 default notification setting actually fires
        "result.status('attention')\n"
        "result.chip(f'balance {k}')\n"
        "notify(f'done {k}')\n")
    a = store.create_automation(ver, "Chippy", None)
    store.patch_automation(a, {"allowedSecrets": ["API_KEY"]})
    h = engine.start(a, "manual")
    wait_done(engine, h["id"])
    assert h["status"] == "succeeded"

    assert "super-secret-value-123" not in h["chip"]
    assert "•••" in h["chip"]
    assert "API_KEY" in h["redacted_secrets"]
    # and the same value never reaches the OS notification
    assert posted, "expected a notification"
    assert not any("super-secret-value-123" in body for _, body in posted)


def test_reply_carrying_a_secret_is_never_sent(store, monkeypatch):
    """§6.1: a reply goes to a third party (Discord/iMessage) — a secret value
    in it must abort the send, not be redacted into it."""
    from autowright import keychain, listeners
    from autowright.engine import Engine

    sent = []
    monkeypatch.setattr(listeners, "send_reply",
                        lambda payload, text: sent.append(text) or None)

    keychain.set_secret("API_KEY", "super-secret-value-123")
    store.secrets.append({"name": "API_KEY", "description": ""})
    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = (
        "from autowright import reply, secrets\n"
        "reply(f'token is {secrets.API_KEY}')\n")
    a = store.create_automation(ver, "Leaky reply", None)
    store.patch_automation(a, {"allowedSecrets": ["API_KEY"]})
    h = engine.start(a, "discord", payload={"kind": "discord", "channel": "c1",
                                            "secret": "BOT", "sender": "u1"})
    wait_done(engine, h["id"])

    assert sent == [], "a secret value must never reach the outbound send"
    logs = read_all_logs(store, h["id"])
    assert not any("super-secret-value-123" in l["text"] for l in logs)


def test_engine_side_reply_gate_blocks_raw_control_line(store, monkeypatch):
    """§6.1: the engine re-scans a reply right before the network send — a step
    that bypasses the executor's reply() scan by writing a raw control line
    straight to fd 1 still can't leak a secret value."""
    from autowright import keychain, listeners
    from autowright.engine import Engine
    from autowright.executor import CTRL

    sent = []
    monkeypatch.setattr(listeners, "send_reply",
                        lambda payload, text: sent.append(text) or None)

    keychain.set_secret("API_KEY", "super-secret-value-123")
    store.secrets.append({"name": "API_KEY", "description": ""})
    engine = Engine(store)
    ver = make_version()
    ver["steps"][0]["code"] = (
        "import json, os\n"
        "from autowright import secrets\n"
        f"line = {CTRL!r} + json.dumps({{'op': 'reply', 'text': secrets.API_KEY}}) + '\\n'\n"
        "os.write(1, line.encode())\n")
    a = store.create_automation(ver, "Sneaky reply", None)
    store.patch_automation(a, {"allowedSecrets": ["API_KEY"]})
    h = engine.start(a, "discord", payload={"kind": "discord", "channel": "c1",
                                            "secret": "BOT", "sender": "u1"})
    wait_done(engine, h["id"])

    assert sent == [], "the engine-side gate must drop the send entirely"
    logs = read_all_logs(store, h["id"])
    assert any("reply blocked — it contains the value of secret API_KEY" in l["text"]
               for l in logs)
    assert not any("super-secret-value-123" in l["text"] for l in logs)
