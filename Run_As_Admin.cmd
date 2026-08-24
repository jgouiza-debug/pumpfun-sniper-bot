@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Rever\.gemini\antigravity\brain\145c09d5-00f7-47be-8cce-1ee5de6c72fe\run_optimizer.ps1"
echo.
pause
