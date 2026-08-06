"""Display-label formatting (§4.1 shared timestamp scheme)."""
import calendar
from datetime import datetime, timedelta

NOW = datetime(2026, 7, 23, 12, 0, 0)  # a Thursday


def test_clock_12h():
    from autowright.timefmt import clock

    assert clock(datetime(2026, 7, 23, 0, 0)) == "12:00 AM"   # midnight
    assert clock(datetime(2026, 7, 23, 12, 0)) == "12:00 PM"  # noon
    assert clock(datetime(2026, 7, 23, 13, 5)) == "1:05 PM"
    assert clock(datetime(2026, 7, 23, 9, 7)) == "9:07 AM"    # zero-padded minutes


def test_date_label_today_and_yesterday():
    from autowright.timefmt import date_label

    assert date_label(NOW, NOW) == "Today"
    # earlier the same day is still "Today" — the label compares dates, not deltas
    assert date_label(NOW.replace(hour=0, minute=1), NOW) == "Today"
    assert date_label(NOW - timedelta(days=1), NOW) == "Yesterday"


def test_date_label_recent_days_use_weekday_name():
    from autowright.timefmt import date_label

    for days in (2, 6):
        dt = NOW - timedelta(days=days)
        assert date_label(dt, NOW) == dt.strftime("%A")


def test_date_label_week_or_older_uses_locale_date():
    from autowright.timefmt import date_label

    dt = NOW - timedelta(days=7)
    label = date_label(dt, NOW)
    # §4.1: ≥7 days ago falls back to the locale date. The exact string is
    # locale-dependent, so assert only that it left the named-label scheme.
    assert label not in ("Today", "Yesterday")
    assert label not in list(calendar.day_name)
    assert label  # non-empty


def test_started_label_combines_date_and_clock():
    from autowright.timefmt import clock, date_label, started_label

    dt = NOW - timedelta(days=1)
    assert started_label(dt, NOW) == f"{date_label(dt, NOW)}, {clock(dt)}"
    assert started_label(dt, NOW) == "Yesterday, 12:00 PM"


def test_dur_label():
    from autowright.timefmt import dur_label

    # None (still running / never finished) renders as the em-dash placeholder
    assert dur_label(None) == "—"
    assert dur_label(1500) == "1.5s"
    assert dur_label(59_949) == "59.9s"     # sub-minute keeps one decimal
    assert dur_label(60_000) == "1m 0s"
    assert dur_label(125_000) == "2m 5s"
    assert dur_label(0) == "0.0s"


# ---------- §5 canonical stored timestamps ----------

def test_now_iso_canonical_form():
    """§5: stored timestamps are UTC ISO-8601 with the +00:00 offset and
    microsecond precision — lexicographic order equals chronological order."""
    import re
    from datetime import datetime, timezone

    from autowright.timefmt import now_iso

    s = now_iso()
    if "." not in s:  # microsecond == 0 collapses isoformat — sample again
        s = now_iso()
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00", s)
    assert datetime.fromisoformat(s).utcoffset() == timezone.utc.utcoffset(None)


def test_parse_local_aware_converts_and_naive_reads_as_local():
    from datetime import datetime, timezone

    from autowright.timefmt import parse_local

    # aware input: the instant is preserved, the tz becomes local
    iso = "2026-08-01T15:04:05.123456+00:00"
    d = parse_local(iso)
    assert d.tzinfo is not None
    assert d == datetime(2026, 8, 1, 15, 4, 5, 123456, tzinfo=timezone.utc)
    # a non-UTC offset converts too — same instant either way
    assert parse_local("2026-08-01T17:04:05.123456+02:00") == d

    # naive input (the hand-edited fallback) is read as LOCAL wall-clock time:
    # the wall clock survives and the local offset is attached
    n = parse_local("2026-08-01T15:04:05")
    assert n.tzinfo is not None
    assert n.replace(tzinfo=None) == datetime(2026, 8, 1, 15, 4, 5)
    assert n.utcoffset() == datetime(2026, 8, 1, 15, 4, 5).astimezone().utcoffset()
