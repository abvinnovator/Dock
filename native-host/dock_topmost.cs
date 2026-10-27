using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

/// <summary>
/// Dock Always-On-Top Native Messaging Host
/// Receives commands from the Dock Chrome extension via Chrome's native messaging protocol.
/// Uses Win32 SetWindowPos to pin/unpin Chrome windows as HWND_TOPMOST.
/// </summary>
class DockTopmostHost
{
    // ── Win32 API Imports ──────────────────────────────────────────────────────

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

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    // ── Window Finder ──────────────────────────────────────────────────────────

    /// <summary>
    /// Finds a visible Chrome window whose title contains the given substring.
    /// If left/top/width/height are provided, also matches by approximate geometry
    /// to disambiguate windows with similar titles.
    /// </summary>
    static IntPtr FindChromeWindow(string titleSubstring, int? left, int? top, int? width, int? height)
    {
        IntPtr bestMatch = IntPtr.Zero;
        int bestScore = -1;

        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;

            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string windowTitle = sb.ToString();

            if (string.IsNullOrEmpty(windowTitle)) return true;
            if (windowTitle.IndexOf(titleSubstring, StringComparison.OrdinalIgnoreCase) < 0) return true;

            int score = 1; // Title matched

            // If geometry hints are provided, score by proximity
            if (left.HasValue && top.HasValue && width.HasValue && height.HasValue)
            {
                RECT rect;
                if (GetWindowRect(hWnd, out rect))
                {
                    int wLeft = rect.Left;
                    int wTop = rect.Top;
                    int wWidth = rect.Right - rect.Left;
                    int wHeight = rect.Bottom - rect.Top;

                    // Check if geometry is close (within 50px tolerance for DPI scaling)
                    int tolerance = 50;
                    if (Math.Abs(wLeft - left.Value) < tolerance &&
                        Math.Abs(wTop - top.Value) < tolerance &&
                        Math.Abs(wWidth - width.Value) < tolerance &&
                        Math.Abs(wHeight - height.Value) < tolerance)
                    {
                        score = 10; // Strong geometry match
                    }
                }
            }

            if (score > bestScore)
            {
                bestScore = score;
                bestMatch = hWnd;
            }

            return true; // Continue enumeration
        }, IntPtr.Zero);

        return bestMatch;
    }

    /// <summary>
    /// Finds ALL visible Chrome windows whose titles contain the given substring.
    /// </summary>
    static List<IntPtr> FindAllChromeWindows(string titleSubstring)
    {
        var results = new List<IntPtr>();

        EnumWindows((hWnd, lParam) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string windowTitle = sb.ToString();
            if (!string.IsNullOrEmpty(windowTitle) &&
                windowTitle.IndexOf(titleSubstring, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                results.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);

        return results;
    }

    // ── Pin / Unpin ────────────────────────────────────────────────────────────

    static bool PinTopmost(IntPtr hwnd)
    {
        return SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    static bool UnpinTopmost(IntPtr hwnd)
    {
        return SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    // ── Native Messaging Protocol ──────────────────────────────────────────────

    static string ReadMessage()
    {
        var stdin = Console.OpenStandardInput();
        byte[] lengthBytes = new byte[4];
        int bytesRead = stdin.Read(lengthBytes, 0, 4);
        if (bytesRead < 4) return null;

        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > 1024 * 1024) return null;

        byte[] messageBytes = new byte[length];
        int totalRead = 0;
        while (totalRead < length)
        {
            int read = stdin.Read(messageBytes, totalRead, length - totalRead);
            if (read <= 0) return null;
            totalRead += read;
        }

        return Encoding.UTF8.GetString(messageBytes);
    }

    static void WriteMessage(string message)
    {
        var stdout = Console.OpenStandardOutput();
        byte[] messageBytes = Encoding.UTF8.GetBytes(message);
        byte[] lengthBytes = BitConverter.GetBytes(messageBytes.Length);
        stdout.Write(lengthBytes, 0, 4);
        stdout.Write(messageBytes, 0, messageBytes.Length);
        stdout.Flush();
    }

    // ── Simple JSON Helpers (no external dependencies) ─────────────────────────

    static string GetJsonValue(string json, string key)
    {
        string searchKey = "\"" + key + "\"";
        int keyIdx = json.IndexOf(searchKey);
        if (keyIdx < 0) return null;

        int colonIdx = json.IndexOf(':', keyIdx + searchKey.Length);
        if (colonIdx < 0) return null;

        int valueStart = colonIdx + 1;
        while (valueStart < json.Length && json[valueStart] == ' ') valueStart++;

        if (valueStart >= json.Length) return null;

        if (json[valueStart] == '"')
        {
            // String value
            int strStart = valueStart + 1;
            int strEnd = json.IndexOf('"', strStart);
            if (strEnd < 0) return null;
            return json.Substring(strStart, strEnd - strStart);
        }
        else
        {
            // Number, bool, null
            int end = valueStart;
            while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != ' ')
                end++;
            return json.Substring(valueStart, end - valueStart);
        }
    }

    static int? GetJsonInt(string json, string key)
    {
        string val = GetJsonValue(json, key);
        if (val == null) return null;
        int result;
        if (int.TryParse(val, out result)) return result;
        return null;
    }

    // ── Main Loop ──────────────────────────────────────────────────────────────

    static void Main(string[] args)
    {
        while (true)
        {
            string message = ReadMessage();
            if (message == null) break;

            string action = GetJsonValue(message, "action");
            string title = GetJsonValue(message, "title");
            int? left = GetJsonInt(message, "left");
            int? top = GetJsonInt(message, "top");
            int? width = GetJsonInt(message, "width");
            int? height = GetJsonInt(message, "height");

            string response;

            switch (action)
            {
                case "pin_topmost":
                    if (string.IsNullOrEmpty(title))
                    {
                        response = "{\"ok\":false,\"error\":\"missing title\"}";
                        break;
                    }
                    var pinHwnd = FindChromeWindow(title, left, top, width, height);
                    if (pinHwnd == IntPtr.Zero)
                    {
                        response = "{\"ok\":false,\"error\":\"window not found\"}";
                    }
                    else
                    {
                        bool pinned = PinTopmost(pinHwnd);
                        response = pinned
                            ? "{\"ok\":true,\"hwnd\":" + pinHwnd.ToInt64() + "}"
                            : "{\"ok\":false,\"error\":\"SetWindowPos failed\"}";
                    }
                    break;

                case "unpin_topmost":
                    if (string.IsNullOrEmpty(title))
                    {
                        response = "{\"ok\":false,\"error\":\"missing title\"}";
                        break;
                    }
                    var unpinHwnd = FindChromeWindow(title, left, top, width, height);
                    if (unpinHwnd == IntPtr.Zero)
                    {
                        response = "{\"ok\":false,\"error\":\"window not found\"}";
                    }
                    else
                    {
                        bool unpinned = UnpinTopmost(unpinHwnd);
                        response = unpinned
                            ? "{\"ok\":true}"
                            : "{\"ok\":false,\"error\":\"SetWindowPos failed\"}";
                    }
                    break;

                case "ping":
                    response = "{\"ok\":true,\"version\":\"1.0.0\"}";
                    break;

                default:
                    response = "{\"ok\":false,\"error\":\"unknown action: " + (action ?? "null") + "\"}";
                    break;
            }

            WriteMessage(response);
        }
    }
}
