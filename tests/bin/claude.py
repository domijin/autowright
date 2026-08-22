"""Windows twin of the fake `claude` CLI (§15 test doubles).

Contract pair: `tests/bin/claude` is the POSIX implementation and the
contract — this file must produce byte-identical observable behavior (same
argv handling, same AUTOWRIGHT_TEST_* knobs, same stdout/stderr, same exit
codes). `tests/bin/claude` is itself a Python script, so the twin *runs that
exact source* instead of restating it: the pair cannot drift.

Only the Windows-specific stream setup lives here:

* newline "\\n" — text mode would otherwise translate every line ending to
  CRLF, corrupting the §8 envelopes and the stream-json lines.
* UTF-8 — the §2 pipe-encoding contract: the backend's `subprocess` reader
  (harness.py) decodes explicit UTF-8, never the locale codec, so the fake
  writes exactly that. Pinning it keeps the pair deterministic under a
  PYTHONIOENCODING that only the child would see. stdin gets the same
  treatment for the §8 Windows form, where the prompt arrives on the pipe —
  encoding only, never `newline`: the writer's "\\n" reaches the pipe as
  "\\r\\n" (text-mode translation), and universal-newline reading is what turns
  it back into the exact prompt the backend sent.

Reached through `claude.cmd`, which PATHEXT resolves ahead of the
extensionless POSIX file; conftest publishes the interpreter to run it as
AUTOWRIGHT_TEST_PYTHON.
"""
import os
import runpy
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    except (AttributeError, ValueError):  # pragma: no cover - defensive
        pass

try:
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):  # pragma: no cover - defensive
    pass

runpy.run_path(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude"),
    run_name="__main__",
)
