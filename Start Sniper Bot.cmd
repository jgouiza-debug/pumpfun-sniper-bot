@echo off
REM ---------------------------------------------------------------------------
REM Launches the bot through node.exe, which is Authenticode-signed by the
REM OpenJS Foundation and therefore allowed by Windows Smart App Control.
REM
REM The Electron build cannot run under SAC: Electron's own prebuilt
REM electron.exe ships UNSIGNED, so SAC blocks it no matter how our code is
REM built. Signing our installer alone would not fix that. This path executes
REM nothing unsigned - node.exe runs the engine, and the dashboard opens in
REM Edge/Chrome, which Microsoft/Google sign.
REM
REM State lives in the same per-user folder the desktop app uses, so both
REM entry points share one set of keys, wallets and positions.
REM ---------------------------------------------------------------------------
setlocal
set "SNIPER_DATA_DIR=%APPDATA%\pumpfun-token-screening-pipeline"
if not exist "%SNIPER_DATA_DIR%" mkdir "%SNIPER_DATA_DIR%"
cd /d "%~dp0"
title Pumpfun Sniper Bot
echo Starting Pumpfun Sniper Bot...
echo Data folder: %SNIPER_DATA_DIR%
echo.
node --use-system-ca "dist\server.js"
echo.
echo Bot stopped. Press any key to close.
pause >nul
