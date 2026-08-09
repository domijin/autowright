"""§6 macOS notifications: the real notify.post escapes title/body into the
osascript argv (exercised against the fake tests/bin/osascript recorder —
the autouse no_notifications fixture yields the unpatched function)."""


def test_post_escapes_quotes_and_backslashes(no_notifications, tmp_path, monkeypatch):
    real_post = no_notifications  # the fixture yields the original notify.post
    log = tmp_path / "osascript.log"
    monkeypatch.setenv("AUTOWRIGHT_TEST_OSASCRIPT_LOG", str(log))

    real_post('Alert "one" \\ two', 'Body "quoted" \\ tail')
    rec = log.read_text()

    # one recorded call: -e plus the AppleScript line
    assert rec.startswith("-e\t")
    assert "display notification" in rec
    # double quotes arrive backslash-escaped so AppleScript sees literal quotes
    assert 'with title "Alert \\"one\\" \\\\ two"' in rec
    assert 'display notification "Body \\"quoted\\" \\\\ tail"' in rec
    # and nothing leaks an unescaped closing quote before the keyword
    assert '"Alert "one""' not in rec


def test_post_swallows_osascript_failure(no_notifications, tmp_path, monkeypatch):
    # §6: notifications are best-effort — a denied/failing osascript never raises.
    real_post = no_notifications
    log = tmp_path / "osascript.log"
    monkeypatch.setenv("AUTOWRIGHT_TEST_OSASCRIPT_LOG", str(log))
    monkeypatch.setenv("AUTOWRIGHT_TEST_OSASCRIPT_FAIL", "1")
    real_post("Title", "Body")  # exit 1 from the fake — swallowed
    assert "display notification" in log.read_text()


def test_post_swallows_a_missing_osascript(no_notifications, tmp_path, monkeypatch):
    # §6: notifications must survive a machine where osascript can't even
    # spawn (PATH broken/sandboxed) — the OSError is swallowed, never raised.
    real_post = no_notifications
    empty = tmp_path / "emptybin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    real_post("Title", "Body")  # FileNotFoundError inside → swallowed
