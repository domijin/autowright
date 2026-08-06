"""Scheduler (§6): fires due triggers, coalesces same-moment occurrences,
queues or skips firings that find no free slot, consumes one-shot `time`
triggers, applies the missed-execution policy, and handles retention. There is
no automatic execution-level retry (§6) — transient failures are the engine's
§7 step retry."""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone
from typing import Callable

from . import schedule, timefmt
from .engine import Engine
from .events import hub
from .storage import Store, clamp_max_queued

log = logging.getLogger("autowright.scheduler")

TICK_S = float(os.environ.get("AUTOWRIGHT_TICK_S", "15"))  # §15 knob, config only
QUEUE_TTL_S = float(os.environ.get("AUTOWRIGHT_QUEUE_TTL_S", "120"))  # §15 knob


def finish_queued(store: Store, h: dict, note: str) -> bool:
    """§6: end a queue entry that will never execute — cancelled, too stale, or
    orphaned by a restart. `skipped` (§4.6) is the status for "this occurrence
    never ran", so a cancelled entry uses it too and can never be mistaken for
    the automation's latest execution (§4.1). False when the entry was promoted
    or finished under us — the §19 cancel path then retries on the live record
    instead of reporting a cancel that cancelled nothing."""
    with store.lock:
        if h["status"] != "queued":
            return False  # promoted or already finished under us
        h["status"] = "skipped"
        h["note"] = note
        h["dur_ms"] = 0
        h["finished_at"] = timefmt.now_iso()
        store.update_execution(h)
        payload = h.get("trigger_payload")
        exec_json = store.exec_json(h)
        auto = store.autos.get(h["auto_id"])
        auto_json = store.auto_json(auto, full=False) if auto else None
    hub.publish("exec.finished", execId=h["id"], autoId=h["auto_id"],
                exec_json=exec_json, auto_json=auto_json)
    if payload:
        from .listeners import notify_busy

        notify_busy(payload)
    return True


def fire_trigger(store: Store, engine: Engine, a: dict, t: dict,
                 payload: dict | None = None) -> bool:
    """Start a trigger-fired execution. With every §6 slot taken, a message
    firing is queued when `maxQueued` allows and skipped otherwise; every other
    kind is always skipped (a late cron occurrence is worse than none).
    True when an execution actually started — a queued firing returns False,
    since nothing is executing yet. The capacity check and the start (or the
    queued/skipped record) happen under one lock, so a firing can never race a
    concurrent manual start into a slot that isn't there, or lose its record.
    `payload` is the §4.5 triggerPayload of a message-trigger firing."""
    # §4.5: the record stores the trigger's machine kind — §4.3 kinds are the
    # §4.5 kinds verbatim; labels are derived at serialization.
    kind = t["kind"]
    skipped = False
    started = False
    with store.lock:
        if engine.at_capacity(a):
            queued = store.queued_execs(a["id"]) if payload else []
            cap = clamp_max_queued(a.get("max_queued"))
            if payload and len(queued) < cap:
                h = store.create_execution(a, "version", a["current_version"], kind,
                                           steps=[], status="queued",
                                           trigger_payload=payload)
                # §6: admission is visible immediately — the §7 Waiting section
                # and the §9.2 "N waiting" line update off this, and promotion
                # publishes the ordinary exec.started for the same record.
                hub.publish("exec.queued", execId=h["id"], autoId=a["id"],
                            exec_json=store.exec_json(h))
                skipped = False
            else:
                # §6: past maxQueued the *newest* firing is refused — never an
                # entry already admitted and answered. A full queue is a
                # capacity limit the user fixes by raising maxQueued, so it says
                # so; skip-on-busy (maxQueued 0, or a trigger that can't queue at
                # all) keeps the plain note — nothing was queued to be full.
                note = (f"the queue was full ({cap} waiting)" if payload and cap
                        else "previous execution still in progress")
                h = store.create_execution(a, "version", a["current_version"], kind,
                                           steps=[], status="skipped",
                                           note=note,
                                           trigger_payload=payload)
                h["dur_ms"] = 0
                h["finished_at"] = h["started_at"]
                store.update_execution(h)
                hub.publish("exec.finished", execId=h["id"], autoId=a["id"],
                            exec_json=store.exec_json(h), auto_json=None)
                skipped = True
        else:
            try:
                engine.start(a, kind, payload=payload)
                started = True
            except (RuntimeError, LookupError):
                started = False
    if skipped and payload:
        # §6: a skipped message firing answers its sender. Outside the store lock
        # — notify_busy hands the send to its own thread, but the cooldown check
        # has its own lock and there is no reason to hold this one across it.
        from .listeners import notify_busy

        notify_busy(payload)
    return started


