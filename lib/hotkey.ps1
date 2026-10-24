param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][int]$Modifiers,
  [Parameter(Mandatory = $true)][int]$VirtualKey,
  [string]$Token = "",
  [switch]$Paste,
  [switch]$OnlyOpenCode
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class VoiceHotkey {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  [DllImport("user32.dll")]
  public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x;
    public int y;
  }

  public const uint WM_HOTKEY = 0x0312;

  public static bool IsOpenCode(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;

    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    try {
      // Process name only: the desktop app and its Electron renderers are all
      // "OpenCode". A window title is not reliable - an editor showing this
      // project would contain "opencode-voice" and would wrongly match.
      var process = System.Diagnostics.Process.GetProcessById((int)pid);
      return string.Equals(process.ProcessName, "OpenCode", StringComparison.OrdinalIgnoreCase);
    } catch {
      return false;
    }
  }
}

/// Window-scoped hotkey for -OnlyOpenCode.
///
/// RegisterHotKey always takes the combination away from every application,
/// even when the script then ignores the press. This hook instead sees the
/// keys on their way to the focused window and consumes the combination only
/// while OpenCode is in front. In any other window (editor, browser, terminal)
/// the keys are passed through untouched, so the same shortcut keeps working
/// there.
public static class VoiceHotkeyHook {
  const int WH_KEYBOARD_LL = 13;
  const int WM_KEYDOWN = 0x0100;
  const int WM_KEYUP = 0x0101;
  const int WM_SYSKEYDOWN = 0x0104;
  const int WM_SYSKEYUP = 0x0105;
  const int VK_SHIFT = 0x10;
  const int VK_CONTROL = 0x11;
  const int VK_MENU = 0x12;
  const int VK_LWIN = 0x5B;
  const int VK_RWIN = 0x5C;

  [StructLayout(LayoutKind.Sequential)]
  struct KBDLLHOOKSTRUCT {
    public uint vkCode;
    public uint scanCode;
    public uint flags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool UnhookWindowsHookEx(IntPtr hhk);

  [DllImport("user32.dll")]
  static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  static extern short GetAsyncKeyState(int vKey);

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  static extern IntPtr GetModuleHandle(string lpModuleName);

  // Kept in fields: the GC must not collect the delegate while the hook lives.
  static LowLevelKeyboardProc _proc;
  static IntPtr _hook = IntPtr.Zero;
  static int _virtualKey;
  static bool _wantCtrl;
  static bool _wantAlt;
  static bool _wantShift;
  static bool _wantWin;
  static string _powerShell;
  static string _workerArgs;
  static bool _pressed;
  static bool _swallowed;

  /// Returns null on success or the error text.
  public static string Start(int modifiers, int virtualKey, string powerShell, string workerArgs) {
    _virtualKey = virtualKey;
    _wantAlt = (modifiers & 0x0001) != 0;
    _wantCtrl = (modifiers & 0x0002) != 0;
    _wantShift = (modifiers & 0x0004) != 0;
    _wantWin = (modifiers & 0x0008) != 0;
    _powerShell = powerShell;
    _workerArgs = workerArgs;
    _pressed = false;
    _swallowed = false;

    _proc = HookCallback;
    _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
    if (_hook == IntPtr.Zero) {
      _proc = null;
      return "SetWindowsHookEx failed: " + Marshal.GetLastWin32Error();
    }
    return null;
  }

  public static void Stop() {
    if (_hook != IntPtr.Zero) {
      UnhookWindowsHookEx(_hook);
      _hook = IntPtr.Zero;
    }
    _proc = null;
  }

  static bool Down(int vk) {
    return (GetAsyncKeyState(vk) & 0x8000) != 0;
  }

  static bool ComboDown() {
    return Down(VK_CONTROL) == _wantCtrl
      && Down(VK_MENU) == _wantAlt
      && Down(VK_SHIFT) == _wantShift
      && (Down(VK_LWIN) || Down(VK_RWIN)) == _wantWin;
  }

