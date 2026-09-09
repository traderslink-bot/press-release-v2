[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("FullStop", "FullRestart", "ScheduledStart")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$levelsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) "levels"
$manualStopPath = Join-Path $levelsRoot "pr_v2_manual_stop_until_next_schedule.flag"
$controllerPath = Join-Path $projectRoot "runtime_controller.js"
$taskDefinitions = @(
  @{ TaskName = "TraderLink Press Release V2 Daily Controller"; TaskPath = "\" },
  @{ TaskName = "TraderLink Press Release V2 Health Watchdog"; TaskPath = "\" }
)

function Set-PressReleaseTaskState {
  param(
    [bool]$Enabled,
    [string[]]$TaskNames = $taskDefinitions.TaskName
  )

  foreach ($task in $taskDefinitions | Where-Object { $TaskNames -contains $_.TaskName }) {
    if ($Enabled) {
      Enable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null
    } else {
      Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null
    }
  }
}

function Get-PressReleaseProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
      return $false
    }

    $isController = $_.Name -eq "node.exe" -and
      $commandLine -like "*runtime_controller.js*" -and
      $commandLine -like "*press_release_levels_v2*"
    $isRunner = $_.Name -eq "node.exe" -and
      $commandLine -like "*run_both_levels_bots.js*" -and
      $commandLine -like "*playwright\\levels*"
    $isPressReleaseApp = $_.Name -eq "node.exe" -and
      $commandLine -like "*press_release_levels_v2.js*"
    $isWatchdog = $_.Name -in @("wscript.exe", "cscript.exe", "node.exe") -and
      ($commandLine -like "*runtime_health_watchdog*" -or $commandLine -like "*$projectRoot*")

    return $isController -or $isRunner -or $isPressReleaseApp -or $isWatchdog
  }
}

function Stop-PressReleaseProcesses {
  $processes = @(Get-PressReleaseProcesses)
  foreach ($process in $processes) {
    & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
  }
}

if (-not (Test-Path -LiteralPath $controllerPath)) {
  throw "Press-release controller not found: $controllerPath"
}

if ($Action -eq "FullStop") {
  # Preserve the weekday 3:55 AM controller task.  It is responsible for
  # restoring the normal runtime on the next trading day after a full stop.
  Set-PressReleaseTaskState -Enabled $true -TaskNames @("TraderLink Press Release V2 Daily Controller")
  Set-PressReleaseTaskState -Enabled $false -TaskNames @("TraderLink Press Release V2 Health Watchdog")
  $null = New-Item -ItemType File -Path $manualStopPath -Force
  Stop-PressReleaseProcesses
  Write-Output "TraderLink press-release automation is stopped for now. The weekday 3:55 AM controller remains enabled and will restore the controller and watchdog at the next scheduled start."
  exit 0
}

if ($Action -eq "ScheduledStart") {
  $watchdogTask = Get-ScheduledTask -TaskName "TraderLink Press Release V2 Health Watchdog" -TaskPath "\"
  $watchdogWasEnabled = $watchdogTask.Settings.Enabled
  Remove-Item -LiteralPath $manualStopPath -Force -ErrorAction SilentlyContinue
  Set-PressReleaseTaskState -Enabled $true
  Start-Process -FilePath "node.exe" -ArgumentList ('"{0}"' -f $controllerPath) -WorkingDirectory $projectRoot -WindowStyle Hidden
  if (-not $watchdogWasEnabled) {
    Start-ScheduledTask -TaskName "TraderLink Press Release V2 Health Watchdog" -TaskPath "\"
    Write-Output "TraderLink press-release scheduled start restored the controller and two-minute watchdog after a full stop."
  } else {
    Write-Output "TraderLink press-release scheduled start launched the normal controller; the already-enabled watchdog follows its own schedule."
  }
  exit 0
}

Stop-PressReleaseProcesses
Remove-Item -LiteralPath $manualStopPath -Force -ErrorAction SilentlyContinue
Set-PressReleaseTaskState -Enabled $true
Start-Process -FilePath "node.exe" -ArgumentList ('"{0}"' -f $controllerPath) -WorkingDirectory $projectRoot -WindowStyle Hidden
Start-ScheduledTask -TaskName "TraderLink Press Release V2 Health Watchdog" -TaskPath "\"
Write-Output "TraderLink press-release automation is restored. Its daily controller and two-minute watchdog are enabled, and the controller has been started."
