"""Trigger math and display strings (§4.1, §4.3): the cron dialect, one-shot
times, next occurrences, humanized labels, and trigger validation."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

SECRET_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")  # §4.8 — same rule as the Secrets API

DOW_LONG = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

RESERVED_KINDS = ("pubsub",)  # §4.3 message triggers — coming soon

# Unsatisfiable expressions (e.g. "0 0 30 2 *") stop searching after this many days.
_SEARCH_DAYS = 366 * 5


class CronError(ValueError):
    pass


# ---------- cron dialect (§4.3): 5 fields, numbers only, * , - / ----------

_FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"]
_FIELD_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]


def _ascii_digits(s: str) -> bool:
    """ASCII digits only — `str.isdigit()` accepts characters `int()` rejects
    (e.g. '²' raises ValueError), and the renderer's parser is ASCII-only, so
    the two dialects must agree."""
    return bool(s) and s.isascii() and s.isdigit()


def _parse_field(text: str, name: str, lo: int, hi: int) -> tuple[set[int], bool]:
    """One cron field → (matching values, is unrestricted `*`)."""
    out: set[int] = set()
    if not text:
        raise CronError(f"{name} field is empty")
    for item in text.split(","):
        body, sep, step_s = item.partition("/")
        step = 1
        if sep:
            # `sep` not `step_s`: a trailing slash ("5/") must be rejected,
            # matching the renderer's parser — not silently read as step 1.
            if not _ascii_digits(step_s) or int(step_s) < 1:
                raise CronError(f"{name}: bad step {item!r}")
            step = int(step_s)
        if body == "*":
            a, b = lo, hi
        elif "-" in body:
            a_s, _, b_s = body.partition("-")
            if not (_ascii_digits(a_s) and _ascii_digits(b_s)):
                raise CronError(f"{name}: bad range {item!r}")
            a, b = int(a_s), int(b_s)
        elif _ascii_digits(body):
            a = b = int(body)
        else:
            raise CronError(f"{name}: bad value {item!r} (numbers only)")
        if not (lo <= a <= hi and lo <= b <= hi and a <= b):
            raise CronError(f"{name}: {item!r} out of range {lo}-{hi}")
        out.update(range(a, b + 1, step))
    return out, text == "*"


def parse_cron(expr: str) -> list[tuple[set[int], bool]]:
    """Validate + expand a §4.3 cron expression; raises CronError."""
    if expr is not None and not isinstance(expr, str):
        # A non-string expr (YAML int in an import archive, a raw API payload)
        # must answer the ordinary 422, not crash with AttributeError.
        raise CronError("the cron expression must be a string")
    fields = (expr or "").split()
    if len(fields) != 5:
        raise CronError("a cron expression needs 5 fields (minute hour day month weekday)")
    return [_parse_field(f, n, lo, hi)
            for f, n, (lo, hi) in zip(fields, _FIELD_NAMES, _FIELD_RANGES)]


def cron_next(expr: str, after: datetime | None = None) -> datetime | None:
    """Next match strictly after `after` (local wall clock), None if unsatisfiable."""
    (mins, _), (hours, _), (doms, dom_star), (months, _), (dows, dow_star) = parse_cron(expr)
    t = (after or datetime.now()).replace(second=0, microsecond=0) + timedelta(minutes=1)
    hhmm = [(hh, mm) for hh in sorted(hours) for mm in sorted(mins)]
    day = t.date()
    for _ in range(_SEARCH_DAYS):
        if day.month in months:
            spec_dow = (day.weekday() + 1) % 7  # weekday(): Mon=0 → spec Sun=0
            # Vixie rule: both dom and dow restricted → a date matching either fires.
            if (day.day in doms if dow_star else
                    spec_dow in dows if dom_star else
                    day.day in doms or spec_dow in dows):
                floor = t if day == t.date() else datetime.combine(day, time.min)
                for hh, mm in hhmm:
                    cand = datetime(day.year, day.month, day.day, hh, mm)
                    if cand >= floor:
                        return cand
        day += timedelta(days=1)
    return None


# ---------- timezone (§4.3 `tz`): wall clock in the trigger's zone ----------

def zone_of(t: dict) -> ZoneInfo | None:
    """The trigger's zone, None when local. Assumes a validated `tz`."""
    return ZoneInfo(t["timezone"]) if t.get("timezone") else None


