"""Human display labels for timestamps — one shared scheme (§4.1) — plus the
§5 canonical timestamp helpers: stored timestamps are UTC ISO-8601 with offset
and microsecond precision; local time exists only in display labels."""
from __future__ import annotations

import locale
from datetime import datetime, timezone


def now_iso() -> str:
    """§5 canonical stored timestamp: UTC, offset, microseconds."""
    return datetime.now(timezone.utc).isoformat()


def parse_local(iso: str) -> datetime:
    """A §5 stored timestamp as an aware local-time datetime — the shape every
    display label wants. (A naive input is read as local time, which is the
    only sane reading for a hand-edited file.)"""
    return datetime.fromisoformat(iso).astimezone()

try:
    locale.setlocale(locale.LC_TIME, "")
except locale.Error:
    pass


def clock(dt: datetime) -> str:
    h = dt.hour % 12 or 12
    return f"{h}:{dt.minute:02d} {'PM' if dt.hour >= 12 else 'AM'}"


def _locale_date(dt: datetime) -> str:
    # Under launchd there is no LANG/LC_* env, so LC_TIME stays "C" and %x
    # renders two-digit-year dates ("07/18/26"); fall back to the §4.1 label
    # shape ("7/18/2026") instead.
    if locale.getlocale(locale.LC_TIME) in ((None, None), ("C", ""), ("C", None), ("POSIX", None)):
        return f"{dt.month}/{dt.day}/{dt.year}"
    return dt.strftime("%x")


def date_label(dt: datetime, now: datetime | None = None) -> str:
    """Shared scheme: Today | Yesterday | weekday (2-6 days) | locale date."""
    now = now or datetime.now()
    days = (now.date() - dt.date()).days
    if days == 0:
        return "Today"
    if days == 1:
        return "Yesterday"
    if days < 7:
        return dt.strftime("%A")
    return _locale_date(dt)


def started_label(dt: datetime, now: datetime | None = None) -> str:
    return f"{date_label(dt, now)}, {clock(dt)}"


def dur_label(ms: int | None) -> str:
    if ms is None:
        return "—"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    return f"{int(s // 60)}m {int(s % 60)}s"
