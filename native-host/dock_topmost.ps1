# Dock Always-On-Top Native Messaging Host
# Communicates with the Dock Chrome extension via Chrome's native messaging protocol.
# Uses Win32 SetWindowPos to pin/unpin Chrome windows as HWND_TOPMOST.
# Zero dependencies — runs on any Windows 10/11 with PowerShell 5.1+.

# ── Load Win32 API ─────────────────────────────────────────────────────────────

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class DockWindowManager
{
    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static IntPtr FindWindowByTitle(string titleSubstring, int hintLeft, int hintTop, int hintWidth, int hintHeight)
    {
        IntPtr bestMatch = IntPtr.Zero;
        int bestScore = -1;

        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string title = sb.ToString();
            if (string.IsNullOrEmpty(title)) return true;
            if (title.IndexOf(titleSubstring, StringComparison.OrdinalIgnoreCase) < 0) return true;

            int score = 1;
            if (hintWidth > 0 && hintHeight > 0)
            {
                RECT rect;
                if (GetWindowRect(hWnd, out rect))
                {
                    int tolerance = 60;
                    if (Math.Abs(rect.Left - hintLeft) < tolerance &&
                        Math.Abs(rect.Top - hintTop) < tolerance &&
                        Math.Abs((rect.Right - rect.Left) - hintWidth) < tolerance &&
                        Math.Abs((rect.Bottom - rect.Top) - hintHeight) < tolerance)
                    {
                        score = 10;
                    }
                }
            }

            if (score > bestScore) { bestScore = score; bestMatch = hWnd; }
            return true;
        }, IntPtr.Zero);

        return bestMatch;
    }

    public static bool PinTopmost(IntPtr hwnd)
    {
        return SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    public static bool UnpinTopmost(IntPtr hwnd)
    {
        return SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}
"@

# ── Native Messaging Protocol I/O ──────────────────────────────────────────────

$stdin = [System.Console]::OpenStandardInput()
$stdout = [System.Console]::OpenStandardOutput()

function Read-NativeMessage {
    $lengthBytes = New-Object byte[] 4
    $bytesRead = $stdin.Read($lengthBytes, 0, 4)
    if ($bytesRead -lt 4) { return $null }

    $length = [System.BitConverter]::ToInt32($lengthBytes, 0)
    if ($length -le 0 -or $length -gt 1048576) { return $null }

    $messageBytes = New-Object byte[] $length
    $totalRead = 0
    while ($totalRead -lt $length) {
        $read = $stdin.Read($messageBytes, $totalRead, $length - $totalRead)
        if ($read -le 0) { return $null }
        $totalRead += $read
    }

    return [System.Text.Encoding]::UTF8.GetString($messageBytes)
}

function Write-NativeMessage($message) {
    $messageBytes = [System.Text.Encoding]::UTF8.GetBytes($message)
    $lengthBytes = [System.BitConverter]::GetBytes($messageBytes.Length)
    $stdout.Write($lengthBytes, 0, 4)
    $stdout.Write($messageBytes, 0, $messageBytes.Length)
    $stdout.Flush()
}

# ── Simple JSON Helpers ────────────────────────────────────────────────────────

function Get-JsonString($json, $key) {
    if ($json -match """$key""\s*:\s*""([^""]*?)""") { return $Matches[1] }
    return $null
}

function Get-JsonInt($json, $key) {
    if ($json -match """$key""\s*:\s*(-?\d+)") { return [int]$Matches[1] }
    return 0
}

# ── Main Loop ──────────────────────────────────────────────────────────────────

while ($true) {
    $message = Read-NativeMessage
    if ($null -eq $message) { break }

    $action = Get-JsonString $message "action"
    $title = Get-JsonString $message "title"
    $left = Get-JsonInt $message "left"
    $top = Get-JsonInt $message "top"
    $width = Get-JsonInt $message "width"
    $height = Get-JsonInt $message "height"

    $response = ""

    switch ($action) {
        "pin_topmost" {
            if ([string]::IsNullOrEmpty($title)) {
                $response = '{"ok":false,"error":"missing title"}'
            } else {
                $hwnd = [DockWindowManager]::FindWindowByTitle($title, $left, $top, $width, $height)
                if ($hwnd -eq [IntPtr]::Zero) {
                    $response = '{"ok":false,"error":"window not found"}'
                } else {
                    $result = [DockWindowManager]::PinTopmost($hwnd)
                    if ($result) {
                        $response = '{"ok":true,"hwnd":' + $hwnd.ToInt64().ToString() + '}'
                    } else {
                        $response = '{"ok":false,"error":"SetWindowPos failed"}'
                    }
                }
            }
        }
        "unpin_topmost" {
            if ([string]::IsNullOrEmpty($title)) {
                $response = '{"ok":false,"error":"missing title"}'
            } else {
                $hwnd = [DockWindowManager]::FindWindowByTitle($title, $left, $top, $width, $height)
                if ($hwnd -eq [IntPtr]::Zero) {
                    $response = '{"ok":false,"error":"window not found"}'
                } else {
                    $result = [DockWindowManager]::UnpinTopmost($hwnd)
                    if ($result) {
                        $response = '{"ok":true}'
                    } else {
                        $response = '{"ok":false,"error":"SetWindowPos failed"}'
                    }
                }
            }
        }
        "ping" {
            $response = '{"ok":true,"version":"1.0.0"}'
        }
        default {
            $response = '{"ok":false,"error":"unknown action"}'
        }
    }

    Write-NativeMessage $response
}