def _to_wall(local: datetime, tz: ZoneInfo) -> datetime:
    """Local naive → the zone's naive wall clock."""
    return local.astimezone(tz).replace(tzinfo=None)


def _round_trips(wall: datetime, tz: ZoneInfo) -> bool:
    """True when `wall` is a real wall time in `tz` (not erased by a
    spring-forward gap)."""
    return wall.replace(tzinfo=tz, fold=0).astimezone(timezone.utc) \
               .astimezone(tz).replace(tzinfo=None) == wall


def _wall_to_local(wall: datetime, tz: ZoneInfo, after: datetime | None) -> datetime | None:
    """The zone's naive wall clock → local naive, DST-transition-aware.

    The naive `wall.replace(tzinfo=tz)` conversion is non-monotonic around the
    zone's transitions (an ambiguous fall-back time reads as the *earlier*
    instant, which can land before `after` and make the scheduler re-fire one
    occurrence every tick). Rules here: an ambiguous wall time picks the
    earliest reading strictly after `after` (§4.3: one repeated by fall-back
    fires once); a nonexistent wall time fires at the next valid minute
    (§4.3); returns None when every reading is ≤ `after`."""
    d0, d1 = wall.replace(tzinfo=tz, fold=0), wall.replace(tzinfo=tz, fold=1)
    if d0.utcoffset() != d1.utcoffset() and not _round_trips(wall, tz):
        # Erased by the spring-forward gap: fold=0 reads it with the
        # pre-transition offset, i.e. the occurrence fires shifted forward by
        # the gap width ("2:30" fires at 3:30) — §4.3, and the renderer's
        # cron.ts + the shared parity fixture implement the same rule.
        loc = d0.astimezone().replace(tzinfo=None)
        return loc if after is None or loc > after else None
    readings = sorted({d.timestamp(): d for d in (d0, d1)}.values(),
                      key=lambda d: d.timestamp())
    for d in readings:
        loc = d.astimezone().replace(tzinfo=None)
        if after is None or loc > after:
            return loc
    return None


def _to_local(wall: datetime, tz: ZoneInfo) -> datetime:
    """The zone's naive wall clock → local naive (first/earliest reading —
    use `_wall_to_local` when monotonicity against a baseline matters)."""
    return _wall_to_local(wall, tz, None) or wall.replace(tzinfo=tz).astimezone().replace(tzinfo=None)


def tz_error(tz) -> str | None:
    """Error message for an unusable `tz` value, None when valid (or absent)."""
    if tz is None:
        return None
    try:
        if not isinstance(tz, str):
            raise ValueError
        ZoneInfo(tz)
    except Exception:  # noqa: BLE001 — ZoneInfoNotFoundError, ValueError, ...
        return f"unknown timezone {tz!r} — use an IANA name like Asia/Tokyo"
    return None


def _tz_suffix(tz: str | None) -> str:
    """§4.3: labels append the zone's city — last IANA segment, _ → space."""
    return f" ({tz.rsplit('/', 1)[-1].replace('_', ' ')})" if tz else ""


# ---------- triggers (§4.3) ----------

def normalize_handle(frm: str) -> str:
    """§4.3 imessage `from` normalization: emails pass through; phones drop
    the obvious formatting (spaces, dashes, dots, parentheses) so
    "+1 (555) 123-4567" stores as the E.164 form Messages matches on."""
    frm = frm.strip()
    return frm if "@" in frm else re.sub(r"[\s().\-]", "", frm)


def normalize_authors(raw: list) -> list[str]:
    """§4.3 discord `author` normalization: trimmed, deduped, sorted — element
    order must never distinguish two triggers (the merge identity compares
    the normalized list)."""
    return sorted({str(a).strip() for a in raw})


