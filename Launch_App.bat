@echo off
setlocal

REM The installed app first (that is what most people have — the NSIS Setup
REM installs per-user by default), then a local electron-builder output, then a
REM source checkout. Only the first path existed before, so anyone who ran the
REM installer instead of building locally fell through to the dev branch.
set "APP_EXE=%LOCALAPPDATA%\Programs\Pumpfun Sniper Bot\Pumpfun Sniper Bot.exe"
if not exist "%APP_EXE%" set "APP_EXE=%PROGRAMFILES%\Pumpfun Sniper Bot\Pumpfun Sniper Bot.exe"
if not exist "%APP_EXE%" set "APP_EXE=%~dp0release-app\win-unpacked\Pumpfun Sniper Bot.exe"

if exist "%APP_EXE%" (
    start "" "%APP_EXE%"
) else (
    echo [INFO] No installed app found. Running the development version instead...
    echo        Install Pumpfun-Sniper-Bot-Setup-x.y.z.exe from the Releases page
    echo        for the real desktop app with automatic updates.
    npm run electron
)
