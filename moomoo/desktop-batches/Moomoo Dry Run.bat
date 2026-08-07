@echo off
setlocal
set "APP_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2"

cd /d "%APP_DIR%" || (
  echo Could not open %APP_DIR%
  pause
  exit /b 1
)

echo Running moomoo dry-run.
echo This prepares the next due post but does NOT click final submit.
echo.
npm run moomoo:dry-run
echo.
pause

