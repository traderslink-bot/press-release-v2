param(
  [string]$Root = "C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2",
  [string]$NotBeforeIso = ""
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

if ($NotBeforeIso) {
  $notBefore = [datetime]$NotBeforeIso
  if ((Get-Date) -lt $notBefore) {
    Write-ScheduleLog "Skipping Stocktwits live worker start before NotBeforeIso=$NotBeforeIso."
    exit 0
  }
}

$now = Get-Date
$allowedDays = @(
  [DayOfWeek]::Monday,
  [DayOfWeek]::Tuesday,
  [DayOfWeek]::Wednesday,
  [DayOfWeek]::Thursday,
  [DayOfWeek]::Friday
)
$windowStart = $now.Date.AddHours(4)
$windowEnd = $now.Date.AddHours(20)

if (($allowedDays -notcontains $now.DayOfWeek) -or $now -lt $windowStart -or $now -ge $windowEnd) {
  Write-ScheduleLog "Skipping Stocktwits live worker start outside weekday 04:00-20:00 window."
  exit 0
}

$existing = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      ($_.Name -in @("node.exe", "cmd.exe", "npm.cmd")) -and
      (
        $_.CommandLine -match "stocktwits[\\/]+live-worker\.js" -or
        $_.CommandLine -match "stocktwits:live-worker"
      )
    }
)

if ($existing.Count -gt 0) {
  $ids = ($existing | Select-Object -ExpandProperty ProcessId | Sort-Object -Unique) -join ", "
  Write-ScheduleLog "Stocktwits live worker is already running. PID(s): $ids."
  exit 0
}

$logDir = Join-Path $Root "stocktwits\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "live-worker.out.log"
$errLog = Join-Path $logDir "live-worker.err.log"

$process = Start-Process `
  -FilePath "npm.cmd" `
  -ArgumentList @("run", "stocktwits:live-worker") `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -WindowStyle Hidden `
  -PassThru

Write-ScheduleLog "Started Stocktwits live worker launcher PID $($process.Id)."

Start-Sleep -Seconds 5

try {
  Push-Location $Root
  $status = & node "stocktwits\worker-status.js" 2>&1
  foreach ($line in $status) {
    Write-ScheduleLog "worker-status: $line"
  }
} finally {
  Pop-Location
}
