"""SQLite execution index (§5) — schema wipe on version bump, upsert, time codecs."""


def make_header(**over):
    h = {
        "id": "e-1", "auto_id": "a-1", "auto_name": "Job",
        "kind": "version", "version": 1,
        "status": "executing", "trigger": "manual",
        "queued_at": None,
        "started_at": "2026-07-20T08:30:00+00:00", "finished_at": None,
        "dur_ms": None, "note": None, "chip": None, "chip_status": None,
        "error": None,
    }
    h.update(over)
    return h


def _db_path(home):
    return home / "executions" / "executions.db"


def test_schema_version_bump_recreates_empty_table(home, monkeypatch):
    from autowright import execdb

    db = execdb.ExecDB(_db_path(home))
    db.upsert(make_header())
    assert set(db.load_all()) == {"e-1"}
    db.close()

    # same version → rows survive a reopen
    db = execdb.ExecDB(_db_path(home))
    assert set(db.load_all()) == {"e-1"}
    db.close()

    # §5: the DB is only an index — a schema bump drops the table and lets the
    # startup yaml reconcile rebuild it (yaml is the source of truth).
    monkeypatch.setattr(execdb, "SCHEMA_VERSION", execdb.SCHEMA_VERSION + 1)
    db = execdb.ExecDB(_db_path(home))
    assert db.load_all() == {}
    # the wipe is one-time: rows written under the new version persist
    db.upsert(make_header(id="e-2"))
    db.close()
    db = execdb.ExecDB(_db_path(home))
    assert set(db.load_all()) == {"e-2"}
    db.close()


def test_upsert_updates_mutable_fields_and_roundtrips_error(home):
    from autowright import execdb

    db = execdb.ExecDB(_db_path(home))
    db.upsert(make_header())
    db.upsert(make_header(
        auto_name="Job Renamed", status="failed",
        finished_at="2026-07-20T08:31:05+00:00", dur_ms=65_000,
        note="boom note", chip="2 issues", chip_status="attention",
        error={"step": "01-say.py", "message": "boom", "reason": "crash"},
        # started_at IS mutable on conflict — a §6 queue promotion re-stamps it
        # when the record stops waiting and starts executing
        started_at="2026-07-20T09:00:00+00:00",
        # immutable-on-conflict columns: changed values must NOT stick
        kind="draft", version=9, trigger="cron"))
    h = db.load_all()["e-1"]
    assert h["auto_name"] == "Job Renamed"
    assert h["status"] == "failed"
    assert h["finished_at"] == "2026-07-20T08:31:05+00:00"
    assert h["dur_ms"] == 65_000
    assert h["note"] == "boom note"
    assert h["chip"] == "2 issues" and h["chip_status"] == "attention"
    # the error dict flattens to columns and reconstructs on load
    assert h["error"] == {"step": "01-say.py", "message": "boom", "reason": "crash"}
    # ON CONFLICT updates only the mutable columns — identity fields keep row one's values
    assert h["kind"] == "version" and h["version"] == 1
    assert h["trigger"] == "manual"
    # …but started_at follows the record, so a promoted §6 queue entry sorts by
    # when it actually started rather than when it was admitted
    assert h["started_at"] == "2026-07-20T09:00:00+00:00"

    # row without error_message → error comes back as None (falsy, not a dict)
    db.upsert(make_header(id="e-2"))
    assert db.load_all()["e-2"]["error"] is None
    db.close()


def test_trigger_sender_roundtrips_from_either_shape(home):
    """§4.5 triggerSender: upsert lifts the sender from a live record's
    trigger_payload or accepts the already-lifted trigger_sender (a reloaded
    header, the startup yaml reconcile)."""
    from autowright import execdb

    db = execdb.ExecDB(_db_path(home))
    db.upsert(make_header(trigger="discord", trigger_payload={
        "kind": "discord", "text": "hi", "sender": "Dave", "channel": "#general",
        "messageId": "m1", "guildId": None, "secret": "s", "at": "2026-07-20T08:29:00"}))
    db.upsert(make_header(id="e-2", trigger="discord", trigger_sender="Ana"))
    db.upsert(make_header(id="e-3"))
    rows = db.load_all()
    assert rows["e-1"]["trigger_sender"] == "Dave"
    assert rows["e-2"]["trigger_sender"] == "Ana"
    assert rows["e-3"]["trigger_sender"] is None
    db.close()


def test_ms_iso_roundtrip():
    from autowright.execdb import _iso, _ms

    # §5: canonical timestamps are UTC ISO with offset — the codec round-trips
    # them and re-emits UTC for any parseable input.
    iso = "2026-07-23T09:15:42.123456+00:00"
    ms = _ms(iso)
    assert isinstance(ms, int)
    assert _iso(ms) == "2026-07-23T09:15:42.123000+00:00"  # ms-precision column
    assert _ms(None) is None
    assert _iso(None) is None
