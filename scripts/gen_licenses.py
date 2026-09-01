#!/usr/bin/env python3
"""Regenerate app/src/acknowledgements.md (§4.9 open-source libraries).

Lists every shipped component with name, version, license id, and the package's
license text when it ships one:
  - npm production closure (`npm ls --omit=dev --all --json` in app/), plus
    Electron — a dev dependency, but its runtime ships in the bundle
  - backend: recursive distribution closure of the `autowright` package
    (dev extras excluded), as the union across macOS, Windows, and Linux

The Python closure evaluates environment markers against all three target
platforms, so the output is identical no matter which OS regenerates it.
Marker-gated distributions absent from the local venv (tzdata on Windows, the
Linux keyring stack, ...) are resolved from a downloaded wheel cached under
build/license-wheels/ (gitignored; reused offline once present). A distribution
that resolves neither locally nor from a wheel aborts generation — never a
silent drop.

Run from anywhere: paths resolve relative to the repo root. build.sh runs this
on every build so the file tracks dependency changes.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
OUT = APP / "src" / "acknowledgements.md"

LICENSE_FILE_RE = re.compile(r"^(licen[cs]e|copying|notice)", re.IGNORECASE)


def read_license_text(pkg_dir: Path) -> str | None:
    if not pkg_dir.is_dir():
        return None
    for f in sorted(pkg_dir.iterdir()):
        if f.is_file() and LICENSE_FILE_RE.match(f.name):
            try:
                return f.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                return None
    return None


def npm_packages() -> list[dict]:
    """Production closure from npm ls, plus Electron."""
    out = subprocess.run(
        ["npm", "ls", "--omit=dev", "--all", "--json"],
        cwd=APP, capture_output=True, text=True, check=False,
    ).stdout
    tree = json.loads(out or "{}")

    flat: dict[str, dict] = {}

    def walk(deps: dict) -> None:
        for name, node in (deps or {}).items():
            version = node.get("version")
            if version and name not in flat:
                flat[name] = node
            walk(node.get("dependencies") or {})

    walk(tree.get("dependencies") or {})

    pkgs = []
    for name in sorted(flat, key=str.lower) + ["electron"]:
        pkg_dir = APP / "node_modules" / name
        meta_path = pkg_dir / "package.json"
        if not meta_path.is_file():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        license_id = meta.get("license")
        if isinstance(license_id, dict):
            license_id = license_id.get("type")
        pkgs.append({
            "name": name,
            "version": meta.get("version", "?"),
            "license": license_id or "see license text",
            "text": read_license_text(pkg_dir),
        })
    return pkgs


def python_packages() -> list[dict]:
    """Union dist closure of `autowright` across macOS/Windows/Linux, dev extras
    excluded. Dists the local venv lacks (marker-gated for another OS) resolve
    from a wheel cached in build/license-wheels/."""
    cache = ROOT / "build" / "license-wheels"
    code = r"""
import email, json, re, subprocess, sys, zipfile
from importlib import metadata
from pathlib import Path
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name, parse_wheel_filename

CACHE = Path(sys.argv[1])
# Marker environments for every OS Autowright ships on (§9 LEGAL: the file is
# the union across all of them, identical regardless of the regenerating host).
PLATFORMS = {
    'macOS':   {'sys_platform': 'darwin', 'platform_system': 'Darwin',
                'os_name': 'posix', 'platform_machine': 'arm64'},
    'Windows': {'sys_platform': 'win32', 'platform_system': 'Windows',
                'os_name': 'nt', 'platform_machine': 'AMD64'},
    'Linux':   {'sys_platform': 'linux', 'platform_system': 'Linux',
                'os_name': 'posix', 'platform_machine': 'x86_64'},
}
BASE = default_environment() | {'extra': ''}  # extra='' drops [dev]-only reqs
LICENSE_RE = re.compile(r'(licen[cs]e|copying|notice)', re.IGNORECASE)

def platforms_for(req):
    if req.marker is None:
        return set(PLATFORMS)
    return {p for p, env in PLATFORMS.items() if req.marker.evaluate(BASE | env)}

def license_id(meta):
    lic = meta.get('License-Expression') or meta.get('License')
    if not lic or len(lic) > 40:
        lic = next((c.split('::')[-1].strip() for c in meta.get_all('Classifier') or []
                    if c.startswith('License ::')), None) or 'see license text'
    return lic

