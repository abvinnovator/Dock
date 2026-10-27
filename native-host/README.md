# Dock Always-On-Top Native Host

This directory contains the native messaging host that enables **true always-on-top** companion windows using Win32 `SetWindowPos(HWND_TOPMOST)`.

**Zero compilation needed.** Everything runs through PowerShell which is pre-installed on Windows 10/11.

## Setup (one-time)

1. **Double-click `install_host.bat`**
2. Enter your Chrome extension ID when prompted
   - Find it at `chrome://extensions` (enable Developer Mode)
   - It looks like: `abcdefghijklmnopabcdefghijklmnop`
3. Reload the Dock extension in Chrome
4. Pin any tab → it stays always-on-top automatically!

## How it works

1. Chrome extension sends a message to the native host: "pin this window as topmost"
2. `dock_topmost.bat` launches `dock_topmost.ps1` (PowerShell script)
3. PowerShell uses `Add-Type` to load Win32 `user32.dll` APIs at runtime
4. It finds the Chrome window by title + geometry match
5. Calls `SetWindowPos(hwnd, HWND_TOPMOST)` with `SWP_NOACTIVATE` — the window stays on top **without stealing keyboard focus**
6. Multiple windows can be pinned as always-on-top simultaneously

## Files

| File | Purpose |
|------|---------|
| `dock_topmost.ps1` | PowerShell native messaging host (Win32 API calls) |
| `dock_topmost.bat` | Thin batch launcher that Chrome calls |
| `dock_topmost.cs` | C# source (reference only — not used directly) |
| `install_host.bat` | One-click setup: generates manifest + registers in registry |
| `com.nitytec.dock.topmost.json` | Native messaging host manifest (created by setup) |

## Uninstall

To remove the native host:
```cmd
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nitytec.dock.topmost" /f
```
Then delete this directory.

## Chrome Web Store Deployment

> **Important:** Native messaging hosts **cannot** be distributed through the Chrome Web Store. The extension and the native host are deployed separately.

### Extension (Chrome Web Store)
1. Build: `pnpm turbo build`
2. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. Upload the `dist/` directory as a ZIP
4. The extension works without the native host (companions still open as popup windows with split-screen tiling). The native host just adds the "always on top" bonus feature.

### Native Host (Separate Download)
For users who want always-on-top:
- Provide the `native-host/` folder as a separate download (ZIP from your website or GitHub)
- Users download it, run `install_host.bat`, and enter their extension ID
- This is the standard approach used by all "always on top" Chrome extensions

