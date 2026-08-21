"""Trigger math and display strings (§4.1, §4.3): the cron dialect, one-shot
times, next occurrences, humanized labels, and trigger validation."""
from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

# §4.3 discord `secret` = a §4.8 secret id (uuid, lowercase hyphenated — the §4 id form).
SECRET_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

DOW_LONG = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

RESERVED_KINDS = ("pubsub",)  # §4.3 message triggers — coming soon

# §4.3 one-shot past check - normalize_triggers matches on this exact value to
# apply the spent-drop rule, so the two must share one constant.
PAST_ERROR = "the time must be in the future"

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


def parse_cron(expression: str) -> list[tuple[set[int], bool]]:
    """Validate + expand a §4.3 cron expression; raises CronError."""
    if expression is not None and not isinstance(expression, str):
        # A non-string expression (YAML int in an import archive, a raw API
        # payload) must answer the ordinary 422, not crash with AttributeError.
        raise CronError("the cron expression must be a string")
    fields = (expression or "").split()
    if len(fields) != 5:
        raise CronError("a cron expression needs 5 fields (minute hour day month weekday)")
    return [_parse_field(f, n, lo, hi)
            for f, n, (lo, hi) in zip(fields, _FIELD_NAMES, _FIELD_RANGES)]


def cron_next(expression: str, after: datetime | None = None) -> datetime | None:
    """Next match strictly after `after` (local wall clock), None if unsatisfiable."""
    (mins, _), (hours, _), (doms, dom_star), (months, _), (dows, dow_star) = parse_cron(expression)
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


# ---------- timezone (§4.3 `timezone`): wall clock in the trigger's zone ----------

def zone_of(t: dict) -> ZoneInfo | None:
    """The trigger's zone, None when local. Assumes a validated `timezone`."""
    return ZoneInfo(t["timezone"]) if t.get("timezone") else None


def _to_wall(local: datetime, zone: ZoneInfo) -> datetime:
    """Local naive → the zone's naive wall clock."""
    return local.astimezone(zone).replace(tzinfo=None)


def _round_trips(wall: datetime, zone: ZoneInfo) -> bool:
    """True when `wall` is a real wall time in `zone` (not erased by a
    spring-forward gap)."""
    return wall.replace(tzinfo=zone, fold=0).astimezone(UTC) \
               .astimezone(zone).replace(tzinfo=None) == wall


def _wall_to_local(wall: datetime, zone: ZoneInfo, after: datetime | None) -> datetime | None:
    """The zone's naive wall clock → local naive, DST-transition-aware.

    The naive `wall.replace(tzinfo=zone)` conversion is non-monotonic around the
    zone's transitions (an ambiguous fall-back time reads as the *earlier*
    instant, which can land before `after` and make the scheduler re-fire one
    occurrence every tick). Rules here: an ambiguous wall time picks the
    earliest reading strictly after `after` (§4.3: one repeated by fall-back
    fires once); a nonexistent wall time fires at the next valid minute
    (§4.3); returns None when every reading is ≤ `after`."""
    d0, d1 = wall.replace(tzinfo=zone, fold=0), wall.replace(tzinfo=zone, fold=1)
    if d0.utcoffset() != d1.utcoffset() and not _round_trips(wall, zone):
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


def _local_gap_fix(d: datetime, after: datetime | None) -> datetime | None:
    """§4.3 gap rule for the system zone (no `timezone` on the trigger): a
    wall time erased by spring-forward fires shifted forward by the gap width,
    same as `_wall_to_local` does for a zoned trigger. An ordinary or
    ambiguous reading returns unchanged - the scheduler's naive baseline math
    already fires a fall-back hour once. Returns None only when the shifted
    reading lands at or before `after`."""
    d0, d1 = d.replace(fold=0), d.replace(fold=1)
    if d0.astimezone().utcoffset() == d1.astimezone().utcoffset():
        return d
    # Transition zone: a round trip through UTC tells erased from ambiguous -
    # an ambiguous wall time survives it, an erased one comes back shifted.
    rt = d0.astimezone(UTC).astimezone().replace(tzinfo=None)
    if rt == d:
        return d
    return rt if after is None or rt > after else None


def _to_local(wall: datetime, zone: ZoneInfo) -> datetime:
    """The zone's naive wall clock → local naive (first/earliest reading —
    use `_wall_to_local` when monotonicity against a baseline matters)."""
    return _wall_to_local(wall, zone, None) or wall.replace(tzinfo=zone).astimezone().replace(tzinfo=None)


