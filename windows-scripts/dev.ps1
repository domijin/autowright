# scripts/dev.sh on Windows (§18): fastest way to launch Autowright from the repo,
# with hot reloading — deps only (no renderer bundle), then the real backend, a Vite
# dev server for the renderer (HMR — edits to app/src apply live), and Electron
# pointed at it via AUTOWRIGHT_RENDERER_URL (§15). Same real code everywhere: real
# data dir (%LOCALAPPDATA%\Autowright), Windows Credential Manager, random free
# port, backend as the real §3 Task Scheduler task (ai.autowright.backend: logon
# trigger + restart-on-failure, survives Electron quit), no mocks, no seed data.
# Backend edits still need a restart (the backend is not hot-reloaded).
# Ctrl+C shuts the whole app down (Electron, vite, and the backend);
# quitting Electron normally leaves the backend up, like release.
#
#   .\windows-scripts\dev.ps1    deps, restart the service, vite + Electron with HMR
#
# Isolated mode (opt-in): setting any AUTOWRIGHT_* knob makes dev.ps1 spawn the
# backend directly with that env instead of via Task Scheduler (the task starts
# with a fresh environment, like the launchd plist). Knobs (§15): AUTOWRIGHT_HOME
# (isolated data dir), AUTOWRIGHT_PORT, AUTOWRIGHT_OLLAMA_URL, AUTOWRIGHT_STEP_TIMEOUT.
#   -Fresh    wipe the data dir first — refused unless AUTOWRIGHT_HOME is set
param([switch]$Fresh)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ROOT = Split-Path -Parent $PSScriptRoot
$APP = Join-Path $ROOT 'app'
$VENV = Join-Path $ROOT '.venv\Scripts'
$VENV_PY = Join-Path $VENV 'python.exe'
$AUTOWRIGHT = Join-Path $VENV 'autowright.exe'

$local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
$RELEASE_HOME = Join-Path $local 'Autowright'
$DATA = if ($env:AUTOWRIGHT_HOME) { $env:AUTOWRIGHT_HOME } else { $RELEASE_HOME }
# §5 Windows logs root: <data root>\Logs, or <home>\logs when isolated
$LOGS = if ($env:AUTOWRIGHT_HOME) { Join-Path $DATA 'logs' } else { Join-Path $RELEASE_HOME 'Logs' }

# any AUTOWRIGHT_* env present → isolated mode (direct spawn so the env reaches the
# backend). AUTOWRIGHT_RENDERER_URL is excluded: this script sets it for Electron
# in this same process, and a run interrupted before its cleanup must not flip the
# next run to isolated mode.
$ISOLATED = [bool](Get-ChildItem Env: | Where-Object {
    $_.Name -like 'AUTOWRIGHT_*' -and $_.Name -ne 'AUTOWRIGHT_RENDERER_URL' })

# $done distinguishes deliberate exits (Fail, or Electron quitting on its own —
# backend stays up) from a Ctrl+C mid-run (backend torn down in the finally block).
$script:done = $false

function Fail([string]$message) {
    $script:done = $true
    Write-Host $message
    exit 1
}

# Run a native command and stop on a non-zero exit — PowerShell does not.
function Invoke-Native([string]$what, [scriptblock]$block) {
    & $block
    if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit $LASTEXITCODE)" }
}

# kill lingering processes matching every given command-line pattern (scoped to
# this repo by the path patterns). No TERM-then-KILL grace: Windows has no
# deliverable SIGTERM — the §2 contract treats every kill as the hard tree kill
# (taskkill /T /F), which also clears backends stuck in graceful shutdown.
function Stop-Stale([string[]]$Patterns) {
    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        $line = $_.CommandLine
        if (-not $line) { return $false }
        foreach ($p in $Patterns) { if ($line -notlike "*$p*") { return $false } }
        return $true
    })
    foreach ($proc in $procs) {
        Write-Host "· stopping lingering process (pid $($proc.ProcessId)): $($Patterns -join ' ')"
        # cmd /d /c so an already-gone pid errors silently (/d skips AutoRun hooks)
        cmd /d /c "taskkill /T /F /PID $($proc.ProcessId) >nul 2>&1"
    }
}

if ($Fresh) {
    if (-not $env:AUTOWRIGHT_HOME) {
        Write-Host "-Fresh would wipe the real app data ($RELEASE_HOME)."
        Write-Host "Set AUTOWRIGHT_HOME to an isolated dir to use -Fresh."
        exit 1
    }
    Write-Host "· wiping $DATA"
    if (Test-Path $DATA) { Remove-Item -Recurse -Force $DATA }
}
New-Item -ItemType Directory -Force -Path $DATA, $LOGS | Out-Null

