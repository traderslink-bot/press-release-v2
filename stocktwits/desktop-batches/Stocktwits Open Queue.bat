@echo off
setlocal
set "QUEUE_FILE=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2\stocktwits\posts.json"

if not exist "%QUEUE_FILE%" (
  echo Could not find %QUEUE_FILE%
  pause
  exit /b 1
)

notepad "%QUEUE_FILE%"

