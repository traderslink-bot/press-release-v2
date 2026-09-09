@echo off
setlocal
set "APP_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"

cd /d "%APP_DIR%" || (
  echo Could not open %APP_DIR%
  pause
  exit /b 1
)

echo Stopping Stocktwits live worker only.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$matches = Get-CimInstance Win32_Process | Where-Object { ($_.Name -in @('node.exe','cmd.exe')) -and ($_.CommandLine -match 'stocktwits[\\/]+live-worker\.js' -or $_.CommandLine -match 'stocktwits:live-worker') }; if (-not $matches) { Write-Host 'No Stocktwits live worker process found.'; exit 0 }; $ids = $matches.ProcessId | Sort-Object -Unique; foreach ($id in $ids) { try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Host ('Stopped PID ' + $id) } catch { Write-Host ('Could not stop PID ' + $id + ': ' + $_.Exception.Message) } }; Remove-Item -LiteralPath (Join-Path '%APP_DIR%' 'stocktwits\live-worker.lock') -ErrorAction SilentlyContinue"
echo.
npm run stocktwits:worker-status
echo.
pause
