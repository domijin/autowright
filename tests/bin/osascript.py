"""Windows twin of the fake `osascript` recorder (§15 test doubles).

Contract pair: `tests/bin/osascript` (POSIX sh) is the contract — this is a
faithful port of it, byte-for-byte on every observable: argv appended to
AUTOWRIGHT_TEST_OSASCRIPT_LOG (one line per call, every field followed by a
tab, LF-terminated, UTF-8, append mode), and AUTOWRIGHT_TEST_OSASCRIPT_FAIL
simulating the macOS Automation denial (Apple events error -1743) on stderr
with exit 1. Otherwise exit 0, no output.

Reached through `osascript.cmd`, which PATHEXT resolves ahead of the
extensionless POSIX file; conftest publishes the interpreter to run it as
AUTOWRIGHT_TEST_PYTHON.
"""
import os
import sys

DENIAL = (b"execution error: Not authorized to send Apple events to "
          b"Messages. (-1743)\n")


def main() -> None:
    args = sys.argv[1:]
    log = os.environ.get("AUTOWRIGHT_TEST_OSASCRIPT_LOG")
    if log:
        # `for a in "$@"; do out="$out$a\t"; done; printf '%s\n' "$out"`
        line = "".join(a + "\t" for a in args) + "\n"
        with open(log, "ab") as f:
            f.write(line.encode("utf-8"))
    if os.environ.get("AUTOWRIGHT_TEST_OSASCRIPT_FAIL"):
        sys.stderr.buffer.write(DENIAL)
        sys.stderr.buffer.flush()
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
