"""§6 scheduler policy: tick/firing rules (no automatic execution-level retry —
§7 step retry is the engine's job) and the firing queue — admission, depth cap,
drain, staleness, and cancel."""
from conftest import make_version


def _mk(store):
    from autowright.engine import Engine
    from autowright.scheduler import Scheduler

    engine = Engine(store)
    sched = Scheduler(store, engine)  # loop not started — we drive ticks directly
    return engine, sched


def test_failed_scheduled_run_stays_failed(store):
    """§6: a failed trigger-fired execution is never retried automatically —
    a later tick leaves the record exactly as it failed."""
    import time
    from datetime import datetime, timedelta

    engine, sched = _mk(store)
    ver = make_version()
    ver["steps"][0]["code"] = 'raise RuntimeError("boom")\n'
    a = store.create_automation(ver, "Sched Fail", None)
    h = engine.start(a, "cron")
    t0 = time.time()
    while engine.is_live(h["id"]):
        assert time.time() - t0 < 30
        time.sleep(0.1)
    assert h["status"] == "failed"
    attempts = len(h["steps"][0]["attempts"])
    sched._clock = lambda now=datetime.now() + timedelta(minutes=6): now
    sched._tick()
    time.sleep(0.2)
    assert h["status"] == "failed"  # still failed — nothing re-ran it
    assert len(h["steps"][0]["attempts"]) == attempts
    assert not engine.is_live(h["id"])


# ---------- §6 tick behavior, driven directly with an injected fake clock ----------

class _Clock:
    """Mutable fake clock for Scheduler(clock=...) — call returns .now."""

    def __init__(self, now):
        self.now = now

    def __call__(self):
        return self.now


def _mk_clocked(store, clock):
    from autowright.engine import Engine
    from autowright.scheduler import Scheduler

    engine = Engine(store)
    sched = Scheduler(store, engine, clock=clock)  # loop never started
    return engine, sched


def _record_fires(monkeypatch):
    """Replace the module-level fire_trigger with a recorder."""
    from autowright import scheduler as sched_mod

    fires = []
    monkeypatch.setattr(sched_mod, "fire_trigger",
                        lambda store, engine, a, t: fires.append((a["id"], t["id"])) or True)
    return fires


def test_same_moment_triggers_coalesce_into_one_fire(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 7, 59))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    trigs = [{"id": "t1", "kind": "cron", "enabled": True, "expression": "0 8 * * *"},
             {"id": "t2", "kind": "cron", "enabled": True, "expression": "0 8 * * *"}]
    store.create_automation(make_version(), "Coalesce", None, triggers=trigs)
    sched._tick()  # establishes baselines at 7:59
    assert fires == []
    clock.now = datetime(2026, 7, 10, 8, 1)
    sched._tick()
    assert len(fires) == 1  # both due at 8:00 → one execution
    sched._tick()
    assert len(fires) == 1  # both baselines advanced — nothing re-fires


def test_at_most_one_catch_up_per_wake(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 10, 30))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "Catchup", None, triggers=[
        {"id": "t1", "kind": "cron", "enabled": True, "expression": "0 * * * *"}])
    sched._tick()  # baseline 10:30
    clock.now = datetime(2026, 7, 10, 13, 31)  # slept through 11:00, 12:00, 13:00
    sched._tick()
    assert len(fires) == 1  # single catch-up, older occurrences swallowed
    assert sched._baseline[(a["id"], "t1")] == clock.now  # baseline advanced to now
    sched._tick()
    assert len(fires) == 1
    clock.now = datetime(2026, 7, 10, 14, 1)
    sched._tick()
    assert len(fires) == 2  # normal next occurrence still fires


