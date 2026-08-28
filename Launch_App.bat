@echo off
setlocal

set "APP_EXE=%~dp0release-app\win-unpacked\Pumpfun Sniper Bot.exe"

if exist "%APP_EXE%" (
    start "" "%APP_EXE%"
) else (
    echo [ERROR] Could not find "%APP_EXE%".
    echo Running electron development version instead...
    npm run electron
)
