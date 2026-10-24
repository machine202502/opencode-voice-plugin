param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][int]$Modifiers,
  [Parameter(Mandatory = $true)][int]$VirtualKey,
  [string]$Token = "",
  [switch]$Paste
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class VoiceHotkey {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  [DllImport("user32.dll")]
  public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

  [DllImport("user32.dll")]
  public static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

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
  public const uint PM_REMOVE = 0x0001;
  public const byte VK_CONTROL = 0x11;
  public const byte VK_V = 0x56;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  public static int DrainHotkeys() {
    int count = 0;
    MSG message;
    while (PeekMessage(out message, IntPtr.Zero, 0, 0, PM_REMOVE)) {
      if (message.message == WM_HOTKEY) count++;
    }
    return count;
  }

  public static void Paste() {
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

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

    # Remember which window was focused when the hotkey was pressed. Only paste
    # back if the user is still there, so the transcript cannot land in a window
    # they switched to while speaking.
    $target = [VoiceHotkey]::GetForegroundWindow()
    try {
      $headers = @{}
      if ($Token) { $headers["X-Voice-Token"] = $Token }
      $response = Invoke-RestMethod -Method Post -Uri "$Url/hotkey" -Headers $headers -TimeoutSec 180
      if ($Paste -and $response.ok -and [VoiceHotkey]::GetForegroundWindow() -eq $target) {
        [void][VoiceHotkey]::SetForegroundWindow($target)
        Start-Sleep -Milliseconds 80
        [VoiceHotkey]::Paste()
      }
    } catch {
      # A failed request must not kill the hotkey listener.
    }

    # While the HTTP request was running, a held or repeatedly pressed key can
    # queue more WM_HOTKEY messages. Discard them instead of starting a chain of
    # recordings; the user has to press the combination again.
    [void][VoiceHotkey]::DrainHotkeys()
  }
} finally {
  [void][VoiceHotkey]::UnregisterHotKey([IntPtr]::Zero, $id)
}