def test_occurrence_missed_while_off_never_fires(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 7, 59))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "OffMiss", None, triggers=[
        {"id": "t1", "kind": "cron", "enabled": False, "expression": "0 8 * * *"}])
    sched._tick()
    clock.now = datetime(2026, 7, 10, 8, 5)  # 8:00 passes while off
    sched._tick()
    assert fires == []
    a["triggers"][0]["enabled"] = True  # re-enable after the occurrence
    clock.now = datetime(2026, 7, 10, 8, 6)
    sched._tick()
    assert fires == []  # the missed 8:00 never fires
    clock.now = datetime(2026, 7, 11, 8, 1)  # NEXT occurrence
    sched._tick()
    assert len(fires) == 1


def test_one_shot_time_trigger_consumed_after_fire(store, monkeypatch):
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 7, 59))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "OneShot", None, triggers=[
        {"id": "tt", "kind": "time", "enabled": True, "at": "2026-07-10T08:00"}])
    sched._tick()
    clock.now = datetime(2026, 7, 10, 8, 1)
    sched._tick()
    assert len(fires) == 1
    assert a["triggers"] == []  # consumed — removed from the automation
    clock.now = datetime(2026, 7, 10, 8, 2)
    sched._tick()
    assert len(fires) == 1


def test_fire_trigger_mid_execution_writes_skipped_record(store):
    from autowright.firing import fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Busy", None)
    a["_live"] = {"some-live-exec"}
    t = {"id": "t1", "kind": "cron", "enabled": True, "expression": "0 8 * * *"}
    assert fire_trigger(store, engine, a, t) is False
    recs = [h for h in store.execs.values() if h["automation_id"] == a["id"]]
    assert len(recs) == 1
    h = recs[0]
    assert h["status"] == "skipped"
    assert h["note"] == "previous execution still in progress"
    assert h["trigger"] == "cron"  # stored kind; the label is derived (§4.5)
    assert h["duration_ms"] == 0 and h["finished_at"] == h["started_at"]


def _discord_trig():
    return {"id": "t1", "kind": "discord", "enabled": True, "secret": "TOKEN",
            "channel": "42"}


def _payload(sender="Dave", text="hi"):
    return {"kind": "discord", "channel": "42", "secret": "TOKEN",
            "sender": sender, "text": text}


def test_fire_trigger_answers_a_refused_message_firing(store, monkeypatch):
    """§6: a message firing refused for lack of queue room replies to its sender;
    a cron firing with no free slot is skipped silently — nobody to answer."""
    from autowright import listeners as li_mod
    from autowright.firing import fire_trigger
    from conftest import make_version

    notified = []
    monkeypatch.setattr(li_mod, "notify_busy", notified.append)

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Busy", None)
    a["_live"] = {"some-live-exec"}
    a["max_queued"] = 0  # queue disabled → straight to skip-on-busy
    payload = _payload()

    assert fire_trigger(store, engine, a, _discord_trig(), payload=payload) is False
    assert notified == [payload]

    # §7: nothing was queued, so nothing was full — skip-on-busy keeps the plain
    # note whether or not the firing could have queued.
    assert [h["note"] for h in store.execs.values()] == ["previous execution still in progress"]

    cron = {"id": "t2", "kind": "cron", "enabled": True, "expression": "0 8 * * *"}
    assert fire_trigger(store, engine, a, cron) is False
    assert notified == [payload]  # unchanged — no sender to answer
    assert {h["note"] for h in store.execs.values()} == {"previous execution still in progress"}


def test_message_firing_queues_instead_of_being_dropped(store):
    """§6: with room in the queue the firing waits as a `queued` record — not a
    skip, and not something that shadows the automation's real latest status."""
    from autowright.firing import fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"some-live-exec"}

    assert fire_trigger(store, engine, a, _discord_trig(), payload=_payload()) is False
    q = store.queued_execs(a["id"])
    assert len(q) == 1
    assert q[0]["status"] == "queued" and q[0]["queued_at"]
    assert q[0]["trigger_payload"]["sender"] == "Dave"
    # a queued record never counts as the automation's latest (§4.1)
    assert store._latest_exec(a["id"]) is None
    assert a["_last_status"] == "none"