def timezone_error(timezone) -> str | None:
    """Error message for an unusable timezone value, None when valid (or absent)."""
    if timezone is None:
        return None
    try:
        if not isinstance(timezone, str):
            raise ValueError
        ZoneInfo(timezone)
    except Exception:  # noqa: BLE001 — ZoneInfoNotFoundError, ValueError, ...
        return f"unknown timezone {timezone!r} — use an IANA name like Asia/Tokyo"
    return None


def _timezone_suffix(timezone: str | None) -> str:
    """§4.3: labels append the zone's city — last IANA segment, _ → space."""
    return f" ({timezone.rsplit('/', 1)[-1].replace('_', ' ')})" if timezone else ""


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
        # §4.3: channel = ASCII-digit snowflake; secret = the §4.8 id of the
        # secret holding the bot token (existence is a `connection` concern,
        # not a 422 — a mid-edit secret deletion must never block a save).
        ch = t.get("channel")
        if not (isinstance(ch, str) and _ascii_digits(ch.strip())):
            return "the Discord channel must be its numeric channel id"
        sec = t.get("secret")
        if not (isinstance(sec, str) and SECRET_ID_RE.match(sec.strip())):
            return "a Discord trigger needs the id of the secret holding the bot token"
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
        # §4.3 provenance: required — every ingest path stamps it.
        if t.get("source") not in ("spec", "user"):
            return 'a cron trigger\'s source must be "spec" or "user"'
        if err := timezone_error(t.get("timezone")):
            return err
        try:
            parse_cron(t.get("expression") or "")
        except CronError as e:
            return str(e)
        return None
    if kind == "time":
        if err := timezone_error(t.get("timezone")):
            return err
        try:
            at = datetime.fromisoformat(t.get("at") or "")
        except (TypeError, ValueError):
            return "invalid timestamp — use local ISO format like 2026-07-20T15:00"
        if at.tzinfo is not None:
            # An offset-aware `at` would make the naive comparison below (and
            # trigger_next) raise TypeError — the zone belongs in `timezone`.
            return "the timestamp must not carry a UTC offset — use timezone for the zone"
        zone = zone_of(t)
        if not allow_past and (_to_local(at, zone) if zone else at) <= datetime.now():
            return PAST_ERROR
        return None
    return f"unknown trigger kind {kind!r}"


def normalize_triggers(raw: list,
                       existing_ids: set[str] | None = None) -> tuple[list[dict], str | None]:
    """Validate a whole list; assign ids to new entries. → (stored shape, error).

    `existing_ids` is the set of trigger ids already stored on the automation:
    only those revalidate leniently (allow_past), so an elapsed one-shot can't
    block edits or version saves of the whole list. An id-carrying past `time`
    entry the automation does *not* store is the §4.3 spent case (a staged
    one-shot that elapsed before the save, or one the scheduler consumed
    mid-edit): dropped silently, never stored, never a 422 - so a fabricated
    id still can't smuggle a past time into storage. None (the §19 preview,
    which has no automation context) trusts any id — display-only, nothing is
    stored there."""
    out: list[dict] = []
    for t in raw or []:
        if not isinstance(t, dict):
            return [], "each trigger must be an object"
        known = bool(t.get("id")) and (existing_ids is None or t["id"] in existing_ids)
        err = validate_trigger(t, allow_past=known)
        if err == PAST_ERROR and t.get("id") and existing_ids is not None:
            continue  # §4.3 spent-drop: staged one-shot elapsed before the save
        if err:
            return [], err
        n: dict = {"id": t.get("id") or str(uuid.uuid4()),
                   "kind": t["kind"], "enabled": bool(t.get("enabled", True))}
        if t["kind"] == "cron":
            n["expression"] = t["expression"].strip()
            n["source"] = t["source"]  # §4.3: required, stored as sent
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
        # §4.3: `timezone` belongs to cron/time only — the loader drops it for
        # any other kind, so keeping it here would survive only until restart.
        if t["kind"] in ("cron", "time") and t.get("timezone"):
            n["timezone"] = t["timezone"]
        out.append(n)
    return out, None


def _hm(hour: int, minute: int) -> str:
    return f"{hour}:{minute:02d}"


