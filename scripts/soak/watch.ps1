# Watchdog: if the soak stopped producing rows and the scheduled task is not
# running, start it again and record why.
#
#   powershell -ExecutionPolicy Bypass -File scripts\soak\watch.ps1
#
# Registered as a Task Scheduler job that runs every 10 minutes.
param(
  [string]$Dir = (Join-Path $env:USERPROFILE '.p2pgate-soak-mux'),
  [string]$TaskName = 'p2pgate-soak',
  [int]$StaleMinutes = 20
)

$csv = Join-Path $Dir 'client.csv'
$log = Join-Path $Dir 'watchdog.log'

function Write-WatchLog([string]$message) {
  "$(Get-Date -Format o) $message" | Add-Content $log
}

$taskRunning = $false
try {
  $query = schtasks /query /tn $TaskName /fo csv /nh 2>$null
  $taskRunning = ($query -match 'Running|กำลังทำงาน')
} catch {
  $taskRunning = $false
}

if (-not (Test-Path $csv)) {
  if (-not $taskRunning) {
    Write-WatchLog 'no csv yet; starting the task'
    schtasks /run /tn $TaskName | Out-Null
  }
  exit 0
}

$age = ((Get-Date) - (Get-Item $csv).LastWriteTime).TotalMinutes

if ($age -le $StaleMinutes) {
  exit 0
}

if ($taskRunning) {
  Write-WatchLog ("STALE {0:n0} min but task still running; not restarting (stuck?)" -f $age)
  exit 0
}

Write-WatchLog ("DEAD last row {0:n0} min ago; restarting task {1}" -f $age, $TaskName)
schtasks /run /tn $TaskName | Out-Null
exit 0
