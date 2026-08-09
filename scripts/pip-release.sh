#!/usr/bin/env bash
# Build and upload the pypi/ placeholder package — reserves the `autowright`
# name on PyPI (§17). Unrelated to the app build and to release.sh: the real
# backend package lives in backend/ and is never published to PyPI.
# Creates pypi/.venv if missing, installs build + twine, rebuilds dist/ from
# scratch, validates with `twine check`, then uploads. Credentials come from
# ~/.pypirc or TWINE_USERNAME/TWINE_PASSWORD (API token: username __token__,
# password pypi-...) — never stored in the repo.
#
#   ./scripts/pip-release.sh            build + check + upload to PyPI
#   ./scripts/pip-release.sh --test     upload to TestPyPI instead
#   ./scripts/pip-release.sh --build    build + check only, no upload
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/pypi"
PY="$PKG/.venv/bin/python"

cd "$PKG"

if [ ! -x "$PY" ]; then
  echo "· creating pypi/.venv"
  python3 -m venv .venv
fi
echo "· installing build + twine"
"$PY" -m pip install --quiet --upgrade build twine

echo "· rebuilding dist/"
rm -rf dist
"$PY" -m build
"$PY" -m twine check dist/*

case "${1:-}" in
  --build)
    echo "· build only — skipping upload"
    exit 0
    ;;
  --test)
    echo "· uploading to TestPyPI"
    "$PY" -m twine upload --repository testpypi dist/*
    ;;
  *)
    echo "· uploading to PyPI"
    "$PY" -m twine upload dist/*
    echo "· done — https://pypi.org/project/autowright/"
    ;;
esac
