"""Backend entry point (§3/§4.9): the access-log developerMode filter."""
import logging


def _record(args):
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                             "%s", args, None)


def test_devmode_filter_scrubs_ws_token(home):
    # §4.9: the WS handshake carries the sole credential in the query string —
    # the access log must never copy it into backend.out.log.
    from autowright.main import _DevModeFilter

    f = _DevModeFilter()
    rec = _record(("GET /ws?token=abc123", 200, None))
    f.filter(rec)
    assert rec.args[0] == "GET /ws?token=***"  # value scrubbed, path kept
    assert rec.args[1:] == (200, None)  # non-str args untouched

    # a token mid-query keeps the surrounding parameters
    rec = _record(("GET /ws?a=1&token=s3cret&b=2",))
    f.filter(rec)
    assert rec.args == ("GET /ws?a=1&token=***&b=2",)


def test_devmode_filter_gates_info_lines(home):
    # §4.9: INFO request lines pass only while developerMode is on; WARNING+ always.
    from autowright.main import _DevModeFilter
    from autowright.storage import store

    store.load_all()
    f = _DevModeFilter()
    info = _record(("GET /state",))
    warn = logging.LogRecord("uvicorn.error", logging.WARNING, __file__, 1,
                             "%s", ("boom",), None)
    store.settings["developerMode"] = False
    assert f.filter(info) is False
    assert f.filter(warn) is True
    store.settings["developerMode"] = True
    assert f.filter(info) is True
    store.settings.pop("developerMode", None)  # the store is a module singleton


def test_boot_reconciles_keep_awake_from_settings(home, monkeypatch):
    # §3/§4.9: main() reconciles the permanent keepAwake assertion at boot with
    # the persisted setting's value, through the §2 platform layer.
    # Server/scheduler/listeners are stubbed — only the boot sequence up to
    # (and past) the reconcile call runs.
    import dataclasses

    from autowright import main as main_mod
    from autowright import paths
    from autowright import platform as platmod
    from autowright.yamlio import save_yaml

    save_yaml(paths.settings_file(), {"keepAwake": False})  # non-default value

    calls = []

    class RecordingPower:
        def reconcile(self, enabled: bool) -> None:
            calls.append(enabled)

        def hold_execution(self):
            return lambda: None

    fake = dataclasses.replace(platmod.current(), power=RecordingPower())
    monkeypatch.setattr(platmod, "current", lambda: fake)

    class _Stub:
        def __init__(self, *a, **kw):
            pass

        def start(self):
            pass

        def stop(self):
            pass

    class _Server:
        def __init__(self, config):
            pass

        def run(self, sockets=None):
            pass

    monkeypatch.setattr(main_mod, "Scheduler", _Stub)
    monkeypatch.setattr(main_mod, "Listeners", _Stub)
    monkeypatch.setattr(main_mod.uvicorn, "Server", _Server)
    try:
        main_mod.main()
    finally:
        # main() attaches its developerMode filter to the live root handlers — strip
        # it so later tests' log capture isn't gated by this suite's settings.
        for hnd in logging.getLogger().handlers:
            for f in list(hnd.filters):
                if isinstance(f, main_mod._DevModeFilter):
                    hnd.removeFilter(f)
    assert calls == [False]  # the setting's value, not the default