# ---- deps only (venv + backend deps + npm deps — no renderer bundle) ----
# build.sh --deps inlined (build.sh is bash). Two deliberate omissions on Windows:
# no version sync (release.sh --sync is macOS-only; prod.ps1's gate protects
# distributables) and no acknowledgements regen (gen_licenses.py's list-form
# subprocess call cannot resolve npm.cmd on Windows; the checked-in file is
# refreshed by mac builds — the stance prod.ps1 also takes).
if (-not (Test-Path $VENV_PY)) {
    Write-Host '· creating venv'
    Invoke-Native 'venv creation' { py -3.14 -m venv (Join-Path $ROOT '.venv') }
}
$stamp = Join-Path $ROOT '.venv\.backend-stamp'
$pyproject = Join-Path $ROOT 'backend\pyproject.toml'
if (-not (Test-Path $stamp) -or
    (Get-Item $pyproject).LastWriteTime -gt (Get-Item $stamp).LastWriteTime) {
    Write-Host '· installing backend (pyproject.toml changed)'
    Invoke-Native 'pip install' { & (Join-Path $VENV 'pip.exe') -q install -e "$ROOT\backend[dev]" }
    # setuptools leaves a copy of the package tree in backend\build plus egg-info
    # metadata; nothing reads them, but a stale copy poisons every repo-wide search
    $debris = @(Join-Path $ROOT 'backend\build') +
        @(Get-ChildItem (Join-Path $ROOT 'backend') -Filter '*.egg-info' -Directory `
            -ErrorAction SilentlyContinue | ForEach-Object FullName)
    foreach ($d in $debris) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
    New-Item -ItemType File -Force -Path $stamp | Out-Null
}
$pkgLock = Join-Path $APP 'node_modules\.package-lock.json'
if (-not (Test-Path $pkgLock) -or
    (Get-Item (Join-Path $APP 'package.json')).LastWriteTime -gt (Get-Item $pkgLock).LastWriteTime) {
    # npm ci, not npm install: the lockfile is the source of truth
    Write-Host '· npm ci'
    Push-Location $APP
    try { Invoke-Native 'npm ci' { npm ci --no-audit --no-fund } } finally { Pop-Location }
}
Write-Host '· deps done (backend: .venv, app: node_modules)'

# ---- shut down lingering processes from previous sessions ----
$backendJson = Join-Path $DATA 'backend.json'
$BEFORE = ''
try { $BEFORE = Get-Content $backendJson -Raw -ErrorAction Stop } catch {}
cmd /d /c "`"$AUTOWRIGHT`" service uninstall >nul 2>&1"
Stop-Stale @('python', '-m autowright')            # backend (python/pythonw -m autowright.main)
Stop-Stale @("$ROOT\.venv\Scripts\autowright")     # autowright / autowright-backend entry points
Stop-Stale @("$ROOT\app\node_modules\electron")    # electron (incl. helper processes)
Stop-Stale @("$ROOT\app\node_modules\vite")        # vite dev server

# ---- backend ----
if ($ISOLATED) {
    # direct spawn, detached, Task-Scheduler-like environment: cwd System32 (the
    # scheduler's default) and the full user env — no launchd-PATH mimicry, §2:
    # Windows tasks are not env-stripped. main.py routes its own stdout/stderr to
    # backend.out/err.log on Windows (§3 route_logs); the redirects below catch
    # anything earlier than that (interpreter or import failures).
    Write-Host "· starting backend (isolated mode, data: $DATA)"
    Start-Process -FilePath $VENV_PY -ArgumentList '-m', 'autowright.main' `
        -WorkingDirectory (Join-Path $env:SystemRoot 'System32') -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LOGS 'backend.out.log') `
        -RedirectStandardError (Join-Path $LOGS 'backend.err.log')
} else {
    # the real thing: the §3 Task Scheduler task, exactly as a release install starts it
    Write-Host "· installing the scheduled task (data: $DATA)"
    Invoke-Native 'autowright service install' { & $AUTOWRIGHT service install }
}

try {
    # ---- vite dev server (starts while the backend comes up) ----
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $listener.Start()
    $VPORT = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    Write-Host "· starting vite dev server on :$VPORT (log: $LOGS\vite.log)"
    $viteJs = Join-Path $APP 'node_modules\vite\bin\vite.js'
    # node directly, not npx (a cmd child would replay any machine AutoRun hook);
    # the cmd /d /c wrapper exists only to merge both streams into one vite.log
    Start-Process -FilePath $env:ComSpec -WorkingDirectory $APP -WindowStyle Hidden -ArgumentList `
        "/d /c node `"$viteJs`" --host 127.0.0.1 --port $VPORT --strictPort > `"$LOGS\vite.log`" 2>&1"

    # wait for a fresh backend.json (rewritten with new pid/token on every start)
    $PORT = ''
    foreach ($i in 1..75) {
        $cur = ''
        try { $cur = Get-Content $backendJson -Raw -ErrorAction Stop } catch {}
        if ($cur -and $cur -ne $BEFORE) {
            $PORT = ''
            try { $PORT = ($cur | ConvertFrom-Json).port } catch {}
            if ($PORT) {
                try {
                    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$PORT/health" | Out-Null
                    break
                } catch { $PORT = '' }
            }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $PORT) { Fail "backend didn't come up — see $LOGS\backend.err.log" }
    Write-Host "· backend healthy on :$PORT (logs: $LOGS\backend.out.log / backend.err.log)"

    # wait for vite to answer
    $viteUp = $false
    foreach ($i in 1..75) {
        try {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$VPORT/" | Out-Null
            $viteUp = $true
            break
        } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $viteUp) { Fail "vite didn't come up — see $LOGS\vite.log" }

    # ---- electron (foreground; quitting it leaves the backend up, like release) ----
    Write-Host "· launching Electron (HMR via http://127.0.0.1:$VPORT)"
    $env:AUTOWRIGHT_RENDERER_URL = "http://127.0.0.1:$VPORT"
    Push-Location $APP
    try { & node (Join-Path $APP 'node_modules\electron\cli.js') . } finally { Pop-Location }

    # ---- relaunch supervision (§18) ----
    # A §4.9 reset relaunches Electron from inside the app (app.relaunch, §3
    # reset step 6). The relaunched process inherits AUTOWRIGHT_RENDERER_URL and
    # has no bundled Python, so tearing down now would leave it blank on a dead
    # vite URL with no backend. Watch briefly for a *fresh* repo Electron — the
    # creation-time filter keeps the exited session's lingering helpers from
    # ever reading as a relaunch — re-ensure the backend only if it is actually
    # down (a healthy backend is never restarted, §3), and keep vite alive until
    # Electron is really gone. Loops so a reset inside the relaunched app is
    # supervised the same way.
    while ($true) {
        $exitStamp = (Get-Date).AddSeconds(-5)
        $relaunched = @()
        foreach ($i in 1..3) {
            Start-Sleep -Seconds 2
            $relaunched = @(Get-CimInstance Win32_Process | Where-Object {
                $_.CommandLine -and $_.CommandLine -like "*$ROOT\app\node_modules\electron*" -and
                $_.CreationDate -and $_.CreationDate -gt $exitStamp })
            if ($relaunched.Count) { break }
        }
        if (-not $relaunched.Count) { break }
        $healthy = $false
        try {
            $bport = (Get-Content $backendJson -Raw -ErrorAction Stop | ConvertFrom-Json).port
            if ($bport) {
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$bport/health" | Out-Null
                $healthy = $true
            }
        } catch {}
        if (-not $healthy) {
            Write-Host '· Electron relaunched itself (reset) — re-ensuring the backend'
            if ($ISOLATED) {
                Start-Process -FilePath $VENV_PY -ArgumentList '-m', 'autowright.main' `
                    -WorkingDirectory (Join-Path $env:SystemRoot 'System32') -WindowStyle Hidden `
                    -RedirectStandardOutput (Join-Path $LOGS 'backend.out.log') `
                    -RedirectStandardError (Join-Path $LOGS 'backend.err.log')
            } else {
                cmd /d /c "`"$AUTOWRIGHT`" service install >nul 2>&1"
            }
        }
        foreach ($proc in $relaunched) {
            try { Wait-Process -Id $proc.ProcessId -ErrorAction Stop } catch {}
        }
    }
    $script:done = $true
} finally {
    # every exit clears vite and the renderer-URL knob (this process is the
    # caller's session — a leaked AUTOWRIGHT_* var would flip the next run to
    # isolated mode). Only a Ctrl+C mid-run also takes the backend down —
    # service uninstall first (restart-on-failure would otherwise respawn it),
    # then the same hard tree kill as the startup sweep. A normal Electron quit
    # and the Fail paths leave the backend running, like release.
    if (Test-Path Env:\AUTOWRIGHT_RENDERER_URL) { Remove-Item Env:\AUTOWRIGHT_RENDERER_URL }
    Stop-Stale @("$ROOT\app\node_modules\vite")
    if (-not $script:done) {
        Write-Host ''
        Write-Host '· ctrl-c — stopping the backend'
        cmd /d /c "`"$AUTOWRIGHT`" service uninstall >nul 2>&1"
        Stop-Stale @('python', '-m autowright')
        # A relaunched Electron (§4.9 reset) is not console-attached, so the
        # Ctrl+C never reached it — sweep it too, keeping the "Ctrl+C shuts the
        # whole app down" contract.
        Stop-Stale @("$ROOT\app\node_modules\electron")
    }
}
