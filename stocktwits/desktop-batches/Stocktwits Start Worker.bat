@echo off
setlocal
set "APP_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"

cd /d "%APP_DIR%" || (
  echo Could not open %APP_DIR%
  pause
  exit /b 1
)

echo Starting Stocktwits live worker in the background.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = '%APP_DIR%'; $existing = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'stocktwits[\\/]+live-worker\.js' }; if ($existing) { Write-Host 'Stocktwits live worker is already running.'; exit 0 }; $logDir = Join-Path $root 'stocktwits\logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null; $out = Join-Path $logDir 'live-worker.out.log'; $err = Join-Path $logDir 'live-worker.err.log'; $p = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','stocktwits:live-worker') -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru; Write-Host ('Started Stocktwits live worker launcher PID ' + $p.Id); Start-Sleep -Seconds 3"
echo.
npm run stocktwits:worker-status
echo.
pause

