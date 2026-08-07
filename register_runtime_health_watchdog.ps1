param(
  [string]$TaskName = "TraderLink Press Release V2 Health Watchdog",
  [int]$IntervalMinutes = 2
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdogPath = Join-Path $projectRoot "runtime_health_watchdog.js"
$launcherPath = Join-Path $projectRoot "runtime_health_watchdog_hidden.vbs"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"

if (-not (Test-Path -LiteralPath $watchdogPath)) {
  throw "Watchdog script not found: $watchdogPath"
}
if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw "Hidden watchdog launcher not found: $launcherPath"
}
if (-not (Test-Path -LiteralPath $wscriptPath)) {
  throw "Windows Script Host not found: $wscriptPath"
}

$action = New-ScheduledTaskAction `
  -Execute $wscriptPath `
  -Argument ('"{0}" "{1}" "{2}" "{3}"' -f $launcherPath, $nodePath, $watchdogPath, $projectRoot) `
  -WorkingDirectory $projectRoot

$scheduleStart = [datetime]::Today.AddHours(3).AddMinutes(55)
$trigger = New-ScheduledTaskTrigger `
  -Weekly `
  -WeeksInterval 1 `
  -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
  -At $scheduleStart
$repetition = New-ScheduledTaskTrigger `
  -Once `
  -At $scheduleStart `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Hours 16 -Minutes 5)
$trigger.Repetition = $repetition.Repetition

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -MultipleInstances IgnoreNew `
  -Priority 4

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
  -Description "Hidden weekday health check for the shared Playwright runner and Discord channel watchers, 3:55 AM to 8:00 PM Eastern." `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $task.TaskName
  State = $task.State
  NextRunTime = $info.NextRunTime
  IntervalMinutes = $IntervalMinutes
  Schedule = "Monday-Friday, 3:55 AM-8:00 PM Eastern"
  Executable = $wscriptPath
  HiddenLauncher = $launcherPath
  Watchdog = $watchdogPath
}
