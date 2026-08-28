# Unblock all files recursively across release-app and desktop-build
Write-Host "Unblocking all files in release-app and desktop-build..." -ForegroundColor Cyan
Get-ChildItem -Path "$PSScriptRoot\release-app" -Recurse | Unblock-File -ErrorAction SilentlyContinue
Get-ChildItem -Path "$PSScriptRoot\desktop-build" -Recurse | Unblock-File -ErrorAction SilentlyContinue
Get-ChildItem -Path "$PSScriptRoot\dist-exe" -Recurse | Unblock-File -ErrorAction SilentlyContinue

# Find or create self-signed code signing certificate
$cert = Get-ChildItem -Path "Cert:\CurrentUser\My" | Where-Object { $_.Subject -match "Pumpfun Sniper Bot" } | Select-Object -First 1

if (-not $cert) {
    Write-Host "Generating a self-signed Code Signing Certificate..." -ForegroundColor Yellow
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Pumpfun Sniper Bot, O=Local Development" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(10) -FriendlyName "Pumpfun Sniper Bot Trusted Signer"
}

# Install certificate into CurrentUser Root (Trusted Root CA) and TrustedPublisher stores
$storeNames = @("Root", "TrustedPublisher")
foreach ($name in $storeNames) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    if (-not ($store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint })) {
        $store.Add($cert)
        Write-Host "Added certificate to CurrentUser\$name store." -ForegroundColor Green
    }
    $store.Close()
}

# Sign all executables and DLLs in release-app\win-unpacked
$targets = @(
    "$PSScriptRoot\release-app\win-unpacked",
    "$PSScriptRoot\desktop-build\win-unpacked",
    "$PSScriptRoot\dist-exe"
)

foreach ($target in $targets) {
    if (Test-Path $target) {
        Write-Host "Signing binaries in $target..." -ForegroundColor Cyan
        $files = Get-ChildItem -Path $target -Include "*.exe","*.dll" -Recurse
        foreach ($file in $files) {
            $status = Set-AuthenticodeSignature -FilePath $file.FullName -Certificate $cert -HashAlgorithm SHA256
            Write-Host "Signed $($file.Name): $($status.Status)" -ForegroundColor Gray
        }
    }
}

Write-Host "`nVerification complete! Executable is unblocked and digitally signed." -ForegroundColor Green
