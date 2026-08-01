@echo off
rem Desktop launcher: build on first run, start the server, open the browser.
rem Clicking it twice does not start a second server -- `serve --open` probes
rem /api/health first and just re-opens the tab.
setlocal
cd /d "%~dp0"

if not exist "dist\cli.js" (
  echo First run - building OSource-Manager...
  call pnpm install || goto :err
  call pnpm build || goto :err
)

node "dist\cli.js" serve --open
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo OSource-Manager failed to start.
echo Press any key to close this window.
pause >nul
exit /b 1
