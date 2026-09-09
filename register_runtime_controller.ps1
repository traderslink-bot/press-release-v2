param(
  [string]$TaskName = "TraderLink Press Release V2 Daily Controller"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeManagerPath = Join-Path $projectRoot "manage-press-release-runtime.ps1"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path -LiteralPath $runtimeManagerPath)) {
  throw "Runtime manager not found: $runtimeManagerPath"
}
if (-not (Test-Path -LiteralPath $powershellPath)) {
  throw "Windows PowerShell not found: $powershellPath"
}

$action = New-ScheduledTaskAction `
  -Execute $powershellPath `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action ScheduledStart' -f $runtimeManagerPath) `
  -WorkingDirectory $projectRoot

$trigger = New-ScheduledTaskTrigger `
  -Weekly `
  -WeeksInterval 1 `
  -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
  -At ([datetime]::Today.AddHours(3).AddMinutes(55))

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 18) `
  -MultipleInstances IgnoreNew `
  -Priority 3

$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Restores the Press Release V2 controller and health watchdog weekdays at 3:55 AM Eastern." `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $task.TaskName
  State = $task.State
  NextRunTime = $info.NextRunTime
  Executable = $powershellPath
  RuntimeManager = $runtimeManagerPath
  Schedule = "Monday-Friday, 3:55 AM-8:00 PM Eastern"
}
