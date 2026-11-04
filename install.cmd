@echo off
rem The Windows installer: finds a Node 24, then everything else happens in scripts/install-windows.ts.
rem Only ASCII in here, because cmd reads a batch file in the console's code page; the TypeScript prints the Chinese.
setlocal
set "NODE="

rem In turn: one given by hand, one an earlier install left for this user, then whatever PATH brings.
if defined AGENT_AUTOLOOP_NODE call :pick "%AGENT_AUTOLOOP_NODE%"
if not defined NODE for /d %%D in ("%LOCALAPPDATA%\agent-autoloop\node-v*") do if not defined NODE call :pick "%%~fD\node.exe"
if not defined NODE call :pick node
if defined NODE goto run

echo Node.js 24 or newer is required; no usable one was found. To add one for this user only,
echo leaving any system Node as it is, paste these lines, then run this installer again:
echo.
echo   mkdir "%LOCALAPPDATA%\agent-autoloop" 2^>nul
echo   curl -L -o "%LOCALAPPDATA%\agent-autoloop\node.zip" https://nodejs.org/dist/v24.22.2/node-v24.22.2-win-x64.zip
echo   tar -xf "%LOCALAPPDATA%\agent-autoloop\node.zip" -C "%LOCALAPPDATA%\agent-autoloop"
exit /b 1

:run
"%NODE%" --disable-warning=ExperimentalWarning "%~dp0scripts\install-windows.ts" %*
exit /b %errorlevel%

:pick
rem `call`, because a Node that's a batch shim would take the control and never give it back.
call "%~1" -p "process.versions.node" > "%TEMP%\agent-autoloop-node-version" 2>nul
if exist "%TEMP%\agent-autoloop-node-version" for /f "usebackq tokens=1 delims=." %%A in ("%TEMP%\agent-autoloop-node-version") do if %%A GEQ 24 set "NODE=%~1"
del "%TEMP%\agent-autoloop-node-version" >nul 2>nul
goto :eof
