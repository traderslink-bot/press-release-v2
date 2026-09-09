@echo off
setlocal
set "APP_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"

cd /d "%APP_DIR%" || (
  echo Could not open %APP_DIR%
  pause
  exit /b 1
)

echo Checking whether the dedicated moomoo browser profile is still logged in.
echo This does not use the queue, compose a post, or submit anything.
echo.
npm run moomoo:session-check
echo.
pause