def test_admission_publishes_exec_queued(store, monkeypatch):
    """§6/§19: admission publishes `exec.queued` carrying the new record — the
    §7 Waiting section and the §9.2 "N waiting" line update off it, and without
    it a waiting firing stays invisible until something else forces a refetch."""
    from autowright import scheduler as sch
    from autowright.firing import fire_trigger
    from conftest import make_version

    events = []
    monkeypatch.setattr(sch.hub, "publish", lambda ev, **kw: events.append((ev, kw)))

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"some-live-exec"}

    assert fire_trigger(store, engine, a, _discord_trig(), payload=_payload()) is False
    assert [ev for ev, _ in events] == ["execution.queued"]
    kw = events[0][1]
    assert kw["executionId"] == store.queued_execs(a["id"])[0]["id"]
    assert kw["execution"]["status"] == "queued"
    assert kw["execution"]["queuedMs"] > 0


def test_queue_admits_every_firing_and_caps_at_max_queued(store, monkeypatch):
    """§6: every admitted firing is its own entry — same-sender messages never
    coalesce; past the cap the newest firing is refused, not admitted."""
    from autowright import listeners as li_mod
    from autowright.firing import fire_trigger
    from conftest import make_version

    notified = []
    monkeypatch.setattr(li_mod, "notify_busy", notified.append)

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["_live"] = {"some-live-exec"}
    a["max_queued"] = 2

    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave", "one"))
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave", "two"))
    q = store.queued_execs(a["id"])
    assert len(q) == 2  # one entry per firing, even from the same sender
    assert len({e["id"] for e in q}) == 2
    assert [e["trigger_payload"]["text"] for e in q] == ["one", "two"]  # FIFO
    assert notified == []

    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Ana"))
    q = store.queued_execs(a["id"])
    assert len(q) == 2  # the newest is refused — admitted entries are never evicted
    assert {e["trigger_payload"]["text"] for e in q} == {"one", "two"}
    assert [p["sender"] for p in notified] == ["Ana"]
    # §7: a full queue names the cap — the row must say which knob to turn, not
    # read the same as configured skip-on-busy.
    ana = next(h for h in store.execs.values()
               if h.get("trigger_sender") == "Ana")
    assert ana["status"] == "skipped"
    assert ana["note"] == "the queue was full (2 waiting)"


def test_queue_drains_into_a_freed_slot_and_promotes_in_place(store):
    """§6: a freed slot goes to the longest-waiting firing, and promotion reuses
    the record — one firing produces exactly one execution from admission to
    finish, carrying its payload and its queued_at."""
    import time

    from autowright.firing import drain_queue, fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}

    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave"))
    q = store.queued_execs(a["id"])
    assert len(q) == 1
    entry_id, queued_at = q[0]["id"], q[0]["queued_at"]

    a["_live"] = set()  # the blocking execution finished
    drain_queue(store, engine, a["id"])

    t0 = time.time()
    while engine.is_live(entry_id):
        assert time.time() - t0 < 30
        time.sleep(0.05)

    h = store.exec_full(entry_id)  # finished records are demoted to headers in memory
    assert store.queued_execs(a["id"]) == []  # left the queue
    assert h["status"] == "succeeded"  # same record, now executed
    assert h["steps"] and h["trigger"] == "discord"
    assert h["trigger_sender"] == "Dave"  # sender survived promotion
    assert h["queued_at"] == queued_at  # the wait is still on the record
    assert h["started_at"] >= queued_at  # …but the duration measures execution


def test_stale_queue_entry_is_answered_not_executed(store, monkeypatch):
    """§6: an entry that reaches the head past the TTL is finished, not run —
    answering a stale question is noise. It ends `skipped`, so it can never
    become the automation's latest (§4.1)."""
    from autowright import firing as firing_mod
    from autowright import listeners as li_mod
    from autowright.firing import drain_queue, fire_trigger
    from conftest import make_version

    notified = []
    monkeypatch.setattr(li_mod, "notify_busy", notified.append)
    monkeypatch.setattr(firing_mod, "QUEUE_TTL_S", -1.0)  # everything is stale

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave"))
    entry_id = store.queued_execs(a["id"])[0]["id"]

    a["_live"] = set()
    drain_queue(store, engine, a["id"])

    h = store.execs[entry_id]
    assert h["status"] == "skipped" and h["note"] == "waited too long in the queue"
    assert not engine.is_live(entry_id)  # never executed
    assert store._latest_exec(a["id"]) is None  # never shadows the real latest
    assert [p["sender"] for p in notified] == ["Dave"]


