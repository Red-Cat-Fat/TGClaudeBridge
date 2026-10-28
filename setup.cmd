@echo off
rem TGClaudeBridge setup for Windows: asks for the bot token, chat id and idle time, saves them, installs the plugin.
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required: https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0setup.js" %*
pause
