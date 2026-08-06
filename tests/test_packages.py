"""Declared-package management (§6.2) — no network, no pip runs."""
import io
import json

import pytest


def _fake_dist(home, name="requests", version="2.31.0"):
    """Minimal installed distribution in the §6.2 site-packages dir."""
    d = home / "site-packages" / f"{name}-{version}.dist-info"
    d.mkdir(parents=True)
    (d / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n", encoding="utf-8")


def test_norm_pep503():
    from autowright.packages import _norm

    assert _norm("requests") == "requests"
    assert _norm("Beautiful.Soup_4") == "beautiful-soup-4"
    assert _norm("A__b..c--d") == "a-b-c-d"
    assert _norm("Typing_Extensions") == "typing-extensions"


def test_pip_name_re():
    from autowright.packages import PIP_NAME_RE

    assert PIP_NAME_RE.match("requests")
    assert PIP_NAME_RE.match("beautifulsoup4")
    assert PIP_NAME_RE.match("typing_extensions")
    assert not PIP_NAME_RE.match("bad name!")
    assert not PIP_NAME_RE.match("")
    assert not PIP_NAME_RE.match("-leading")
    assert not PIP_NAME_RE.match("requests==2.0")  # §6.2: bare names, no specifier


def test_check_missing_then_installed(home):
    from autowright.packages import check

    entries = [{"pip": "requests", "import": "requests"}]
    assert check(entries) == [{"pip": "requests", "import": "requests", "status": "missing"}]

    _fake_dist(home, "requests", "2.31.0")
    assert check(entries) == [{"pip": "requests", "import": "requests",
                               "status": "installed", "version": "2.31.0"}]
    # normalization applies: manifest spelling differs, distribution still found
    assert check([{"pip": "Requests", "import": "requests"}])[0]["status"] == "installed"
    # invalid names never match anything
    assert check([{"pip": "bad name!", "import": "x"}])[0]["status"] == "missing"


def _pypi_payload():
    """Releases crafted so every skip rule fires before the winner (1.2)."""
    return {"releases": {
        "2.0a1": [{"filename": "pkg-2.0a1-py3-none-any.whl"}],           # prerelease
        "1.9.dev1": [{"filename": "pkg-1.9.dev1-py3-none-any.whl"}],     # dev release
        "1.8": [],                                                        # no files
        "1.7": [{"filename": "pkg-1.7-py3-none-any.whl", "yanked": True}],
        "1.6": [{"filename": "pkg-1.6.tar.gz"}],                          # sdist only
        "1.5": [{"filename": "pkg-1.5-cp27-cp27m-manylinux1_x86_64.whl"}],  # bad tags
        "1.2": [{"filename": "pkg-1.2-py3-none-any.whl"}],                # winner
        "not-a-version": [{"filename": "pkg-x-py3-none-any.whl"}],
    }}


def test_latest_compatible_picks_newest_valid_wheel(monkeypatch):
    from autowright.packages import _latest_compatible

    urls = []

    def fake_urlopen(req, timeout=None):
        urls.append(req.full_url)
        return io.BytesIO(json.dumps(_pypi_payload()).encode("utf-8"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    assert _latest_compatible("Pkg") == "1.2"
    # lookup goes to the PEP 503-normalized project URL
    assert urls == ["https://pypi.org/pypi/pkg/json"]


def test_latest_compatible_none_when_nothing_ships_a_usable_wheel(monkeypatch):
    from autowright.packages import _latest_compatible

    payload = {"releases": {"1.0": [{"filename": "pkg-1.0.tar.gz"}]}}
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda req, timeout=None: io.BytesIO(json.dumps(payload).encode("utf-8")))
    assert _latest_compatible("pkg") is None


def test_fetch_failure_means_no_update_badge(monkeypatch):
    """§6.2 advisory contract: _latest_compatible raises on a fetch failure;
    the swallow lives in outdated's probe (its only caller), so through the
    §19 outdated endpoint the badge simply stays off."""
    import urllib.error

    from autowright import packages

    def boom(req, timeout=None):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    with pytest.raises(urllib.error.URLError):
        packages._latest_compatible("pkg")

    monkeypatch.setattr(packages, "_installed_versions", lambda: {"pkg": "1.0"})
    assert packages.outdated([{"pip": "pkg", "import": "pkg"}]) == [
        {"pip": "pkg", "import": "pkg"}]  # no "latest" key


def test_outdated_empty_entries_and_skip_paths(home, monkeypatch):
    """outdated([]) short-circuits; a broken dist-info never blocks the
    installed check; an unparsable wheel filename is skipped, not fatal."""
    from autowright import packages

    assert packages.outdated([]) == []

    # broken dist-info (no Name in METADATA) — siblings still resolve
    bad = home / "site-packages" / "broken-0.0.0.dist-info"
    bad.mkdir(parents=True)
    (bad / "METADATA").write_text("Metadata-Version: 2.1\n", encoding="utf-8")
    _fake_dist(home, "requests", "2.31.0")
    assert packages.check([{"pip": "requests", "import": "requests"}])[0]["status"] == "installed"

    # a .whl whose filename doesn't parse is skipped; the next release wins
    payload = {"releases": {
        "1.3": [{"filename": "pkg-1.3.whl"}],  # not name-ver-tags shaped
        "1.2": [{"filename": "pkg-1.2-py3-none-any.whl"}],
    }}
    monkeypatch.setattr(
        "urllib.request.urlopen",
        lambda req, timeout=None: io.BytesIO(json.dumps(payload).encode("utf-8")))
    assert packages._latest_compatible("pkg") == "1.2"


def test_pip_install_command_shape_and_pins(home, monkeypatch):
    """§6.2 _pip_install: wheels-only into the site-packages dir; with
    pin_installed the constraints file pins every installed distribution
    except the target, and is removed afterwards."""
    from pathlib import Path
    from types import SimpleNamespace

    from autowright import packages

    _fake_dist(home, "requests", "2.31.0")
    _fake_dist(home, "PyYAML", "6.0.2")
    seen = {}

    def fake_run(cmd, capture_output=None, text=None, timeout=None):
        seen["cmd"] = cmd
        seen["timeout"] = timeout
        i = cmd.index("-c")
        seen["constraints_path"] = cmd[i + 1]
        # read while it still exists — it is deleted right after the run
        seen["constraints"] = Path(cmd[i + 1]).read_text()
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(packages.subprocess, "run", fake_run)
    assert packages._pip_install("requests", pin_installed=True) is None
    cmd = seen["cmd"]
    assert cmd[-1] == "requests"
    assert cmd[cmd.index("--only-binary") + 1] == ":all:"
    assert cmd[cmd.index("--target") + 1] == str(packages.site_packages_dir())
    assert seen["timeout"] == packages.INSTALL_TIMEOUT
    # pins: every installed dist (PEP 503-normalized) except the target
    assert set(seen["constraints"].splitlines()) == {"pyyaml==6.0.2"}
    assert not Path(seen["constraints_path"]).exists()  # tmp file cleaned up


def test_pip_install_timeout_and_stderr_tail(home, monkeypatch):
    import subprocess as sp
    from types import SimpleNamespace

    from autowright import packages

    def timed_out(cmd, capture_output=None, text=None, timeout=None):
        raise sp.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(packages.subprocess, "run", timed_out)
    assert packages._pip_install("leftpad") == \
        f"pip timed out after {packages.INSTALL_TIMEOUT} s"

    def failed(cmd, capture_output=None, text=None, timeout=None):
        return SimpleNamespace(returncode=1, stdout="",
                               stderr="ERROR: one\n  two  \nthree\nfour\n")

    monkeypatch.setattr(packages.subprocess, "run", failed)
    # message = last 3 stderr lines, stripped, joined with " · "
    assert packages._pip_install("leftpad") == "two · three · four"


def test_ensure_invalid_cancelled_and_missing_only(home, monkeypatch):
    """§6.2 ensure: invalid names and a should_stop cancel fail without pip;
    pip runs (pinned) only for missing entries and fills the real version."""
    from autowright import packages

    calls = []

    def fake_pip(name, pin_installed=False):
        calls.append((name, pin_installed))
        _fake_dist(home, name, "1.0.0")  # what a successful install leaves behind
        return None

    monkeypatch.setattr(packages, "_pip_install", fake_pip)

    out = packages.ensure([{"pip": "bad name!", "import": "x"}])
    assert out == [{"pip": "bad name!", "import": "x", "status": "failed",
                    "error": "not a bare distribution name"}]
    assert calls == []

    out = packages.ensure([{"pip": "leftpad", "import": "leftpad"}],
                          should_stop=lambda: True)
    assert out == [{"pip": "leftpad", "import": "leftpad", "status": "failed",
                    "error": "cancelled"}]
    assert calls == []

    _fake_dist(home, "requests", "2.31.0")
    out = packages.ensure([{"pip": "requests", "import": "requests"},
                           {"pip": "leftpad", "import": "leftpad"}])
    assert calls == [("leftpad", True)]  # installed entry untouched, pins on
    assert out == [
        {"pip": "requests", "import": "requests", "status": "installed", "version": "2.31.0"},
        {"pip": "leftpad", "import": "leftpad", "status": "installed", "version": "1.0.0"},
    ]


def test_ensure_fast_path_never_spawns_pip(home, monkeypatch):
    from autowright import packages

    def no_pip(*a, **kw):
        raise AssertionError("ensure must not run pip when everything is installed")

    monkeypatch.setattr(packages.subprocess, "run", no_pip)
    _fake_dist(home, "requests", "2.31.0")
    _fake_dist(home, "pyyaml", "6.0.2")
    out = packages.ensure([{"pip": "requests", "import": "requests"},
                           {"pip": "pyyaml", "import": "yaml"}])
    assert out == [
        {"pip": "requests", "import": "requests", "status": "installed", "version": "2.31.0"},
        {"pip": "pyyaml", "import": "yaml", "status": "installed", "version": "6.0.2"},
    ]