def test_cancelling_a_queued_entry_answers_its_sender(store, monkeypatch):
    """§6/§19: the ordinary cancel endpoint covers a waiting entry. It ends
    `skipped` — it never ran, and §4.6 reserves that status for exactly this."""
    from autowright import listeners as li_mod
    from autowright.firing import fire_trigger
    from conftest import make_version

    notified = []
    monkeypatch.setattr(li_mod, "notify_busy", notified.append)

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave"))
    entry_id = store.queued_execs(a["id"])[0]["id"]

    assert engine.cancel(entry_id) is True
    h = store.execs[entry_id]
    assert h["status"] == "skipped" and h["note"] == "cancelled before it ran"
    assert store.queued_execs(a["id"]) == []
    assert [p["sender"] for p in notified] == ["Dave"]
    assert store._latest_exec(a["id"]) is None


def test_max_parallel_admits_several_and_then_queues(store):
    """§6: maxParallel slots run concurrently; the firing that finds them all
    taken waits rather than being dropped."""
    import time

    from autowright.firing import fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    ver = make_version()
    ver["steps"][0]["code"] = "import time\ntime.sleep(1.5)\n"
    a = store.create_automation(ver, "Parallel", None)
    a["max_parallel"] = 2
    a["max_queued"] = 10  # §4.1: queueing is opt-in — default 0 would skip Kim

    assert fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave")) is True
    assert fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Ana")) is True
    assert len(a["_live"]) == 2  # both running at once
    # the third finds no slot and waits
    assert fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Kim")) is False
    assert len(store.queued_execs(a["id"])) == 1

    t0 = time.time()
    while store.queued_execs(a["id"]) or a["_live"]:
        assert time.time() - t0 < 60
        time.sleep(0.1)
    # the queued firing was drained into the slot the first finisher freed
    kim = [h for h in store.execs.values()
           if h.get("trigger_sender") == "Kim"]
    assert len(kim) == 1 and kim[0]["status"] == "succeeded"


def test_trigger_off_cancels_its_waiting_entries(store, monkeypatch):
    """§6: turning the trigger off (or removing it) cancels every waiting entry
    it admitted — the entry could never be re-admitted, and promoting it would
    execute a firing the user just switched off. Sender is told."""
    from autowright import listeners as li_mod
    from autowright.firing import cancel_unmatched_queue, fire_trigger
    from conftest import make_version

    notified = []
    monkeypatch.setattr(li_mod, "notify_busy", notified.append)

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["triggers"] = [_discord_trig()]
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave"))
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Ana"))
    assert len(store.queued_execs(a["id"])) == 2

    # trigger still enabled: nothing is cancelled
    cancel_unmatched_queue(store, engine, a["id"])
    assert len(store.queued_execs(a["id"])) == 2

    a["triggers"][0]["enabled"] = False
    cancel_unmatched_queue(store, engine, a["id"])
    assert store.queued_execs(a["id"]) == []
    notes = [h["note"] for h in store.execs.values() if h["status"] == "skipped"]
    assert notes == ["cancelled before it ran"] * 2
    assert {p["sender"] for p in notified} == {"Dave", "Ana"}
    assert store._latest_exec(a["id"]) is None  # cancelled entries never shadow


