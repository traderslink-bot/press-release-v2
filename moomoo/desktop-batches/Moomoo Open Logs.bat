@echo off
setlocal
set "LOG_DIR=C:\Users\jerac\Documents\TraderLink\playwright\projects\press_release_levels_v2\moomoo\logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
explorer "%LOG_DIR%"