def validate_trigger(t: dict, allow_past: bool = False) -> str | None:
    """§19 PATCH rule: error message, or None when the trigger is storable.
    `allow_past` skips the future check for one-shots — an EXISTING stored
    trigger whose moment elapsed must not 422 every unrelated edit of the
    list it rides in (the scheduler consumes it on its own, §4.3)."""
    kind = t.get("kind")
    if kind in RESERVED_KINDS:
        return f"{kind} triggers are coming soon"
    if kind == "app_start":
        return None
    if kind == "discord":
        # §4.3: channel = ASCII-digit snowflake; secret = Keychain secret name
        # holding the bot token (existence is a `conn` concern, not a 422).
        ch = t.get("channel")
        if not (isinstance(ch, str) and _ascii_digits(ch.strip())):
            return "the Discord channel must be its numeric channel id"
        sec = t.get("secret")
        if not (isinstance(sec, str) and SECRET_NAME_RE.match(sec.strip())):
            return "a Discord trigger needs the name of the secret holding the bot token"
        pat = t.get("pattern")
        if pat is not None and not (isinstance(pat, str) and pat.strip()):
            return "the Discord message pattern must be a nonempty text"
        if not isinstance(t.get("mention", False), bool):
            return "the Discord mention flag must be true or false"
        au = t.get("author")
        if au is not None and not (isinstance(au, list) and au and all(
                isinstance(a, str) and _ascii_digits(a.strip()) for a in au)):
            return "the Discord sender filter must be a list of numeric user ids"
        return None
    if kind == "imessage":
        # §4.3: from = sender handle — an email, or an E.164 phone matching
        # the form Messages stores. Formatting strips at save; a number
        # without the country code is refused outright, because it could
        # never match a stored handle (a trigger that silently never fires
        # is the worst failure mode).
        frm = t.get("from")
        if not (isinstance(frm, str) and frm.strip()):
            return ("an iMessage trigger needs the sender's handle — a phone "
                    "in +15551234567 form or an email")
        frm = frm.strip()
        if "@" in frm:
            if any(c.isspace() for c in frm):
                return "the sender email can't contain spaces"
        elif not re.fullmatch(r"\+[0-9]{3,15}", normalize_handle(frm)):
            return ("a phone sender needs the international form with the "
                    "country code, like +15551234567 — or use an email")
        pat = t.get("pattern")
        if pat is not None and not (isinstance(pat, str) and pat.strip()):
            return "the iMessage message pattern must be a nonempty text"
        return None
    if kind == "cron":
        if err := tz_error(t.get("timezone")):
            return err
        try:
            parse_cron(t.get("expression") or "")
        except CronError as e:
            return str(e)
        return None
    if kind == "time":
        if err := tz_error(t.get("timezone")):
            return err
        try:
            at = datetime.fromisoformat(t.get("at") or "")
        except (TypeError, ValueError):
            return "invalid timestamp — use local ISO format like 2026-07-20T15:00"
        if at.tzinfo is not None:
            # An offset-aware `at` would make the naive comparison below (and
            # trigger_next) raise TypeError — the zone belongs in `tz`.
            return "the timestamp must not carry a UTC offset — use tz for the zone"
        tz = zone_of(t)
        if not allow_past and (_to_local(at, tz) if tz else at) <= datetime.now():
            return "the time must be in the future"
        return None
    return f"unknown trigger kind {kind!r}"


def normalize_triggers(raw: list) -> tuple[list[dict], str | None]:
    """Validate a whole list; assign ids to new entries. → (stored shape, error)."""
    out: list[dict] = []
    for t in raw or []:
        if not isinstance(t, dict):
            return [], "each trigger must be an object"
        # An id marks a trigger that already exists on disk: it revalidates
        # leniently (allow_past) so an elapsed one-shot can't block edits or
        # version saves of the whole list. New triggers must be future.
        err = validate_trigger(t, allow_past=bool(t.get("id")))
        if err:
            return [], err
        n: dict = {"id": t.get("id") or str(uuid.uuid4()),
                   "kind": t["kind"], "enabled": bool(t.get("enabled", True))}
        if t["kind"] == "cron":
            n["expression"] = t["expression"].strip()
        elif t["kind"] == "time":
            n["at"] = t["at"]
        elif t["kind"] == "discord":
            n["channel"] = t["channel"].strip()
            n["secret"] = t["secret"].strip()
            if t.get("pattern"):
                n["pattern"] = t["pattern"].strip()
            if t.get("mention"):
                n["mention"] = True
            if t.get("author"):
                n["author"] = normalize_authors(t["author"])
        elif t["kind"] == "imessage":
            n["from"] = normalize_handle(t["from"])
            if t.get("pattern"):
                n["pattern"] = t["pattern"].strip()
        else:  # app_start — no fields, at most one per automation (§4.3)
            if any(x["kind"] == "app_start" for x in out):
                return [], "only one app-start trigger per automation"
        if t["kind"] != "app_start" and t.get("timezone"):
            n["timezone"] = t["timezone"]
        out.append(n)
    return out, None