def test_trigger_off_keeps_entries_of_other_enabled_triggers(store):
    """§6: with two discord triggers, turning one off cancels only the entries
    whose payload matches it — the other trigger's waiter keeps its place."""
    from autowright.firing import cancel_unmatched_queue, fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    other = {"id": "t2", "kind": "discord", "enabled": True, "secret": "TOKEN",
             "channel": "99"}
    a["triggers"] = [_discord_trig(), other]
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave"))
    p2 = {**_payload("Ana"), "channel": "99"}
    fire_trigger(store, engine, a, other, payload=p2)
    assert len(store.queued_execs(a["id"])) == 2

    a["triggers"][0]["enabled"] = False
    cancel_unmatched_queue(store, engine, a["id"])
    q = store.queued_execs(a["id"])
    assert len(q) == 1
    assert q[0]["trigger_payload"]["sender"] == "Ana"


def test_each_admission_publishes_its_own_exec_queued(store, monkeypatch):
    """§6: every admitted firing publishes exec.queued for its own record —
    same-sender messages are distinct entries, so the Waiting list shows both."""
    from autowright import scheduler as sch
    from autowright.firing import fire_trigger
    from conftest import make_version

    events = []
    monkeypatch.setattr(sch.hub, "publish", lambda ev, **kw: events.append((ev, kw)))

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave", "one"))
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave", "two"))

    queued_events = [kw for ev, kw in events if ev == "execution.queued"]
    assert len(queued_events) == 2  # one admission event per firing
    assert queued_events[0]["executionId"] != queued_events[1]["executionId"]  # distinct records
    assert len(store.queued_execs(a["id"])) == 2


def test_dst_fall_back_hour_fires_once(store, monkeypatch):
    """§4.3: an hour repeated by a DST fall-back fires once. The local wall
    clock rewinds an hour with no clock step at all, so the backward-step guard
    must not mistake it for one and re-evaluate the whole repeated hour."""
    from datetime import datetime, timedelta, timezone
    from conftest import make_version

    # 2026-11-01 America/New_York: 01:00-01:59 EDT runs, then repeats as EST.
    local = _Clock(datetime(2026, 11, 1, 0, 55))
    utc = _Clock(datetime(2026, 11, 1, 4, 55, tzinfo=timezone.utc))

    from autowright.engine import Engine
    from autowright.scheduler import Scheduler

    sched = Scheduler(store, Engine(store), clock=local, utc_clock=utc)
    fires = _record_fires(monkeypatch)
    store.create_automation(make_version(), "Nightly", None, triggers=[
        {"id": "t1", "kind": "cron", "enabled": True, "expression": "30 1 * * *"}])

    # walk local time through the repeated hour; UTC only ever moves forward
    for local_now in [datetime(2026, 11, 1, 0, 55),   # baseline, EDT
                      datetime(2026, 11, 1, 1, 35),   # 01:30 EDT — the firing
                      datetime(2026, 11, 1, 1, 5),    # clock fell back to EST
                      datetime(2026, 11, 1, 1, 35),   # 01:30 again, now EST
                      datetime(2026, 11, 1, 2, 5)]:
        local.now = local_now
        sched._tick()
        utc.now += timedelta(minutes=30)

    assert len(fires) == 1, f"the repeated hour must fire once, fired {len(fires)}"


def test_backward_clock_step_still_recovers(store, monkeypatch):
    """§6: a genuine backward step (NTP) must not silence a trigger until the
    wall clock re-reaches the old baseline — UTC moves back too, unlike DST."""
    from datetime import datetime, timedelta, timezone
    from conftest import make_version

    local = _Clock(datetime(2026, 7, 10, 9, 55))
    utc = _Clock(datetime(2026, 7, 10, 13, 55, tzinfo=timezone.utc))

    from autowright.engine import Engine
    from autowright.scheduler import Scheduler

    sched = Scheduler(store, Engine(store), clock=local, utc_clock=utc)
    fires = _record_fires(monkeypatch)
    store.create_automation(make_version(), "Hourly", None, triggers=[
        {"id": "t1", "kind": "cron", "enabled": True, "expression": "0 * * * *"}])

    sched._tick()  # baseline at 09:55
    # NTP yanks the clock back an hour — both readings move back together
    local.now = datetime(2026, 7, 10, 8, 55)
    utc.now -= timedelta(hours=1)
    sched._tick()
    assert fires == []
    # the next real occurrence still fires rather than being swallowed
    local.now = datetime(2026, 7, 10, 9, 5)
    utc.now += timedelta(minutes=10)
    sched._tick()
    assert len(fires) == 1


