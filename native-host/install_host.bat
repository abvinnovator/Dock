@echo off
setlocal enabledelayedexpansion

echo.
echo  ============================================================
echo    Dock. Always-On-Top Native Host Installer
echo    by Nitytec
echo  ============================================================
echo.

:: ── Step 1: Verify PowerShell is available ────────────────────────────────────

where powershell.exe >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] PowerShell not found. Windows 10/11 is required.
    pause
    exit /b 1
)
echo  [OK] PowerShell found.

:: ── Step 2: Verify dock_topmost.ps1 exists ────────────────────────────────────

set SCRIPT_DIR=%~dp0
set PS_FILE=%SCRIPT_DIR%dock_topmost.ps1
set BAT_FILE=%SCRIPT_DIR%dock_topmost.bat

if not exist "%PS_FILE%" (
    echo  [ERROR] dock_topmost.ps1 not found in %SCRIPT_DIR%
    pause
    exit /b 1
)
if not exist "%BAT_FILE%" (
    echo  [ERROR] dock_topmost.bat not found in %SCRIPT_DIR%
    pause
    exit /b 1
)
echo  [OK] Native host scripts found.

:: ── Step 3: Prompt for Extension ID ──────────────────────────────────────────

echo.
echo  To register the native host, we need your Chrome extension ID.
echo  Find it at chrome://extensions (enable Developer Mode).
echo  It looks like: abcdefghijklmnopabcdefghijklmnop
echo.
set /p EXT_ID="  Enter your extension ID: "

if "%EXT_ID%"=="" (
    echo  [ERROR] Extension ID cannot be empty.
    pause
    exit /b 1
)

:: ── Step 4: Generate native messaging host manifest ──────────────────────────

set MANIFEST_FILE=%SCRIPT_DIR%com.nitytec.dock.topmost.json
set BAT_PATH_ESCAPED=%BAT_FILE:\=\\%

(
echo {
echo   "name": "com.nitytec.dock.topmost",
echo   "description": "Dock Always-On-Top Window Manager by Nitytec",
echo   "path": "%BAT_PATH_ESCAPED%",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://%EXT_ID%/"
echo   ]
echo }
) > "%MANIFEST_FILE%"

echo  [OK] Generated manifest: %MANIFEST_FILE%

:: ── Step 5: Register in Windows Registry ─────────────────────────────────────

set REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nitytec.dock.topmost

reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_FILE%" /f >nul 2>&1

if %errorlevel% neq 0 (
    echo  [ERROR] Failed to write registry key.
    pause
    exit /b 1
)
echo  [OK] Registered native messaging host in registry.

:: ── Done ─────────────────────────────────────────────────────────────────────

echo.
echo  ============================================================
echo    Setup complete!
echo.
echo    1. Reload the Dock extension in chrome://extensions
echo    2. Pin any tab as a companion
echo    3. The companion window will stay ALWAYS ON TOP
echo.
echo    Keyboard shortcut: Ctrl+Shift+D to bring all
echo    companions to front instantly.
echo  ============================================================
echo.
pause

