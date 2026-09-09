@echo off
setlocal
set "APP_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"

cd /d "%APP_DIR%" || (
  echo Could not open %APP_DIR%
  pause
  exit /b 1
)

echo Opening moomoo login/session Chrome profile.
echo Complete login or security checks manually if moomoo asks.
echo Close this Chrome window before running dry-run or starting the worker.
echo.
npm run moomoo:login-chrome
echo.
pause