def test_deleted_version_queue_entry_finishes_with_note(store, monkeypatch):
    """§6 drain LookupError path: a queued entry whose admitted version was
    deleted (§7 restore/rollback) can never execute — it finishes `skipped`
    with the version-gone note instead of blocking the queue forever."""
    from autowright import listeners as li_mod
    from autowright.firing import drain_queue, fire_trigger
    from conftest import make_version

    notified = []
    monkeypatch.setattr(li_mod, "notify_busy", notified.append)

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Chat", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave"))
    entry = store.queued_execs(a["id"])[0]
    entry["version"] = 99  # the version this firing was admitted against is gone

    a["_live"] = set()
    drain_queue(store, engine, a["id"])

    h = store.execs[entry["id"]]
    assert h["status"] == "skipped"
    assert h["note"] == "version v99 no longer exists"
    assert not engine.is_live(entry["id"])  # never executed
    assert store.queued_execs(a["id"]) == []  # the queue isn't blocked behind it
    assert [p["sender"] for p in notified] == ["Dave"]  # sender still answered


# ---------- the real tick loop thread (§6) ----------

def test_loop_thread_survives_a_failing_tick(store, monkeypatch, caplog):
    """§6: one bad tick is logged and never kills the scheduler thread —
    a persistent failure here would silently turn every trigger off."""
    import logging
    import threading
    import time
    from datetime import datetime

    from autowright import scheduler as sched_mod
    from autowright.engine import Engine
    from autowright.scheduler import Scheduler

    monkeypatch.setattr(sched_mod, "TICK_S", 0.01)
    calls = {"n": 0}

    def clock():
        calls["n"] += 1
        if calls["n"] == 2:  # the ctor takes call 1; the first tick raises
            raise RuntimeError("bad tick")
        return datetime.now()

    engine = Engine(store)
    sched = Scheduler(store, engine, clock=clock)
    with caplog.at_level(logging.ERROR, logger="autowright.scheduler"):
        sched.start()
        t0 = time.time()
        while calls["n"] < 4:  # ticks keep coming after the failing one
            assert time.time() - t0 < 30
            time.sleep(0.01)
        sched.stop()
    for t in threading.enumerate():
        if t.name == "ad-scheduler":
            t.join(timeout=10)
            assert not t.is_alive()
    assert any("scheduler tick failed" in r.message for r in caplog.records)


def test_disabled_one_shot_elapsed_is_consumed_unfired(store, monkeypatch):
    """§4.3: a one-shot whose moment passes while the trigger is off is
    consumed without firing — a spent one-shot never lingers."""
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 8, 5))
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "OffShot", None, triggers=[
        {"id": "tt", "kind": "time", "enabled": False, "at": "2026-07-10T08:00"}])
    sched._tick()
    assert fires == []
    assert a["triggers"] == []  # consumed even though it was off


def test_one_shot_missed_before_baseline_consumed_unfired(store, monkeypatch):
    """§4.3: a one-shot whose moment passed while the backend was down (before
    the startup baseline) is consumed, never fired — no catch-up queue."""
    from datetime import datetime
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 9, 0))  # backend wakes past the moment
    engine, sched = _mk_clocked(store, clock)
    fires = _record_fires(monkeypatch)
    a = store.create_automation(make_version(), "MissedShot", None, triggers=[
        {"id": "tt", "kind": "time", "enabled": True, "at": "2026-07-10T08:00"}])
    sched._tick()
    assert fires == []
    assert a["triggers"] == []