def from_local(name):
    dist = metadata.distribution(name)
    text = None
    for f in dist.files or []:
        if LICENSE_RE.match(f.name):
            try:
                text = f.locate().read_text(encoding='utf-8', errors='replace').strip()
            except OSError:
                pass
            break
    return {'name': dist.name, 'version': dist.version, 'license': license_id(dist.metadata),
            'text': text, 'requires': dist.requires or []}

def cached_wheel(key):
    return next((w for w in sorted(CACHE.glob('*.whl'))
                 if parse_wheel_filename(w.name)[0] == key), None)

def from_wheel(name):
    key = canonicalize_name(name)
    whl = cached_wheel(key)
    if whl is None:
        subprocess.run(
            [sys.executable, '-m', 'pip', '-q', 'download', '--no-deps',
             '--only-binary', ':all:', '--dest', str(CACHE), name],
            check=True, stdout=subprocess.DEVNULL)
        whl = cached_wheel(key)
    if whl is None:
        raise RuntimeError(f'no wheel found for {name} after pip download')
    with zipfile.ZipFile(whl) as z:
        names = z.namelist()
        meta_path = next(n for n in names
                         if n.endswith('.dist-info/METADATA') and n.count('/') == 1)
        meta = email.message_from_bytes(z.read(meta_path))
        info_dir = meta_path.rsplit('/', 1)[0]
        text = None
        for n in sorted(names):
            if n.startswith(info_dir + '/') and LICENSE_RE.match(n.rsplit('/', 1)[1]):
                text = z.read(n).decode('utf-8', errors='replace').strip()
                break
    return {'name': meta['Name'], 'version': meta['Version'], 'license': license_id(meta),
            'text': text, 'requires': meta.get_all('Requires-Dist') or []}

CACHE.mkdir(parents=True, exist_ok=True)
seen = {}
queue = [('autowright', frozenset(PLATFORMS))]
while queue:
    name, plats = queue.pop()
    key = canonicalize_name(name)
    entry = seen.get(key)
    if entry is None:
        try:
            info = from_local(name)
        except metadata.PackageNotFoundError:
            info = from_wheel(name)
        entry = seen[key] = {'platforms': set(), **info}
    new = set(plats) - entry['platforms']
    if not new:
        continue
    entry['platforms'] |= new
    for r in entry['requires']:
        req = Requirement(r)
        p = platforms_for(req) & entry['platforms']
        if p:
            queue.append((req.name, frozenset(p)))

order = ['macOS', 'Windows', 'Linux']
out = []
for key in sorted(seen):
    if key == 'autowright':
        continue  # the app itself — not a third-party component
    e = seen[key]
    plats = [p for p in order if p in e['platforms']]
    out.append({'name': e['name'], 'version': e['version'], 'license': e['license'],
                'text': e['text'],
                'platforms': '' if len(plats) == len(order) else ' and '.join(plats) + ' only'})
print(json.dumps(out))
"""
    out = subprocess.run(
        [str(ROOT / ".venv" / "bin" / "python"), "-c", code, str(cache)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def section(title: str, note: str, pkgs: list[dict]) -> list[str]:
    lines = [f"## {title}", "", note, ""]
    for p in pkgs:
        head = f"### {p['name']} {p['version']} — {p['license']}"
        if p.get("platforms"):
            head += f" ({p['platforms']})"
        lines += [head, ""]
        if p["text"]:
            lines += ["```", p["text"], "```", ""]
    return lines


def main() -> None:
    npm = npm_packages()
    py = python_packages()
    # No H1 and no HTML comment: the §4.9 modal supplies the title, and
    # react-markdown shows raw HTML as literal text. The link-label line below
    # is markdown's invisible-comment idiom — it never renders.
    lines = [
        "[//]: # (Generated by scripts/gen_licenses.py — do not edit by hand.)",
        "",
        "Autowright ships with these open-source components. Each keeps its own",
        "license and copyright. The list covers every platform Autowright ships",
        "on; an entry marked with a platform ships only in that platform's",
        "builds.",
        "",
        *section("App (npm)", "The Electron app and its production dependencies.", npm),
        *section("Backend (Python)",
                 "The backend service and its dependencies, across macOS, Windows, and Linux.",
                 py),
    ]
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} — {len(npm)} npm + {len(py)} python packages")


if __name__ == "__main__":
    sys.exit(main())
