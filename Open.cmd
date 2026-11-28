@echo off
setlocal DisableDelayedExpansion
title Bikini Bottom - Local Preview

where node.exe >nul 2>&1
if errorlevel 1 (
    echo Install Node.js 20 or later, then run Open.cmd again.
    pause
    exit /b 1
)

echo Keep this window open while you explore.
node.exe "%~dp0serve.mjs" --open
set "serverExit=%errorlevel%"
if not "%serverExit%"=="0" pause
exit /b %serverExit%
