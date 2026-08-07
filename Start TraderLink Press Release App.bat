@echo off
setlocal
set "PROJECT_ROOT=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"
set "LEVELS_ROOT=C:\Users\jerac\Documents\TraderLink\playwright\levels"

echo Stopping any existing TraderLink press-release runner...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$project=$env:PROJECT_ROOT; $levels=$env:LEVELS_ROOT; foreach ($process in (Get-CimInstance Win32_Process)) { if ($process.Name -eq 'node.exe' -and $process.CommandLine -and (($process.CommandLine -like '*press_release_levels_v2.js*') -or ($process.CommandLine -like '*runtime_controller.js*' -and $process.CommandLine -like '*press_release_levels_v2*') -or ($process.CommandLine -like '*run_both_levels_bots.js*' -and $process.CommandLine -like '*playwright\\levels*'))) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue } }; Remove-Item -LiteralPath (Join-Path $levels 'pr_v2_manual_stop_until_next_schedule.flag') -Force -ErrorAction SilentlyContinue"

timeout /t 3 /nobreak >nul
echo Starting the TraderLink press-release controller...
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node.exe' -ArgumentList '%PROJECT_ROOT%\runtime_controller.js' -WorkingDirectory '%PROJECT_ROOT%' -WindowStyle Hidden"
echo.
echo Launch requested. The controller starts the single shared Playwright/Discord runner during its weekday market-hours window.
timeout /t 3 /nobreak >nul
endlocal
