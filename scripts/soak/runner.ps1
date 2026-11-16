# Runs the mux soak under Task Scheduler (outside the agent's process tree) and
# records start/end so an unexpected death leaves a trace.
#
#   powershell -ExecutionPolicy Bypass -File scripts\soak\runner.ps1 -Hours 4
#
# Reads %USERPROFILE%\.p2pgate-soak-mux\run.json:
#   { "secret": "...", "password": "...", "expectedSha": "...",
#     "expectedBytes": 4194304, "mb": 4, "port": 18082 }
param(
  [string]$Config = (Join-Path $env:USERPROFILE '.p2pgate-soak-mux\run.json'),
  [int]$Hours = 4,
  [int]$IntervalMinutes = 3
)

$ErrorActionPreference = 'Stop'

$root = Join-Path $env:USERPROFILE '.p2pgate-soak-mux'
New-Item -ItemType Directory -Force $root | Out-Null
$log = Join-Path $root 'runner.log'

function Write-RunnerLog([string]$message) {
  "$(Get-Date -Format o) pid=$PID $message" | Add-Content $log
}

if (-not (Test-Path $Config)) {
  Write-RunnerLog "START failed: config not found ($Config)"
  exit 2
}

$settings = Get-Content -Raw $Config | ConvertFrom-Json
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$started = Get-Date

Write-RunnerLog ("START hours={0} interval={1}m port={2} repo={3}" -f $Hours, $IntervalMinutes, $settings.port, $repo)

try {
  & (Join-Path $PSScriptRoot 'mux-windows.ps1') `
    -Secret $settings.secret `
    -Password $settings.password `
    -ExpectedSha $settings.expectedSha `
    -ExpectedBytes ([long]$settings.expectedBytes) `
    -MB ([int]$settings.mb) `
    -Port ([int]$settings.port) `
    -IntervalMinutes $IntervalMinutes `
    -Hours $Hours

  $code = if ($LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  Write-RunnerLog ("END exit={0} elapsed={1:n0}m" -f $code, ((Get-Date) - $started).TotalMinutes)
} catch {
  Write-RunnerLog ("CRASH {0}" -f ($_.Exception.Message -replace "`r?`n", ' | '))
  Write-RunnerLog ("CRASH at {0}" -f $_.ScriptStackTrace.Split("`n")[0])
  exit 1
}
