<#
.SYNOPSIS  Start flightlog-sdr (API + web app) on Windows. Ctrl+C stops both.
.EXAMPLE   .\start.ps1
.EXAMPLE   .\start.ps1 -Lan            # reachable from other devices on your network
.EXAMPLE   .\start.ps1 -Dev            # Next.js dev server instead of a production build
#>
param(
    [int]$ApiPort = 8000,
    [int]$WebPort = 3000,
    [switch]$Lan,       # listen on all interfaces (anyone on your network can view it)
    [switch]$Dev,       # use `next dev` (hot reload) instead of build + start
    [switch]$Rebuild    # force a fresh production build (needed after changing the API port)
)
$ErrorActionPreference = 'Stop'
$root    = $PSScriptRoot
$backend = Join-Path $root 'backend'
$front   = Join-Path $root 'frontend'
$venv    = Join-Path $backend '.venv-win'
$bind    = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }

function Need($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name was not found. $hint" }
}
Need node 'Install Node 20+ from https://nodejs.org'
Need npm  'Install Node 20+ from https://nodejs.org'
$py = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' }
      elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' }
      else { throw 'Python was not found. Install Python 3.11+ from https://www.python.org' }

# --- backend ------------------------------------------------------------------------------------------
$venvPy = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    Write-Host '> creating Python environment (first run)'
    & $py -m venv $venv
}
Write-Host '> checking Python packages'
& $venvPy -m pip install -q --disable-pip-version-check -r (Join-Path $backend 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

$envFile = Join-Path $backend '.env'
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $backend '.env.example') $envFile
    Write-Host "> created backend\.env: set RECEIVER_LAT / RECEIVER_LON in it, then restart"
}

# --- frontend -----------------------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $front 'node_modules'))) {
    Write-Host '> installing web app packages (first run)'
    Push-Location $front; npm install; Pop-Location
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}
if ($ApiPort -ne 8000) { $env:NEXT_PUBLIC_API_URL = "http://localhost:$ApiPort" }
$built = Test-Path (Join-Path $front '.next\BUILD_ID')
if (-not $Dev -and ($Rebuild -or -not $built)) {
    Write-Host '> building the web app (first run takes a minute or two)'
    Push-Location $front; npm run build; Pop-Location
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
}

# --- run ----------------------------------------------------------------------------------------------
$webCmd = if ($Dev) { "npm run dev -- -H $bind -p $WebPort" } else { "npm start -- -H $bind -p $WebPort" }
$api = $web = $null
try {
    $api = Start-Process $venvPy -WorkingDirectory $backend -NoNewWindow -PassThru `
        -ArgumentList "-m uvicorn app.main:app --host $bind --port $ApiPort"
    $web = Start-Process cmd.exe -WorkingDirectory $front -NoNewWindow -PassThru -ArgumentList "/c $webCmd"
    Write-Host ""
    Write-Host "flightlog-sdr is starting:  http://localhost:$WebPort   (API on port $ApiPort). Ctrl+C to stop."
    while (-not $api.HasExited -and -not $web.HasExited) { Start-Sleep -Seconds 1 }
    if ($api.HasExited) { Write-Host "The API stopped (exit code $($api.ExitCode))." }
    if ($web.HasExited) { Write-Host "The web app stopped (exit code $($web.ExitCode))." }
}
finally {
    foreach ($p in @($api, $web)) {
        if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>$null | Out-Null }
    }
}