def test_retention_sweep_runs_hourly_and_publishes(store, monkeypatch):
    """§5: the hourly retention pass deletes expired records and publishes
    automation.changed only when something was actually removed."""
    from datetime import datetime, timedelta
    from autowright import scheduler as sched_mod
    from conftest import make_version

    clock = _Clock(datetime(2026, 7, 10, 9, 0))
    engine, sched = _mk_clocked(store, clock)
    a = store.create_automation(make_version(), "Sweep", None)
    h_old = store.create_execution(a, "version", 1, "manual", [], status="succeeded")
    h_old["started_at"] = (datetime(2026, 7, 10) - timedelta(days=120)).isoformat(timespec="seconds")
    store.update_execution(h_old)
    store.settings["days"] = 90
    events = []
    monkeypatch.setattr(sched_mod.hub, "publish",
                        lambda ev, **kw: events.append(ev))
    sched._tick()
    assert h_old["id"] in store.execs  # not an hour yet — nothing swept
    clock.now += timedelta(hours=2)
    sched._tick()
    assert h_old["id"] not in store.execs
    assert "automation.changed" in events
    events.clear()
    clock.now += timedelta(hours=2)
    sched._tick()  # nothing left to remove → no publish
    assert "automation.changed" not in events


def test_fire_trigger_version_gone_reports_not_started(store):
    """§6: a firing whose current version no longer resolves starts nothing
    and returns False — the tick must survive it, not crash the loop."""
    from autowright.firing import fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "GoneVersion", None)
    a["versions"].clear()  # the version the firing would resolve is gone
    before = len(store.execs)
    t = {"id": "t1", "kind": "cron", "enabled": True, "expression": "0 8 * * *"}
    assert fire_trigger(store, engine, a, t) is False
    assert len(store.execs) == before  # nothing started, nothing recorded
    assert a["_live"] == set()


def test_trigger_off_cancels_unmatched_imessage_entries(store, monkeypatch):
    """§6: an imessage queue entry matches by sender ↔ the trigger's `from`
    (case-insensitive) — turning that trigger off cancels only its entries;
    an unknown automation id is a silent no-op."""
    from autowright import listeners as li_mod
    from autowright.firing import cancel_unmatched_queue, fire_trigger
    from conftest import make_version

    notified = []
    monkeypatch.setattr(li_mod, "notify_busy", notified.append)

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Texts", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    keep = {"id": "tk", "kind": "imessage", "enabled": True, "from": "+15551234567"}
    drop = {"id": "td", "kind": "imessage", "enabled": True, "from": "+19998887777"}
    a["triggers"] = [keep, drop]
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, keep,
                 payload={"kind": "imessage", "sender": "+15551234567", "text": "run"})
    fire_trigger(store, engine, a, drop,
                 payload={"kind": "imessage", "sender": "+19998887777", "text": "run"})
    assert len(store.queued_execs(a["id"])) == 2

    a["triggers"][1]["enabled"] = False
    cancel_unmatched_queue(store, engine, a["id"])
    q = store.queued_execs(a["id"])
    assert [h["trigger_payload"]["sender"] for h in q] == ["+15551234567"]
    assert [p["sender"] for p in notified] == ["+19998887777"]

    cancel_unmatched_queue(store, engine, "no-such-automation")  # silent no-op
    assert len(store.queued_execs(a["id"])) == 1


def test_drain_queue_slot_race_leaves_entry_queued(store, monkeypatch):
    """§6 drain race: at_capacity said free but start answers RuntimeError (a
    concurrent starter took the slot) — drain returns and the entry stays
    queued for the next finish; an entry with no queued_at counts as fresh,
    never stale."""
    from autowright.firing import drain_queue, fire_trigger
    from conftest import make_version

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Race", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload("Dave"))
    head = store.queued_execs(a["id"])[0]
    head["queued_at"] = None  # §6: no timestamp reads as freshly queued

    a["_live"] = set()  # capacity looks free…
    monkeypatch.setattr(engine, "start",
                        lambda *args, **kw: (_ for _ in ()).throw(RuntimeError("already executing")))
    drain_queue(store, engine, a["id"])  # …but the slot is taken under us
    assert store.execs[head["id"]]["status"] == "queued"  # still waiting


