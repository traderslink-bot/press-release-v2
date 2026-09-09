param(
  [string]$Root = "C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"
)

$ErrorActionPreference = "Stop"

function Write-ScheduleLog {
  param([string]$Message)

  $logDir = Join-Path $Root "stocktwits\logs"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $line = "[{0}] {1}" -f (Get-Date).ToString("o"), $Message
  Add-Content -LiteralPath (Join-Path $logDir "scheduled-control.log") -Value $line
  Write-Host $line
}

if (-not (Test-Path -LiteralPath $Root)) {
  throw "Repo root does not exist: $Root"
}

$matches = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      ($_.Name -in @("node.exe", "cmd.exe", "npm.cmd")) -and
      (
        $_.CommandLine -match "stocktwits[\\/]+live-worker\.js" -or
        $_.CommandLine -match "stocktwits:live-worker"
      )
    }
)

if ($matches.Count -eq 0) {
  Write-ScheduleLog "No Stocktwits live worker process found."
} else {
  $ids = @($matches | Select-Object -ExpandProperty ProcessId | Sort-Object -Unique)
  foreach ($id in $ids) {
    try {
      Stop-Process -Id $id -Force -ErrorAction Stop
      Write-ScheduleLog "Stopped Stocktwits live worker PID $id."
    } catch {
      Write-ScheduleLog "Could not stop Stocktwits live worker PID ${id}: $($_.Exception.Message)"
    }
  }
}

$lockPath = Join-Path $Root "stocktwits\live-worker.lock"
Remove-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue
Write-ScheduleLog "Removed Stocktwits live worker lock if present."

try {
  Push-Location $Root
  $status = & node "stocktwits\worker-status.js" 2>&1
  foreach ($line in $status) {
    Write-ScheduleLog "worker-status: $line"
  }
} finally {
  Pop-Location
}
