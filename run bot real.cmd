@echo off
REM ===========================================================================
REM  Pumpfun Sniper Bot - the one way to start the bot on Windows
REM ===========================================================================
REM  WHY THIS FILE EXISTS (do not "simplify" it to running the .exe):
REM
REM  Windows Smart App Control blocks unsigned binaries outright - there is no
REM  "Run anyway" prompt. Signatures measured on this machine:
REM      node.exe          Valid      (OpenJS Foundation)
REM      electron.exe      NotSigned  <- Electron's OWN prebuilt runtime
REM      our packaged app  NotSigned
REM      old pkg exe       NotSigned
REM  Electron ships its runtime unsigned, so SAC blocks ANY Electron build no
REM  matter how ours is signed. This launcher runs the engine through node.exe,
REM  which SAC trusts, and the dashboard opens in Edge/Chrome, which Microsoft
REM  and Google sign. Nothing unsigned ever executes, so nothing gets flagged.
REM
REM  State lives in the per-user app-data folder - the same one the desktop app
REM  uses - so there is exactly ONE set of keys, wallets and positions.
REM
REM  NOTE: the bot starts IDLE. Trading mode is whatever you saved (currently
REM  real), but no order is placed until you press START in the dashboard.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title Pumpfun Sniper Bot

set "SNIPER_DATA_DIR=%APPDATA%\pumpfun-token-screening-pipeline"
if not exist "%SNIPER_DATA_DIR%" mkdir "%SNIPER_DATA_DIR%" >nul 2>&1

where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js was not found on PATH.
  echo     Install the LTS build from https://nodejs.org and run this again.
  goto :halt
)

REM Rebuild only when dist is missing or a source file is newer than it, so a
REM git pull can never leave you silently running yesterday's code.
node -e "const fs=require('fs'),p=require('path');const d='dist/server.js';if(!fs.existsSync(d))process.exit(1);const t=fs.statSync(d).mtimeMs;const w=x=>fs.readdirSync(x,{withFileTypes:true}).some(e=>{const f=p.join(x,e.name);return e.isDirectory()?w(f):/\.(ts|tsx)$/.test(f)&&fs.statSync(f).mtimeMs>t});process.exit(w('src')?1:0)" >nul 2>&1
if errorlevel 1 (
  echo Source changed since the last build - rebuilding, one moment...
  REM --ignore-scripts skips Electron's ~100MB binary download, which this
  REM Node path never uses and which is a common failure point on a fresh
  REM machine. vite and tsc build fine without any install scripts.
  if not exist "node_modules" call npm install --ignore-scripts
  call npm run build
  if errorlevel 1 (
    echo [X] Build failed. Fix the error above, then run this again.
    goto :halt
  )
  echo Build complete.
  echo.
)

for /f "tokens=*" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "APPVER=%%v"
echo  Pumpfun Sniper Bot v%APPVER%
echo  Data folder : %SNIPER_DATA_DIR%
echo  Dashboard   : http://localhost:3001
echo  Closing this window stops the bot.
echo.

REM No --use-system-ca here: it only exists on Node 22.15+, and on anything
REM older node exits immediately with "bad option" instead of starting the bot.
node "dist\server.js"

echo.
echo Bot stopped.
:halt
echo.
pause >nul
