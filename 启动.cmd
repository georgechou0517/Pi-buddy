@echo off
rem Debug launcher: keeps the console so you can read logs. Use the VBS launcher (or the desktop shortcut) for normal use.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [Pi-buddy] Node.js not found.
  echo Please install Node.js 20 or newer from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node server.js
if errorlevel 1 pause