def cancel_unmatched_queue(store: Store, engine: Engine, auto_id: str) -> None:
    """§6: turning a message trigger off (or removing it) cancels the waiting
    entries it admitted — an entry whose payload no longer matches any enabled
    message trigger (same secret + channel for discord; sender matching `from`
    for imessage) can never be re-admitted, and
    promoting it would execute a firing the user just switched off. Called
    after any change to the automation's trigger list."""
    def _key(payload: dict) -> tuple:
        if payload.get("kind") == "imessage":
            return ("imessage", (payload.get("sender") or "").lower())
        return ("discord", payload.get("secret"), payload.get("channel"))

    with store.lock:
        a = store.autos.get(auto_id)
        if a is None:
            return
        live = {("discord", t.get("secret"), t.get("channel"))
                for t in a["triggers"]
                if t["kind"] == "discord" and not t["off"]}
        live |= {("imessage", (t.get("from") or "").lower())
                 for t in a["triggers"]
                 if t["kind"] == "imessage" and not t["off"]}
        doomed = [h["id"] for h in store.queued_execs(auto_id)
                  if _key(h.get("trigger_payload") or {}) not in live]
    for eid in doomed:
        engine.cancel(eid)  # queued → finish_queued: skipped, sender told


def drain_queue(store: Store, engine: Engine, auto_id: str) -> None:
    """§6: hand every free slot to the longest-waiting firing. Entries that
    waited past the TTL are finished instead of executed — answering a stale
    question is noise. Called whenever a slot frees (an execution finishing or
    being cancelled) and on every scheduler tick, so a raised `maxParallel` or a
    missed wake-up still gets picked up."""
    while True:
        with store.lock:
            a = store.autos.get(auto_id)
            if a is None or engine.at_capacity(a):
                return
            queue = store.queued_execs(auto_id)
            if not queue:
                return
            head = queue[0]
            stale = _waited_s(head) > QUEUE_TTL_S
            if not stale:
                try:
                    engine.start(a, head["trigger"],
                                 version_label=f"v{head['version']}",
                                 payload=head.get("trigger_payload"), adopt=head)
                    continue
                except LookupError:
                    # The version this firing was admitted against is gone (§7
                    # restore/rollback). The entry can never execute — end it
                    # rather than blocking the queue behind it forever.
                    pass
                except RuntimeError:
                    return  # slot taken under us; the next finish drains again
        finish_queued(store, head,
                      "waited too long in the queue" if stale
                      else f"version v{head['version']} no longer exists")


def _waited_s(h: dict) -> float:
    q = h.get("queued_at")
    if not q:
        return 0.0
    return (datetime.now(timezone.utc) - datetime.fromisoformat(q)).total_seconds()


