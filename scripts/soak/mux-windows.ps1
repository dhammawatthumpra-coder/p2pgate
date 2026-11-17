# Runs an unattended mux soak from Windows against a Termux soak server.
# Every interval it downloads the test file through the tunnel and verifies SHA-256.
#
#   # challenged (password mode server)
#   powershell -ExecutionPolicy Bypass -File scripts\soak\mux-windows.ps1 `
#     -Secret <masterSecret> -Password <password> -ExpectedSha <sha256> `
#     -ExpectedBytes 4194304 -MB 4
#
#   # trusted device (fast path, registry + key-only server)
#   powershell -ExecutionPolicy Bypass -File scripts\soak\mux-windows.ps1 -Mode trusted `
#     -Secret <masterSecret> -ExpectedSha <sha256> -ExpectedBytes 4194304 -MB 4
#
# Trusted mode needs a client key at %USERPROFILE%\.p2pgate-soak-mux\.p2pgate\client-key.json
# whose public key is in the soak server's allowedClientKeys.
param(
  [Parameter(Mandatory = $true)][string]$Secret,
  [string]$Password = '',
  [Parameter(Mandatory = $true)][string]$ExpectedSha,
  [Parameter(Mandatory = $true)][long]$ExpectedBytes,
  [int]$MB = 8,
  [int]$Port = 18082,
  [int]$TargetPort = 18081,
  [int]$IntervalMinutes = 3,
  [double]$Hours = 9,
  [ValidateSet('password', 'trusted')][string]$Mode = 'password'
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.p2pgate-soak-mux'
New-Item -ItemType Directory -Force $root | Out-Null

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $repo 'src/cli.js'))) {
  throw "run this from the p2pgate repo (src/cli.js not found under $repo)"
}

$oldHome = $env:HOME
$oldProfile = $env:USERPROFILE
$oldLang = $env:P2PGATE_LANG
$env:HOME = $root
$env:USERPROFILE = $root
$env:P2PGATE_LANG = 'en'

$out = Join-Path $root 'client.out'
$csv = Join-Path $root 'client.csv'
$clientArgs = @('src/cli.js')

if ($Mode -eq 'trusted') {
  $keyPath = Join-Path $root '.p2pgate\client-key.json'
  if (-not (Test-Path $keyPath)) {
    throw "trusted mode needs $keyPath (run keygen first and register its public key)"
  }

  $clientJson = Join-Path $root 'client.json'
  [ordered]@{
    mode              = 'client'
    masterSecret      = $Secret
    authMode          = 'registry'
    targetHost        = '127.0.0.1'
    targetPort        = $TargetPort
    localPort         = $Port
    clientKeyPath     = $keyPath
    allowedClientKeys = @()
    verificationMode  = 'key-only'
    trustedDevicesFile = (Join-Path $root 'trusted_devices')
    auditLog          = @{ enabled = $false }
    customBootstrap   = @()
    authPin           = @{ enabled = $false; unattended = $null }
    telegramAlert     = @{ enabled = $false; botToken = ''; chatId = '' }
  } | ConvertTo-Json -Depth 5 | Set-Content $clientJson

  $clientArgs += @('client', '--mux', '--port', "$Port", '--config', $clientJson)
} else {
  if ($Password -eq '') { throw 'password mode needs -Password' }
  $clientArgs += @(
    'connect', '-s', $Secret, '-p', $Password, '--mux', '--port', "$Port",
    '--config', (Join-Path $root 'client.json')
  )
}

$client = Start-Process node -ArgumentList $clientArgs -WorkingDirectory $repo `
  -RedirectStandardOutput $out -RedirectStandardError (Join-Path $root 'client.err') `
  -PassThru -WindowStyle Hidden

for ($i = 0; $i -lt 120; $i++) {
  if ((Test-Path $out) -and (Select-String -Path $out -Pattern 'LISTENING' -Quiet)) { break }
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $csv)) {
  'time,ok,bytes,ms,mbps,error,clientRssMB,carriers' | Set-Content $csv
}

$deadline = (Get-Date).AddHours($Hours)
$totalIterations = [math]::Max(1, [math]::Ceiling($Hours * 60 / $IntervalMinutes))
$iteration = 0
$failures = 0

try {
  while ((Get-Date) -lt $deadline) {
    $iteration++

    if ($client.HasExited) {
      "$(Get-Date -Format o),false,0,0,0,client-exited,,0" | Add-Content $csv
      $failures++
      break
    }

    $raw = node (Join-Path $PSScriptRoot 'fetch-verify.js') $Port $ExpectedSha $ExpectedBytes 180000 2>&1 | Select-Object -Last 1
    $result = $null
    try { $result = $raw | ConvertFrom-Json } catch { $result = $null }

    $ok = $result -and $result.ok
    if (-not $ok) { $failures++ }

    $client.Refresh()
    $rssMb = [math]::Round($client.WorkingSet64 / 1MB, 1)
    $carriers = (Get-Content $out | Select-String -Pattern 'MUX carrier established').Count
    $mbps = 0
    if ($ok -and $result.ms -gt 0) {
      $mbps = [math]::Round($MB / ($result.ms / 1000), 2)
    }
    $errorText = if ($result -and $result.error) { $result.error } else { '' }
    $bytes = if ($result) { $result.bytes } else { 0 }
    $ms = if ($result) { $result.ms } else { 0 }

    "$(Get-Date -Format o),$($ok.ToString().ToLower()),$bytes,$ms,$mbps,$errorText,$rssMb,$carriers" |
      Add-Content $csv

    Write-Output ("[{0}] {1}/{2} ok={3} {4} bytes {5} ms {6} MB/s rss={7}MB carriers={8}" -f
      (Get-Date -Format 'HH:mm:ss'), $iteration, $totalIterations,
      $ok, $bytes, $ms, $mbps, $rssMb, $carriers)

    Start-Sleep -Seconds ($IntervalMinutes * 60)
  }
} finally {
  if ($client -and -not $client.HasExited) { Stop-Process -Id $client.Id -Force -ErrorAction SilentlyContinue }
  $env:HOME = $oldHome
  $env:USERPROFILE = $oldProfile
  $env:P2PGATE_LANG = $oldLang
}

Write-Output ''
Write-Output "done: mode=$Mode iterations=$iteration failures=$failures"
Write-Output "csv: $csv"
node (Join-Path $PSScriptRoot 'summarize.js') $csv