  static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      int message = wParam.ToInt32();
      bool isDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
      bool isUp = message == WM_KEYUP || message == WM_SYSKEYUP;
      int vk = (int)info.vkCode;

      if (vk == _virtualKey) {
        if (isDown) {
          if (!_pressed) {
            _pressed = true;
            // Pressing the combination in another application must leave no
            // trace there: the chord is only consumed while OpenCode is in
            // front, and even then only when the modifiers match.
            if (ComboDown() && VoiceHotkey.IsOpenCode(VoiceHotkey.GetForegroundWindow())) {
              _swallowed = true;
              Trigger();
              return (IntPtr)1;
            }
          } else if (_swallowed) {
            // Auto-repeat while the combination is held down.
            return (IntPtr)1;
          }
        } else if (isUp) {
          _pressed = false;
          if (_swallowed) {
            _swallowed = false;
            return (IntPtr)1;
          }
        }
      } else if (isUp && (vk == VK_CONTROL || vk == VK_MENU || vk == VK_SHIFT)) {
        // A modifier was released: the next press is a fresh combination.
        _pressed = false;
        _swallowed = false;
      }
    }

    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }

  static void Trigger() {
    long target = VoiceHotkey.GetForegroundWindow().ToInt64();
    string arguments = _workerArgs + " -Target " + target.ToString();
    // Never block the keyboard hook: a stuck hook is removed by Windows.
    ThreadPool.QueueUserWorkItem(delegate {
      try {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = _powerShell;
        start.Arguments = arguments;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WindowStyle = ProcessWindowStyle.Hidden;
        Process.Start(start);
      } catch {
        // A failed spawn must not kill the listener.
      }
    });
  }
}
"@

$worker = Join-Path $PSScriptRoot "hotkey-worker.ps1"
$powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$worker`" -Url `"$Url`""
if ($Token) { $arguments += " -Token `"$Token`"" }
if ($Paste) { $arguments += " -Paste" }

if ($OnlyOpenCode) {
  # Window-scoped: the combination is not registered system-wide, so it stays
  # available to every other application. A named mutex keeps a second listener
  # (another OpenCode window, a manual start) from double-triggering.
  $mutex = New-Object System.Threading.Mutex($false, "Local\opencode-voice-hotkey-$Modifiers-$VirtualKey")
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    Write-Output "another listener already owns this hotkey"
    exit 0
  }

  $failure = [VoiceHotkeyHook]::Start([int]$Modifiers, [int]$VirtualKey, $powerShell, $arguments)
  if ($failure) {
    [void]$mutex.ReleaseMutex()
    $mutex.Dispose()
    Write-Error $failure
    exit 1
  }

  Write-Output "hooked (only while OpenCode is in the foreground)"

  try {
    while ($true) {
      $msg = New-Object VoiceHotkey+MSG
      if ([VoiceHotkey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -le 0) { break }
    }
  } finally {
    [VoiceHotkeyHook]::Stop()
    try { [void]$mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
  }

  exit 0
}

# Global mode: the documented "works everywhere" behavior.
$id = 1
if (-not [VoiceHotkey]::RegisterHotKey([IntPtr]::Zero, $id, [uint32]$Modifiers, [uint32]$VirtualKey)) {
  Write-Error "RegisterHotKey failed (the combination may already be used by another application)"
  exit 1
}

Write-Output "registered"

try {
  while ($true) {
    $msg = New-Object VoiceHotkey+MSG
    $result = [VoiceHotkey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)
    if ($result -le 0) { break }
    if ($msg.message -ne [VoiceHotkey]::WM_HOTKEY) { continue }
    if ($msg.wParam -ne [IntPtr]$id) { continue }

    $target = [VoiceHotkey]::GetForegroundWindow().ToInt64()
    $workerArguments = $arguments + " -Target $target"
    try {
      Start-Process -FilePath $powerShell -ArgumentList $workerArguments -WindowStyle Hidden | Out-Null
    } catch {
      # A failed spawn must not kill the listener.
    }
  }
} finally {
  [void][VoiceHotkey]::UnregisterHotKey([IntPtr]::Zero, $id)
}