def _hm(hour: int, minute: int) -> str:
    return f"{hour}:{minute:02d}"


def cron_display(expr: str, tz: str | None = None) -> tuple[str, str]:
    """§4.3 humanized labels — exactly two simple shapes get words."""
    sfx = _tz_suffix(tz)
    p = expr.split()
    if len(p) == 5 and p[0].isdigit() and p[1].isdigit() and p[2] == "*" and p[3] == "*":
        t = _hm(int(p[1]), int(p[0]))
        if p[4] == "*":
            return f"Daily at {t}{sfx}", f"Daily {t}{sfx}"
        if len(p[4]) == 1 and p[4] in "0123456":
            d = int(p[4])
            return f"{DOW_LONG[d]} at {t}{sfx}", f"{DOW_SHORT[d]} {t}{sfx}"
    return expr.strip() + sfx, expr.strip() + sfx


def time_display(at: str, tz: str | None = None) -> tuple[str, str]:
    dt = datetime.fromisoformat(at)
    sfx = _tz_suffix(tz)
    # §4.3: seconds show only when non-zero — matching the renderer's timeLabels.
    ss = f":{dt.second:02d}" if dt.second else ""
    ampm = f"{(dt.hour % 12) or 12}:{dt.minute:02d}{ss} {'AM' if dt.hour < 12 else 'PM'}"
    day = f"{dt.strftime('%b')} {dt.day}"
    return f"Once at {day}, {ampm}{sfx}", f"Once {day} {_hm(dt.hour, dt.minute)}{ss}{sfx}"


def trigger_display(t: dict) -> tuple[str, str]:
    if t["kind"] == "cron":
        return cron_display(t["expression"], t.get("timezone"))
    if t["kind"] == "app_start":
        return "On app start", "App start"
    if t["kind"] == "discord":
        label = f"Discord · {t['channel']}"
        if t.get("pattern"):
            label += f" · “{t['pattern']}”"
        return label, "Discord"
    if t["kind"] == "imessage":
        label = f"iMessage · {t['from']}"
        if t.get("pattern"):
            label += f" · “{t['pattern']}”"
        return label, "iMessage"
    return time_display(t["at"], t.get("timezone"))


def trigger_next(t: dict, after: datetime | None = None) -> datetime | None:
    """Next occurrence of one trigger strictly after `after`, both local naive.
    A `tz` trigger is evaluated on its zone's wall clock (off is the caller's concern)."""
    if t["kind"] in ("app_start", "discord", "imessage"):
        return None  # §4.3: no computable next occurrence
    tz = zone_of(t)
    base = after or datetime.now()
    if t["kind"] == "cron":
        if not tz:
            return cron_next(t["expression"], base)
        # The wall→local map is non-monotonic around DST transitions; keep
        # advancing until a reading lands strictly after `base` — the
        # scheduler's contract (occurrences at or before the baseline never
        # fire) depends on it.
        nxt = cron_next(t["expression"], _to_wall(base, tz))
        for _ in range(1000):
            if nxt is None:
                return None
            loc = _wall_to_local(nxt, tz, base)
            if loc is not None:
                return loc
            nxt = cron_next(t["expression"], nxt)
        return None
    at = datetime.fromisoformat(t["at"])
    if tz:
        at = _to_local(at, tz)
    return at if at > base else None


def time_elapsed(t: dict, now: datetime | None = None) -> bool:
    """§4.3: has a one-shot's moment passed? A spent trigger is consumed
    whether it fired or was missed — it never lingers."""
    if t.get("kind") != "time":
        return False
    try:
        at = datetime.fromisoformat(t["at"])
    except (KeyError, TypeError, ValueError):
        return True  # unreadable stored `at` — spent, drop it
    tz = zone_of(t)
    if tz:
        at = _to_local(at, tz)
    return at <= (now or datetime.now())


def next_at(triggers: list[dict], after: datetime | None = None) -> datetime | None:
    """§4.3 nextAt: minimum over enabled triggers, None when nothing is coming."""
    nxts = [n for t in triggers if t["enabled"] if (n := trigger_next(t, after))]
    return min(nxts) if nxts else None


def trigger_chip(triggers: list[dict]) -> str:
    if not triggers:
        return "No triggers"
    if len(triggers) == 1:
        return trigger_display(triggers[0])[1]
    return f"{len(triggers)} triggers"
