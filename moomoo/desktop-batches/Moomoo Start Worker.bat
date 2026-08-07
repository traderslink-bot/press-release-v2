@echo off
setlocal
set "APP_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"

cd /d "%APP_DIR%" || (
  echo Could not open %APP_DIR%
  pause
  exit /b 1
)

echo Starting moomoo live worker in the background.
echo Live posting remains blocked unless MOOMOO_LIVE_APPROVED=YES is set
echo or moomoo\LIVE_APPROVED.local exists after dry-run review.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = '%APP_DIR%'; $existing = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'moomoo[\\/]+live-worker\.js' }; if ($existing) { Write-Host 'moomoo live worker is already running.'; exit 0 }; $logDir = Join-Path $root 'moomoo\logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null; $out = Join-Path $logDir 'live-worker.out.log'; $err = Join-Path $logDir 'live-worker.err.log'; $p = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','moomoo:live-worker') -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru; Write-Host ('Started moomoo live worker launcher PID ' + $p.Id); Start-Sleep -Seconds 3"
echo.
npm run moomoo:worker-status
echo.
pause