# ---------- §6 manual queue admission (§19 queue: true) ----------

def test_queue_manual_starts_when_a_slot_is_free(store):
    """§6 manual admission: `queue: true` with a free slot simply starts —
    queueing beside a free slot would promote on the next drain anyway."""
    import time

    from autowright.firing import queue_manual

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Manual Q", None)
    h, queued = queue_manual(store, engine, a, "manual")
    assert queued is False
    t0 = time.time()
    while engine.is_live(h["id"]):
        assert time.time() - t0 < 30
        time.sleep(0.05)
    assert store.exec_full(h["id"])["status"] == "succeeded"


def test_queue_manual_admits_at_capacity_and_drains(store):
    """§6 manual admission: at capacity the entry queues pinned to the current
    version with no payload (trigger `manual`); a freed slot promotes it like
    any firing."""
    import time

    from autowright.firing import drain_queue, queue_manual

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Manual Q", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    h, queued = queue_manual(store, engine, a, "manual")
    assert queued is True
    assert h["status"] == "queued" and h["trigger"] == "manual"
    assert h["trigger_payload"] is None and h["queued_at"]
    assert h["kind"] == "version" and h["version"] == a["current_version"]

    a["_live"] = set()  # the blocking execution finished
    drain_queue(store, engine, a["id"])
    t0 = time.time()
    while engine.is_live(h["id"]):
        assert time.time() - t0 < 30
        time.sleep(0.05)
    assert store.exec_full(h["id"])["status"] == "succeeded"


def test_queue_manual_has_no_ttl(store, monkeypatch):
    """§6 staleness is message-firings-only: a manual entry the user chose to
    queue is promoted no matter how long it waited — evaporating that choice
    would be a silent no-op."""
    import time

    from autowright import firing as firing_mod
    from autowright.firing import drain_queue, queue_manual

    monkeypatch.setattr(firing_mod, "QUEUE_TTL_S", -1.0)  # everything is stale
    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Manual Q", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    h, _queued = queue_manual(store, engine, a, "manual")

    a["_live"] = set()
    drain_queue(store, engine, a["id"])
    t0 = time.time()
    while engine.is_live(h["id"]):
        assert time.time() - t0 < 30
        time.sleep(0.05)
    assert store.exec_full(h["id"])["status"] == "succeeded"  # ran, never skipped


def test_queue_manual_full_queue_and_draft_refuse_with_no_record(store):
    """§6: a manual queue request past the cap — or for a Draft — raises (the
    API's 409) and writes no record; the user is present to decide, unlike a
    message sender."""
    import pytest

    from autowright.firing import fire_trigger, queue_manual

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Manual Q", None)
    a["max_queued"] = 1
    a["_live"] = {"blocking"}
    fire_trigger(store, engine, a, _discord_trig(), payload=_payload())  # fills the queue
    before = set(store.execs)
    with pytest.raises(RuntimeError, match=r"the queue is full \(1 waiting\)"):
        queue_manual(store, engine, a, "manual")
    with pytest.raises(RuntimeError, match="Draft"):
        queue_manual(store, engine, a, "manual", version_label="draft")
    with pytest.raises(LookupError):
        queue_manual(store, engine, a, "manual", version_label="v99")
    assert set(store.execs) == before  # no record any which way


def test_trigger_edits_never_cancel_a_manual_entry(store):
    """§6: cancel_unmatched_queue matches payload-carrying entries only — a
    manual entry was not admitted by any trigger and survives trigger edits."""
    from autowright.firing import cancel_unmatched_queue, queue_manual

    engine, sched = _mk(store)
    a = store.create_automation(make_version(), "Manual Q", None)
    a["max_queued"] = 10  # §4.1: queueing is opt-in — the default 0 would skip
    a["_live"] = {"blocking"}
    h, _queued = queue_manual(store, engine, a, "manual")
    cancel_unmatched_queue(store, engine, a["id"])  # no message triggers enabled at all
    assert store.execs[h["id"]]["status"] == "queued"  # still waiting