def cron_display(expression: str, timezone: str | None = None) -> tuple[str, str]:
    """§4.3 humanized labels — exactly two simple shapes get words."""
    sfx = _timezone_suffix(timezone)
    p = expression.split()
    if len(p) == 5 and p[0].isdigit() and p[1].isdigit() and p[2] == "*" and p[3] == "*":
        t = _hm(int(p[1]), int(p[0]))
        if p[4] == "*":
            return f"Daily at {t}{sfx}", f"Daily {t}{sfx}"
        if len(p[4]) == 1 and p[4] in "0123456":
            d = int(p[4])
            return f"{DOW_LONG[d]} at {t}{sfx}", f"{DOW_SHORT[d]} {t}{sfx}"
    return expression.strip() + sfx, expression.strip() + sfx


def time_display(at: str, timezone: str | None = None) -> tuple[str, str]:
    dt = datetime.fromisoformat(at)
    sfx = _timezone_suffix(timezone)
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
        # §11: a missing detail field renders "missing" — never a dangling
        # "Discord · " label on a broken trigger.
        label = f"Discord · {t.get('channel') or 'missing'}"
        if t.get("pattern"):
            label += f" · “{t['pattern']}”"
        return label, "Discord"
    if t["kind"] == "imessage":
        label = f"iMessage · {t.get('from') or 'missing'}"
        if t.get("pattern"):
            label += f" · “{t['pattern']}”"
        return label, "iMessage"
    return time_display(t["at"], t.get("timezone"))


def trigger_next(t: dict, after: datetime | None = None) -> datetime | None:
    """Next occurrence of one trigger strictly after `after`, both local naive.
    A `timezone` trigger is evaluated on its zone's wall clock (the enabled flag is the caller's concern)."""
    if t["kind"] in ("app_start", "discord", "imessage"):
        return None  # §4.3: no computable next occurrence
    zone = zone_of(t)
    base = after or datetime.now()
    if t["kind"] == "cron":
        if not zone:
            # Same non-monotonicity as the zoned path, on the system zone: a
            # candidate erased by spring-forward shifts forward by the gap
            # width and must still land strictly after `base`.
            nxt = cron_next(t["expression"], base)
            for _ in range(1000):
                if nxt is None:
                    return None
                loc = _local_gap_fix(nxt, base)
                if loc is not None:
                    return loc
                nxt = cron_next(t["expression"], nxt)
            return None
        # The wall→local map is non-monotonic around DST transitions; keep
        # advancing until a reading lands strictly after `base` — the
        # scheduler's contract (occurrences at or before the baseline never
        # fire) depends on it.
        nxt = cron_next(t["expression"], _to_wall(base, zone))
        for _ in range(1000):
            if nxt is None:
                return None
            loc = _wall_to_local(nxt, zone, base)
            if loc is not None:
                return loc
            nxt = cron_next(t["expression"], nxt)
        return None
    at = datetime.fromisoformat(t["at"])
    if zone:
        at = _to_local(at, zone)
    else:
        at = _local_gap_fix(at, None) or at
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
    zone = zone_of(t)
    if zone:
        at = _to_local(at, zone)
    return at <= (now or datetime.now())


def next_at(triggers: list[dict], after: datetime | None = None) -> datetime | None:
    """§4.3 nextAt: minimum over enabled triggers, None when nothing is coming."""
    nxts = [n for t in triggers if t["enabled"] if (n := trigger_next(t, after))]
    return min(nxts) if nxts else None


def is_overdue(triggers: list[dict], baseline: datetime, now: datetime | None = None) -> bool:
    """§4.1 overdue: some enabled cron trigger has had two consecutive
    occurrences pass since `baseline` (local naive, like every trigger_next
    time) with no run — two, not one, so a single legitimately skipped
    moment (§6 busy-skip, a restart at the wrong minute) never flags. Cron
    only: one-shots are consumed by the §4.3 spent rule, and
    app-start/message triggers have no schedule."""
    now = now or datetime.now()
    for t in triggers:
        if t.get("kind") != "cron" or not t.get("enabled"):
            continue
        first = trigger_next(t, after=baseline)
        second = trigger_next(t, after=first) if first else None
        if second is not None and second < now:
            return True
    return False


def trigger_chip(triggers: list[dict]) -> str:
    if not triggers:
        return "No triggers"
    if len(triggers) == 1:
        return trigger_display(triggers[0])[1]
    return f"{len(triggers)} triggers"
