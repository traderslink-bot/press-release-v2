param(
  [string]$TaskName = "TraderLink Press Release V2 Daily Controller"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$controllerPath = Join-Path $projectRoot "runtime_controller.js"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $controllerPath)) {
  throw "Runtime controller not found: $controllerPath"
}

$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument ('"{0}"' -f $controllerPath) `
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
  -Description "Runs the Press Release V2 and scanner controller weekdays from 3:55 AM to 8:00 PM Eastern." `
  -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
  TaskName = $task.TaskName
  State = $task.State
  NextRunTime = $info.NextRunTime
  Executable = $nodePath
  Controller = $controllerPath
  Schedule = "Monday-Friday, 3:55 AM-8:00 PM Eastern"
}
