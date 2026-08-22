"""§15 drift guards: cheap textual checks over facts that live in more than one
hand-maintained file, where nothing else would catch the two copies diverging.

Two guards, both deliberately dumb (read the file, pull the fact out, compare):

1. the app version: `VERSION` is the single source (§17), synced into three
   other files by `release.sh`; a hand-edit to any one of them must fail here.
2. the §6.2 curated package list: four homes, two of which name *import*
   modules and two of which name *distributions*, so the mapping between them
   is written out below instead of guessed.
"""
import json
import re
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# §6.2 curated packages: import name → pip distribution name. Equal where the
# two agree; spelled out where they don't (this mapping is the whole reason the
# four homes can look different and still be in sync).
CURATED = {
    "requests": "requests",
    "httpx": "httpx",
    "bs4": "beautifulsoup4",
    "lxml": "lxml",
    "feedparser": "feedparser",
    "dateutil": "python-dateutil",
    "yaml": "PyYAML",
}


def _read(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def _backticked(text: str) -> list[str]:
    return re.findall(r"`([^`]+)`", text)


# ---------------------------------------------------------------- version

def test_version_agrees_across_every_site():
    """§17: `VERSION` is the single source; `release.sh --sync` writes the other
    three. A mismatch means someone hand-edited one of them."""
    version = _read("VERSION").strip()
    assert re.fullmatch(r"\d+\.\d+\.\d+(?:[-+].+)?", version), \
        f"VERSION is not semver: {version!r}"

    pyproject = tomllib.loads(_read("backend/pyproject.toml"))["project"]["version"]
    init = re.search(r'^__version__\s*=\s*"([^"]+)"',
                     _read("backend/autowright/__init__.py"), re.M)
    package_json = json.loads(_read("app/package.json"))["version"]

    assert init, "backend/autowright/__init__.py has no __version__ line"
    mismatched = {site: found for site, found in [
        ("backend/pyproject.toml", pyproject),
        ("backend/autowright/__init__.py", init.group(1)),
        ("app/package.json", package_json),
    ] if found != version}
    assert not mismatched, (
        f"version drift: VERSION says {version!r} but: {mismatched}. "
        "Re-sync with `./scripts/release.sh --sync`.")


# ---------------------------------------------------------------- §6.2 curated list

def test_curated_imports_match_the_allowlist_in_code():
    """Home 1, `imports_check.ALLOWED_IMPORTS`: the enforcement itself
    (draft-time validation + the runtime executor)."""
    from autowright.imports_check import ALLOWED_IMPORTS

    curated = ALLOWED_IMPORTS - set(sys.stdlib_module_names) - {"autowright"}
    assert curated == set(CURATED), (
        "imports_check.ALLOWED_IMPORTS disagrees with the §6.2 curated list: "
        f"only in code {sorted(curated - set(CURATED))}, "
        f"only in the list {sorted(set(CURATED) - curated)}")


def test_curated_packages_are_declared_dependencies():
    """Home 2, `backend/pyproject.toml`. A curated import must be a real
    runtime dependency, or the bundled interpreter ships without it and every
    step that imports it fails at execution time. (One direction only: the
    backend legitimately depends on packages that are not curated.)"""
    deps = tomllib.loads(_read("backend/pyproject.toml"))["project"]["dependencies"]
    declared = {re.split(r"[<>=!~\[ ]", d, maxsplit=1)[0].lower() for d in deps}
    missing = sorted(dist for dist in CURATED.values() if dist.lower() not in declared)
    assert not missing, (
        f"§6.2 curated packages missing from backend/pyproject.toml dependencies: "
        f"{missing}; the distributable would not ship them.")


def test_curated_list_matches_the_framework_instructions():
    """Home 3, `instructions/framework-instructions.md`: the §8 contract
    preamble the drafting agent reads. It names *import* modules."""
    text = _read("backend/autowright/instructions/framework-instructions.md")
    m = re.search(r"## Allowed imports\s+Python stdlib,(.*?)— always available",
                  text, re.S)
    assert m, "framework-instructions.md has no 'Allowed imports' sentence to check"
    listed = set(_backticked(m.group(1))) - {"autowright"}
    assert listed == set(CURATED), (
        "framework-instructions.md's allowed-imports sentence disagrees with the "
        f"§6.2 curated list: only in the file {sorted(listed - set(CURATED))}, "
        f"only in the list {sorted(set(CURATED) - listed)}")


def test_curated_list_matches_the_spec():
    """Home 4, §6.2 in `spec/engine.md`: the source of truth. It names
    *distributions* with the import module in parentheses where they differ, so
    both spellings must appear."""
    m = re.search(r"and the curated packages:(.*?)\.\n", _read("spec/engine.md"), re.S)
    assert m, "spec/engine.md §6.2 has no 'curated packages:' sentence to check"
    listed = set(_backticked(m.group(1)))
    expected = set(CURATED) | set(CURATED.values())
    assert listed == expected, (
        "spec/engine.md §6.2 disagrees with the curated list (it must name each "
        "distribution, plus the import module where they differ): "
        f"only in the spec {sorted(listed - expected)}, "
        f"only in the list {sorted(expected - listed)}")


def test_powershell_scripts_start_with_a_utf8_bom():
    """§17/§18 `scripts/*.ps1` + `windows-scripts/*.ps1`: Windows PowerShell
    5.1 reads a BOM-less file as ANSI, and the scripts carry non-ASCII
    characters in their result lines (`·`, `—`). Without the BOM those bytes
    decode into stray quote characters and the script fails to parse — a hard
    failure at build time, from an invisible property of the file. Guarded
    because any editor (or tooling) that rewrites the file as plain UTF-8
    removes it silently."""
    scripts = sorted((REPO / "scripts").glob("*.ps1"))
    scripts += sorted((REPO / "windows-scripts").glob("*.ps1"))
    assert scripts, "no *.ps1 found — did the §17 PowerShell scripts move?"
    for path in scripts:
        head = path.read_bytes()[:3]
        assert head == b"\xef\xbb\xbf", (
            f"{path.relative_to(REPO)} lost its UTF-8 BOM — Windows PowerShell "
            "5.1 would misread its non-ASCII output lines and fail to parse it")