class Scheduler:
    def __init__(self, store: Store, engine: Engine,
                 clock: Callable[[], datetime] = datetime.now,
                 utc_clock: Callable[[], datetime] | None = None):
        self.store = store
        self.engine = engine
        self._clock = clock
        # Baselines are compared against the local wall clock, which is not
        # monotonic: a DST fall-back rewinds it by an hour with no clock step at
        # all. The UTC reading tells the two apart (§4.3: an hour repeated by
        # fall-back fires once) — only a genuine backward step moves it.
        self._utc_clock = utc_clock or (lambda: datetime.now(timezone.utc))
        # (automation id, trigger id) → last position; occurrences at or before
        # it never fire (startup baseline = now, §6 no catch-up queue).
        self._baseline: dict[tuple[str, str], datetime] = {}
        self._baseline_utc: dict[tuple[str, str], datetime] = {}
        self._stop = threading.Event()
        self._last_retention = clock()
        engine.drain_queue = lambda auto_id: drain_queue(self.store, self.engine, auto_id)  # type: ignore[attr-defined]

    def start(self) -> None:
        t = threading.Thread(target=self._loop, daemon=True, name="ad-scheduler")
        t.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(TICK_S):
            try:
                self._tick()
            except Exception:  # noqa: BLE001
                # Never let one bad tick kill the thread — but never hide it
                # either: a persistent failure here silently turns triggers off.
                log.exception("scheduler tick failed")

    def _set_baseline(self, key: tuple[str, str], now: datetime, now_utc: datetime) -> None:
        self._baseline[key] = now
        self._baseline_utc[key] = now_utc

    def _tick(self) -> None:
        now = self._clock()
        now_utc = self._utc_clock()
        with self.store.lock:
            autos = list(self.store.autos.values())
        live_keys: set[tuple[str, str]] = set()
        for a in autos:
            due: list[tuple[datetime, dict]] = []
            for t in list(a["triggers"]):  # consume_trigger below mutates the list
                key = (a["id"], t["id"])
                live_keys.add(key)
                if key not in self._baseline:
                    self._set_baseline(key, now, now_utc)
                base = self._baseline[key]
                if base > now and now_utc < self._baseline_utc[key]:
                    # A backward clock step (NTP) must not silence every
                    # trigger until the wall clock re-reaches the old baseline.
                    # UTC moved back too, so this is a real step — not a DST
                    # fall-back, where holding the baseline is what makes the
                    # repeated hour fire once (§4.3).
                    base = now
                    self._set_baseline(key, now, now_utc)
                if t["off"]:
                    # Occurrences passing while off never fire, even after a re-enable.
                    self._set_baseline(key, now, now_utc)
                    if schedule.time_elapsed(t, now):
                        # §4.3: a spent one-shot never lingers — consumed even
                        # when its moment passed while the trigger was off.
                        self.store.consume_trigger(a, t["id"])
                        hub.publish("auto.changed", autoId=a["id"])
                    continue
                occ = schedule.trigger_next(t, after=base)
                if occ and occ <= now:
                    # §6: at most one catch-up per wake — swallow every older occurrence.
                    self._set_baseline(key, now, now_utc)
                    due.append((occ, t))
                elif occ is None and schedule.time_elapsed(t, now):
                    # §4.3: the one-shot's moment passed before the baseline
                    # (backend down when it passed) — consumed, never fired.
                    self.store.consume_trigger(a, t["id"])
                    hub.publish("auto.changed", autoId=a["id"])
            if due:
                # §6: same-moment (and same-wake) occurrences coalesce into one execution.
                due.sort(key=lambda p: p[0])
                self._fire(a, due[0][1])
                consumed = False
                for _, t in due:
                    if t["kind"] == "time":
                        self.store.consume_trigger(a, t["id"])
                        consumed = True
                if consumed:
                    hub.publish("auto.changed", autoId=a["id"])
            # §6: drain here as well as on every execution finish — a raised
            # maxParallel, or a finish whose drain lost a race, is picked up
            # within a tick rather than waiting for the next firing.
            drain_queue(self.store, self.engine, a["id"])
        # Forget baselines of deleted automations / removed triggers.
        self._baseline = {k: v for k, v in self._baseline.items() if k in live_keys}
        self._baseline_utc = {k: v for k, v in self._baseline_utc.items() if k in live_keys}
        if (now - self._last_retention).total_seconds() > 3600:
            self._last_retention = now
            removed = self.store.retention_cleanup()
            if removed:
                hub.publish("auto.changed")

    def _fire(self, a: dict, t: dict) -> None:
        # §6: a cron/one-shot/app-start firing with no free slot is skipped, never
        # queued — only message firings queue (a due one-shot is still consumed by
        # the caller).
        fire_trigger(self.store, self.engine, a, t)
