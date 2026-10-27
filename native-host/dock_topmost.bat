@echo off
:: Dock Always-On-Top Native Messaging Host Launcher
:: This batch file is the entry point that Chrome calls.
:: It launches the PowerShell script that handles the actual Win32 API calls.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0dock_topmost.ps1"
