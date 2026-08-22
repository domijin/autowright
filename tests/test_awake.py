"""macOS power assertions (backend/autowright/awake.py): the §4.9 keepAwake
reconcile edge branches and the §3 per-execution hold — subprocess.Popen is
always monkeypatched; no real caffeinate ever spawns."""


class _FakeProc:
    def __init__(self, argv=None, **_kw):
        self.argv = argv
        self.exit_code = None  # None = still running (poll contract)
        self.terminated = False
        self.wait_raises = None

    def poll(self):
        return self.exit_code

    def terminate(self):
        self.terminated = True
        self.exit_code = 0

    def wait(self, timeout=None):
        if self.wait_raises:
            raise self.wait_raises
        return self.exit_code


def test_popen_failure_leaves_no_proc_and_no_exception(monkeypatch):
    # A host without caffeinate (non-macOS test box) must make reconcile a
    # silent no-op: _proc stays None, nothing raises.
    from autowright import awake

    def boom(*a, **kw):
        raise FileNotFoundError("caffeinate not found")

    monkeypatch.setattr(awake, "_proc", None)
    monkeypatch.setattr(awake.subprocess, "Popen", boom)
    awake.reconcile(True)
    assert awake._proc is None
    awake.reconcile(False)  # off with nothing running — also a no-op
    assert awake._proc is None


def test_dead_process_is_respawned(monkeypatch):
    # A caffeinate that died (poll returns an exit code) no longer holds the
    # assertion — the next reconcile(True) spawns a fresh one; a live one is
    # left alone (idempotent).
    import os

    from autowright import awake

    spawned = []

    def fake_popen(argv, **kw):
        p = _FakeProc(argv)
        spawned.append(p)
        return p

    monkeypatch.setattr(awake, "_proc", None)
    monkeypatch.setattr(awake.subprocess, "Popen", fake_popen)
    awake.reconcile(True)
    assert len(spawned) == 1
    assert spawned[0].argv == ["caffeinate", "-i", "-w", str(os.getpid())]
    awake.reconcile(True)  # still alive → no second spawn
    assert len(spawned) == 1
    spawned[0].exit_code = 1  # the subprocess died on its own
    awake.reconcile(True)
    assert len(spawned) == 2
    assert awake._proc is spawned[1]


def test_wait_timeout_is_swallowed_on_stop(monkeypatch):
    # reconcile(False): a wait(timeout=5) that raises is swallowed — the
    # assertion still ends (terminated, _proc cleared), nothing propagates.
    import subprocess

    from autowright import awake

    p = _FakeProc()
    p.wait_raises = subprocess.TimeoutExpired(cmd="caffeinate", timeout=5)
    monkeypatch.setattr(awake, "_proc", p)
    awake.reconcile(False)
    assert p.terminated
    assert awake._proc is None


# ------------------------------------------------- §3 per-execution hold

def test_hold_execution_spawns_a_caffeinate_tied_to_the_backend_pid(monkeypatch):
    """§3: the per-execution assertion is `caffeinate -i -w <backend pid>` —
    tied to this process, so a crashed backend can never leave an orphan
    keeping the Mac awake. The release terminates and reaps it, twice over."""
    import os

    from autowright import awake

    spawned = []

    def fake_popen(argv, **kw):
        p = _FakeProc(argv)
        spawned.append(p)
        return p

    monkeypatch.setattr(awake.subprocess, "Popen", fake_popen)
    release = awake.hold_execution()
    assert [p.argv for p in spawned] == [["caffeinate", "-i", "-w", str(os.getpid())]]
    release()
    assert spawned[0].terminated
    release()  # double release is safe — and never spawns or terminates again
    assert len(spawned) == 1


def test_hold_execution_spawn_failure_returns_a_no_op_release(monkeypatch):
    """A host without caffeinate holds nothing and still hands back a release
    the engine can call (acquiring and releasing never raise)."""
    from autowright import awake

    def boom(*a, **kw):
        raise FileNotFoundError("caffeinate not found")

    monkeypatch.setattr(awake.subprocess, "Popen", boom)
    release = awake.hold_execution()
    release()
    release()


def test_hold_execution_release_swallows_a_wait_timeout(monkeypatch):
    """A wait(timeout=5) that raises is swallowed — the hold still ends."""
    import subprocess

    from autowright import awake

    p = _FakeProc()
    p.wait_raises = subprocess.TimeoutExpired(cmd="caffeinate", timeout=5)
    monkeypatch.setattr(awake.subprocess, "Popen", lambda argv, **kw: p)
    awake.hold_execution()()
    assert p.terminated
