@echo off
setlocal
set "PROJECT_ROOT=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"
set "LEVELS_ROOT=C:\Users\jerac\Documents\TraderLink\playwright\levels"

echo Stopping the TraderLink press-release runner...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$project=$env:PROJECT_ROOT; $levels=$env:LEVELS_ROOT; $null = New-Item -ItemType File -Path (Join-Path $levels 'pr_v2_manual_stop_until_next_schedule.flag') -Force; foreach ($process in (Get-CimInstance Win32_Process)) { if ($process.Name -eq 'node.exe' -and $process.CommandLine -and (($process.CommandLine -like '*press_release_levels_v2.js*') -or ($process.CommandLine -like '*runtime_controller.js*' -and $process.CommandLine -like '*press_release_levels_v2*') -or ($process.CommandLine -like '*run_both_levels_bots.js*' -and $process.CommandLine -like '*playwright\\levels*'))) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue } }"
echo.
echo The press-release app has been stopped. It will remain stopped until you use the Start launcher or the next scheduled workday.
timeout /t 3 /nobreak >nul
endlocal
