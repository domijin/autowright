"""Scheduler (§6): the trigger tick loop — fires due triggers, coalesces
same-moment occurrences, consumes one-shot `time` triggers, applies the
missed-execution policy, and handles retention. The queue/firing mechanics
live in firing.py. There is no automatic execution-level retry (§6) —
transient failures are the engine's §7 step retry."""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone
from typing import Callable

from . import triggers as triggerlib
from .engine import Engine
from .events import hub
from .firing import drain_queue, fire_trigger
from .storage import Store

log = logging.getLogger("autowright.scheduler")

TICK_S = float(os.environ.get("AUTOWRIGHT_TICK_S", "15"))  # §15 knob, config only


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
        engine.drain_queue = lambda automation_id: drain_queue(self.store, self.engine, automation_id)  # type: ignore[attr-defined]

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
                if not t["enabled"]:
                    # Occurrences passing while off never fire, even after a re-enable.
                    self._set_baseline(key, now, now_utc)
                    if triggerlib.time_elapsed(t, now):
                        # §4.3: a spent one-shot never lingers — consumed even
                        # when its moment passed while the trigger was off.
                        self.store.consume_trigger(a, t["id"])
                        hub.publish("automation.changed", automationId=a["id"])
                    continue
                occ = triggerlib.trigger_next(t, after=base)
                if occ and occ <= now:
                    # §6: at most one catch-up per wake — swallow every older occurrence.
                    self._set_baseline(key, now, now_utc)
                    due.append((occ, t))
                elif occ is None and triggerlib.time_elapsed(t, now):
                    # §4.3: the one-shot's moment passed before the baseline
                    # (backend down when it passed) — consumed, never fired.
                    self.store.consume_trigger(a, t["id"])
                    hub.publish("automation.changed", automationId=a["id"])
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
                    hub.publish("automation.changed", automationId=a["id"])
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
                hub.publish("automation.changed")

    def _fire(self, a: dict, t: dict) -> None:
        # §6: a cron/one-shot/app-start firing with no free slot is skipped, never
        # queued — only message firings queue (a due one-shot is still consumed by
        # the caller).
        fire_trigger(self.store, self.engine, a, t)
