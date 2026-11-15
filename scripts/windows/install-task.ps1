<#
.SYNOPSIS
Install p2pgate as a Windows Scheduled Task.

.DESCRIPTION
Runs `p2pgate server` (default) or `p2pgate client` at logon, or at startup when
-AtStartup is used. Log output is appended to -LogPath.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1 -Mode client -TaskName p2pgate-client

.EXAMPLE
# Runs at boot as SYSTEM; use absolute paths inside the config file.
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1 -AtStartup

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [ValidateSet('server', 'client')]
  [string]$Mode = 'server',

  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.p2pgate\config.json'),

  [string]$LogPath = (Join-Path $env:USERPROFILE '.p2pgate\service.log'),

  [string]$TaskName = 'p2pgate',

  [switch]$AtStartup,

  [string]$User,

  [string]$Password,

  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    Write-Host "Task '$TaskName' is not installed."
    return
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Task '$TaskName' removed."
  return
}

$command = Get-Command p2pgate -ErrorAction SilentlyContinue
if ($null -eq $command) {
  throw "p2pgate was not found in PATH. Install it first: npm install -g p2pgate"
}

if (-not (Test-Path $ConfigPath)) {
  throw "Config not found: $ConfigPath`nRun 'p2pgate setup' or 'p2pgate server' once to create it."
}

$logDir = Split-Path -Parent $LogPath
if ($logDir -and -not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Force $logDir | Out-Null
}

# Scheduled tasks cannot execute a .cmd shim directly, so wrap with cmd.exe.
$exe = 'cmd.exe'
$arguments = '/c ""{0}" {1} --config "{2}" >> "{3}" 2>&1"' -f $command.Source, $Mode, $ConfigPath, $LogPath

$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments

if ($AtStartup) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $userId = if ($User) { $User } else { 'SYSTEM' }

  if ($userId -eq 'SYSTEM') {
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  } elseif ($Password) {
    $secure = ConvertTo-SecureString $Password -AsPlainText -Force
    $credential = New-Object System.Management.Automation.PSCredential($userId, $secure)
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Password -RunLevel Highest
  } else {
    throw "Run with -User <name> -Password <pass> when -AtStartup is used with a normal account."
  }
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Host "Task '$TaskName' installed."
Write-Host "  Command : $($command.Source) $Mode --config $ConfigPath"
Write-Host "  Log     : $LogPath"
Write-Host "  Start   : $(if ($AtStartup) { 'at boot' } else { 'at logon' })"
Write-Host ""
Write-Host "Start now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Status   :  Get-ScheduledTaskInfo -TaskName $TaskName"
Write-Host "Remove   :  powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-task.ps1 -Uninstall"
