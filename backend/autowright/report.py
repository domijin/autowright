"""§9.5 bug-report drafting — §19 POST /report/draft.

A one-off `harness.invoke` job **outside** the §8 pipeline: its own small
purpose-built prompt, no instruction files, no envelopes, no repair rounds,
web disabled.
"""

from __future__ import annotations

import logging
import re
import signal
import threading
import uuid

from . import harness, paths
from .drafting import Cancelled

log = logging.getLogger("autowright.report")

LOG_TAIL_BYTES = 16 * 1024   # §19: last 16 KiB each of app.log / backend.err.log
BODY_CAP = 6_000             # §9.5: GitHub prefill URLs cap ~8 KB — clamp the body
LOG_FILES = ("app.log", "backend.err.log")

_KIND_LABEL = {"bug": "bug report", "feature": "feature request"}

_PROMPT = """\
You are writing a GitHub issue for Autowright, a macOS desktop app for
recurring personal automations. Draft a {kind_label} from the material below.

Rules:
- Clear, factual markdown. Body sections, in order: "### What happened",
  "### Steps to reproduce", "### Expected", "### Environment". Omit a section
  when the material gives it nothing.
- Keep the body under {body_cap} characters.
- Redact anything that looks like a token, secret, password, API key, or
  email address — replace it with [redacted].
- Use only facts from the material — never invent reproduction steps or
  environment details it doesn't support. The log tails are context for
  finding the relevant error; quote only the decisive lines, not whole logs.
- Answer with exactly this format and nothing else:

===TITLE===
<one-line issue title>
===BODY===
<markdown body>

Material:

KIND: {kind_label}

USER REPORT:
{text}

APP INFO:
{info}

LOG TAILS:
{logs}
"""


def build_prompt(kind: str, text: str | None, info: str | None, logs: str) -> str:
    return _PROMPT.format(kind_label=_KIND_LABEL.get(kind, "bug report"),
                          body_cap=BODY_CAP,
                          text=(text or "").strip() or "(none)",
                          info=(info or "").strip() or "(none)",
                          logs=logs.strip() or "(none)")


def log_tails() -> str:
    """Last 16 KiB of each §19-named log file in the §5 logs dir; a missing or
    unreadable file is simply absent (partial first line trimmed on a mid-file
    read, like the §9.3 tail)."""
    parts = []
    for name in LOG_FILES:
        try:
            data = (paths.logs_dir() / name).read_bytes()
        except OSError:
            continue
        tail = data[-LOG_TAIL_BYTES:].decode("utf-8", "replace")
        if len(data) > LOG_TAIL_BYTES:
            tail = tail.split("\n", 1)[-1]
        parts.append(f"----- {name} -----\n{tail}")
    return "\n\n".join(parts)


def parse_reply(raw: str) -> dict:
    """§19: a reply missing the markers degrades, never fails — whole reply
    becomes the body, its first line the title."""
    m = re.search(r"===TITLE===\s*(.*?)\s*===BODY===\s*(.*)", raw, re.S)
    if m:
        title, body = m.group(1).strip(), m.group(2).strip()
    else:
        body = raw.strip()
        title = body.split("\n", 1)[0].strip()
    return {"title": title[:200], "body": body[:BODY_CAP]}


class ReportDraftJobs:
    """§19 POST /report/draft — one harness call as a background job."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self._lock = threading.Lock()

    def start(self, agent: dict, kind: str, text: str | None,
              info: str | None) -> str:
        job_id = str(uuid.uuid4())
        job = {"id": job_id, "status": "running", "error": None, "draft": None,
               "_cancel": False, "_proc": {}}
        with self._lock:
            terminal = [k for k, v in self.jobs.items() if v["status"] != "running"]
            for k in terminal[:-20]:
                del self.jobs[k]
            self.jobs[job_id] = job
        threading.Thread(target=self._run, args=(job, agent, kind, text, info),
                         daemon=True).start()
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            j = self.jobs.get(job_id)
            if not j:
                return None
            return {k: v for k, v in j.items() if not k.startswith("_")}

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            j = self.jobs.get(job_id)
            # A cancel racing completion must not clobber a terminal job.
            if not j or j["status"] != "running":
                return False
            j["_cancel"] = True
            j["status"] = "cancelled"
        proc = j["_proc"].get("proc")
        if proc and proc.poll() is None:
            # The whole session group — CLIs spawn helpers that terminate
            # alone won't reach.
            harness.kill_group(proc, signal.SIGTERM)
        return True

    def _settle(self, job: dict, status: str, **fields) -> bool:
        with self._lock:
            if job["status"] != "running":
                return False
            job["status"] = status
            job.update(fields)
            return True

    @staticmethod
    def _check_cancel(job: dict) -> None:
        if job["_cancel"]:
            raise Cancelled()

    def _run(self, job: dict, agent: dict, kind: str, text: str | None,
             info: str | None) -> None:
        try:
            prompt = build_prompt(kind, text, info, log_tails())
            self._check_cancel(job)
            raw = harness.invoke(agent, prompt, proc_holder=job["_proc"],
                                 should_abort=lambda: job["_cancel"])
            self._check_cancel(job)
            self._settle(job, "done", draft=parse_reply(raw))
        except Cancelled:
            self._settle(job, "cancelled")
        except harness.HarnessError as e:
            # A cancel-induced kill surfaces as a nonzero exit — never a failure.
            if job["_cancel"]:
                self._settle(job, "cancelled")
            else:
                self._settle(job, "failed", error=str(e))
        except Exception as e:  # noqa: BLE001 — a dead thread must not leave "running"
            log.exception("report draft job %s crashed", job["id"])
            self._settle(job, "failed", error=f"drafting failed unexpectedly: {e}")


report_jobs = ReportDraftJobs()
