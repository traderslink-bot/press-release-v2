@echo off
setlocal
set "APP_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"

if not exist "%APP_DIR%" (
  echo Could not find %APP_DIR%
  pause
  exit /b 1
)

explorer "%APP_DIR%"

