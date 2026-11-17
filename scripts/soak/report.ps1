# Builds a morning report for the soak: client CSV summary + best-effort server RSS.
#   powershell -ExecutionPolicy Bypass -File scripts\soak\report.ps1
# Writes report.txt next to client.csv.
param(
  [string]$Dir = (Join-Path $env:USERPROFILE '.p2pgate-soak-mux'),
  [string]$SshHost = 'watthumpra@100.76.100.90',
  [int]$SshPort = 8022,
  [string]$SshKey = (Join-Path $env:USERPROFILE '.ssh\id_ed25519'),
  [string]$RemoteDir = '~/.p2pgate-soak'
)

$ErrorActionPreference = 'Continue'

$csv = Join-Path $Dir 'client.csv'
$out = Join-Path $Dir 'report.txt'
$summarize = Join-Path $PSScriptRoot 'summarize.js'
$lines = @()

$lines += "p2pgate mux soak report"
$lines += "generated: $(Get-Date -Format o)"
$lines += ''

if (Test-Path $csv) {
  $lines += '--- client ---'
  $lines += (& node $summarize $csv 2>&1 | Out-String).Trim()
} else {
  $lines += "client.csv not found: $csv"
}

$lines += ''
$lines += '--- runner / watchdog ---'
foreach ($name in @('runner.log', 'watchdog.log')) {
  $path = Join-Path $Dir $name
  if (Test-Path $path) {
    $lines += "[$name]"
    $lines += (Get-Content $path -Tail 12 | Out-String).Trim()
  } else {
    $lines += "[$name] not present"
  }
}

$lines += ''
$lines += '--- server ---'
$serverRss = Join-Path $Dir 'server-rss.csv'
$sshArgs = @(
  '-p', "$SshPort",
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=no',
  '-o', "UserKnownHostsFile=$env:TEMP\p2pgate_known_hosts",
  '-i', $SshKey,
  $SshHost
)

try {
  $remote = & ssh @sshArgs "cat $RemoteDir/server-rss.csv" 2>&1
  if ($LASTEXITCODE -eq 0 -and $remote) {
    $remote | Set-Content $serverRss
    $lines += (& node $summarize $serverRss 2>&1 | Out-String).Trim()
    $lines += ''
    $lines += '[server log: reject/error/close]'
    $lines += (& ssh @sshArgs "grep -E 'MUX REJECT|stream error|MUX SESSION closed' $RemoteDir/server.log | tail -n 8" 2>&1 | Out-String).Trim()
  } else {
    $lines += "server unreachable or no rss csv ($remote)"
  }
} catch {
  $lines += "server fetch failed: $($_.Exception.Message)"
}

$lines | Set-Content $out
$lines | ForEach-Object { Write-Output $_ }
