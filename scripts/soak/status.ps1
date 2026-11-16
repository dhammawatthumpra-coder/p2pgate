# Quick health check for the overnight soak (run any time).
#   powershell -ExecutionPolicy Bypass -File scripts\soak\status.ps1
param(
  [string]$Csv = (Join-Path $env:USERPROFILE '.p2pgate-soak-mux\client.csv'),
  [string]$Log = (Join-Path $env:USERPROFILE '.p2pgate-soak-mux\client.out'),
  [int]$IntervalMinutes = 3
)

if (-not (Test-Path $Csv)) {
  Write-Output "no csv yet: $Csv"
  exit 1
}

$rows = Get-Content $Csv | Select-Object -Skip 1 | Where-Object { $_ -match ',' }
if ($rows.Count -eq 0) {
  Write-Output 'csv has no iterations yet'
  exit 1
}

$last = $rows[-1].Split(',')
$lastTime = [datetimeoffset]::Parse($last[0])
$ageMinutes = [math]::Round(((Get-Date) - $lastTime.LocalDateTime).TotalMinutes, 1)
$okCount = ($rows | Where-Object { $_.Split(',')[1] -eq 'true' }).Count

$client = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'cli\.js.*(18082|--mux)' }

Write-Output ("rows:        {0} (ok {1}, failed {2})" -f $rows.Count, $okCount, ($rows.Count - $okCount))
Write-Output ("last row:    {0} ago  ok={1} bytes={2} ms={3} rss={4}MB carriers={5}" -f
  "$ageMinutes min", $last[1], $last[2], $last[3], $last[6], $last[7])
Write-Output ("client:      {0}" -f ($(if ($client) { "running (pid $($client.ProcessId -join ', '))" } else { 'NOT RUNNING' })))

if ((Test-Path $Log)) {
  $mux = (Get-Content $Log | Select-String -Pattern 'MUX carrier established').Count
  $lastMux = (Get-Content $Log | Select-String -Pattern 'MUX carrier established|MUX unavailable' | Select-Object -Last 1)
  Write-Output ("carriers:    {0} established in log" -f $mux)
  if ($lastMux) { Write-Output ("last mux:    {0}" -f $lastMux.Line.Trim()) }
}

$limit = $IntervalMinutes + 2
if ($ageMinutes -gt $limit) {
  Write-Output ("WARNING: no new iteration for {0} min (expected every {1} min)" -f $ageMinutes, $IntervalMinutes)
} else {
  Write-Output 'status:      healthy'
}
