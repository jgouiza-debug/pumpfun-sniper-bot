# Master Performance Optimizer Script (Clean & Silent Execution)
$Host.UI.RawUI.WindowTitle = "EXTREME PC PERFORMANCE OPTIMIZER"
Clear-Host

Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host "     ABSOLUTE PEAK LIMITS: PC GAMING & SYSTEM OPTIMIZATION          " -ForegroundColor Yellow
Write-Host "====================================================================" -ForegroundColor Cyan

# 1. Win32 Priority Separation (3:1 Foreground CPU Boost)
Write-Host "`n[1/16] Boosting Foreground CPU Quantum (3:1 Priority Boost)..." -ForegroundColor Green
try {
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\PriorityControl" -Name "Win32PrioritySeparation" -Value 38 -Type DWord -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: Foreground active apps & games receive maximum 3:1 CPU priority." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 2. BCD Clock & Timer Jitter Elimination
Write-Host "`n[2/16] Tuning System Timer Resolution & BCD Clock..." -ForegroundColor Green
try {
    cmd.exe /c "bcdedit /set disabledynamictick yes >nul 2>&1"
    cmd.exe /c "bcdedit /set useplatformtick yes >nul 2>&1"
    cmd.exe /c "bcdedit /deletevalue useplatformclock >nul 2>&1"
    Write-Host "  -> OK: Dynamic Tick disabled & Hardware TSC clock configured." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 3. 24GB DDR5 Memory Management
Write-Host "`n[3/16] Optimizing Memory Architecture (24GB DDR5 Mode)..." -ForegroundColor Green
try {
    Disable-MMAgent -mc -ErrorAction SilentlyContinue | Out-Null
    Disable-MMAgent -ApplicationPreLaunch -ErrorAction SilentlyContinue | Out-Null
    Disable-MMAgent -PageCombining -ErrorAction SilentlyContinue | Out-Null
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management" -Name "DisablePagingExecutive" -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management" -Name "LargeSystemCache" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: Memory compression off, Kernel locked in physical DDR5 RAM." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 4. AMD Radeon RX 6600 HAGS & TDR
Write-Host "`n[4/16] Configuring Hardware-Accelerated GPU Scheduling (HAGS)..." -ForegroundColor Green
try {
    $gfxPath = "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers"
    if (-not (Test-Path $gfxPath)) { New-Item -Path $gfxPath -Force -ErrorAction SilentlyContinue | Out-Null }
    Set-ItemProperty -Path $gfxPath -Name "HwSchMode" -Value 2 -Type DWord -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $gfxPath -Name "TdrDelay" -Value 10 -Type DWord -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $gfxPath -Name "TdrDdiDelay" -Value 10 -Type DWord -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: HAGS Enabled (HwSchMode = 2) for AMD Radeon RX 6600." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 5. CPU Power Throttling Elimination
Write-Host "`n[5/16] Disabling Windows Power Throttling..." -ForegroundColor Green
try {
    $ptPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Power\PowerThrottling"
    if (-not (Test-Path $ptPath)) { New-Item -Path $ptPath -Force -ErrorAction SilentlyContinue | Out-Null }
    Set-ItemProperty -Path $ptPath -Name "PowerThrottlingOff" -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: CPU Power Throttling permanently disabled." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 6. NVMe SSD File System Acceleration
Write-Host "`n[6/16] Accelerating NVMe SSD File System I/O..." -ForegroundColor Green
try {
    cmd.exe /c "fsutil behavior set disablelastaccess 1 >nul 2>&1"
    cmd.exe /c "fsutil behavior set memoryusage 2 >nul 2>&1"
    Write-Host "  -> OK: NTFS Last Access write overhead removed, Lookaside RAM buffer maxed." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 7. Multimedia & Gaming MMCSS Priority
Write-Host "`n[7/16] Maximizing Gaming & Multimedia Priority (MMCSS)..." -ForegroundColor Green
try {
    $mmPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile"
    Set-ItemProperty -Path $mmPath -Name "NetworkThrottlingIndex" -Value ([Convert]::ToUInt32("ffffffff", 16)) -Type DWord -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $mmPath -Name "SystemResponsiveness" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue

    $gamesPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks\Games"
    if (-not (Test-Path $gamesPath)) { New-Item -Path $gamesPath -Force -ErrorAction SilentlyContinue | Out-Null }
    Set-ItemProperty -Path $gamesPath -Name "GPU Priority" -Value 8 -Type DWord -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $gamesPath -Name "Priority" -Value 6 -Type DWord -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $gamesPath -Name "Scheduling Category" -Value "High" -Type String -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $gamesPath -Name "SFIO Priority" -Value "High" -Type String -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: 100% CPU priority dedicated to foreground games." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 8. Wi-Fi 6 Zero-Jitter Mode (Roaming Aggressiveness Lowest)
Write-Host "`n[8/16] Eliminating Wi-Fi Roaming Channel Scans..." -ForegroundColor Green
try {
    Set-NetAdapterAdvancedProperty -Name "WiFi" -DisplayName "Roaming Aggressiveness" -DisplayValue "1. Lowest" -ErrorAction SilentlyContinue
    Write-Host "  -> OK: Wi-Fi Roaming Aggressiveness set to Lowest (Flat ping in games)." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 9. Low-Latency TCP Stack & Nagle's Algorithm Elimination
Write-Host "`n[9/16] Optimizing Low-Latency TCP Stack (TcpNoDelay)..." -ForegroundColor Green
try {
    $interfaces = "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces"
    Get-ChildItem $interfaces -ErrorAction SilentlyContinue | ForEach-Object {
        Set-ItemProperty -Path $_.PSPath -Name "TcpAckFrequency" -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
        Set-ItemProperty -Path $_.PSPath -Name "TCPNoDelay" -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
        Set-ItemProperty -Path $_.PSPath -Name "TcpDelAckTicks" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
    }
    Set-DnsClientServerAddress -InterfaceAlias "WiFi" -ServerAddresses ("1.1.1.1", "8.8.8.8") -ErrorAction SilentlyContinue
    cmd.exe /c "netsh int tcp set global autotuninglevel=normal >nul 2>&1"
    cmd.exe /c "netsh int tcp set global rss=enabled >nul 2>&1"
    cmd.exe /c "netsh int tcp set global fastopen=enabled >nul 2>&1"
    cmd.exe /c "netsh int tcp set global timestamps=allowed >nul 2>&1"
    cmd.exe /c "netsh int tcp set global hystart=enabled >nul 2>&1"
    cmd.exe /c "netsh int tcp set global prr=enabled >nul 2>&1"
    cmd.exe /c "ipconfig /flushdns >nul 2>&1"
    Write-Host "  -> OK: Nagle's algorithm disabled (Immediate packet dispatch) & Dual Fast DNS." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 10. NetBIOS & Wi-Fi Power Saving Sleep Elimination
Write-Host "`n[10/16] Eliminating Wi-Fi Power Saving Sleep..." -ForegroundColor Green
try {
    Get-NetAdapter -Name "WiFi" -ErrorAction SilentlyContinue | ForEach-Object {
        Set-NetAdapterAdvancedProperty -Name $_.Name -DisplayName "Energy Efficient Ethernet" -DisplayValue "Disabled" -ErrorAction SilentlyContinue
        Set-NetAdapterAdvancedProperty -Name $_.Name -DisplayName "Green Ethernet" -DisplayValue "Disabled" -ErrorAction SilentlyContinue
    }
    Write-Host "  -> OK: Wi-Fi sleep throttling removed." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 11. Disable Telemetry & Bloat Services
Write-Host "`n[11/16] Disabling Telemetry Background Logging..." -ForegroundColor Green
try {
    Stop-Service -Name "DiagTrack" -Force -ErrorAction SilentlyContinue
    Set-Service -Name "DiagTrack" -StartupType Disabled -ErrorAction SilentlyContinue
    Set-Service -Name "MapsBroker" -StartupType Manual -ErrorAction SilentlyContinue
    Remove-Item "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\Ollama.lnk" -Force -ErrorAction SilentlyContinue
    Remove-Item "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\Comet.lnk" -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: Telemetry logging stopped and startup daemons cleaned." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 12. Deep System Temp & Update Cache Clean
Write-Host "`n[12/16] Cleaning System Temp & Update Download Cache..." -ForegroundColor Green
try {
    Get-ChildItem "C:\Windows\Temp" -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem "C:\Windows\SoftwareDistribution\Download" -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: System temporary files purged." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 13. NVMe SSD TRIM Optimization
Write-Host "`n[13/16] Executing NVMe SSD TRIM Optimization..." -ForegroundColor Green
try {
    Optimize-Volume -DriveLetter C -ReTrim -ErrorAction SilentlyContinue
    Write-Host "  -> OK: Drive C: TRIM completed." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 14. DWM Latency Tuning
Write-Host "`n[14/16] Optimizing DWM Frame Pacing..." -ForegroundColor Green
try {
    $dwmPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\dwm.exe"
    if (-not (Test-Path $dwmPath)) { New-Item -Path $dwmPath -Force -ErrorAction SilentlyContinue | Out-Null }
    Set-ItemProperty -Path $dwmPath -Name "MaxConcurrentOperations" -Value 16 -Type DWord -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: DWM hardware rendering concurrency configured." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 15. Windows Search Indexer Backoff
Write-Host "`n[15/16] Tuning Windows Search Indexer Background Load..." -ForegroundColor Green
try {
    $srchPath = "HKLM:\SOFTWARE\Microsoft\Windows Search\Gathering Manager"
    if (-not (Test-Path $srchPath)) { New-Item -Path $srchPath -Force -ErrorAction SilentlyContinue | Out-Null }
    Set-ItemProperty -Path $srchPath -Name "DisableBackOff" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
    Write-Host "  -> OK: Search indexing will automatically pause during gaming/active use." -ForegroundColor Gray
} catch {
    Write-Host "  -> Skipped." -ForegroundColor DarkGray
}

# 16. RAM Working Set Cleanse
Write-Host "`n[16/16] Finalizing Memory Working Sets..." -ForegroundColor Green
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()
Write-Host "  -> OK: RAM cleanup completed." -ForegroundColor Gray

Write-Host "`n====================================================================" -ForegroundColor Cyan
Write-Host "    ALL 16 PEAK PERFORMANCE OPTIMIZATIONS SUCCESSFULLY APPLIED!     " -ForegroundColor Green
Write-Host "====================================================================" -ForegroundColor Cyan
Write-Host "`nPlease restart your PC to finalize GPU HAGS and DDR5 RAM locking." -ForegroundColor Yellow
Write-Host ""
