@echo off
setlocal

:: Request Administrator Privileges cleanly with zero nested-quote syntax errors
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ========================================================
    echo  Requesting Administrator Privileges...
    echo ========================================================
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Set working directory
cd /d "%~dp0"

:: Search for the optimizer engine
if exist "%~dp0run_optimizer.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_optimizer.ps1"
) else if exist "C:\Users\Rever\.gemini\antigravity\brain\145c09d5-00f7-47be-8cce-1ee5de6c72fe\run_optimizer.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Rever\.gemini\antigravity\brain\145c09d5-00f7-47be-8cce-1ee5de6c72fe\run_optimizer.ps1"
) else if exist "c:\Users\Rever\Documents\New folder\run_optimizer.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "c:\Users\Rever\Documents\New folder\run_optimizer.ps1"
) else (
    echo [ERROR] run_optimizer.ps1 was not found.
)

echo.
echo ========================================================
echo  All optimizations complete. Press any key to exit...
echo ========================================================
pause >nul
