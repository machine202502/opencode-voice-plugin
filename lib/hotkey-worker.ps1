param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$Token = "",
  [long]$Target = 0,
  [switch]$Paste
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class VoiceWorker {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  public const byte VK_CONTROL = 0x11;
  public const byte VK_V = 0x56;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  public static void Paste() {
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, 0, UIntPtr.Zero);
    keybd_event(VK_V, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

$headers = @{}
if ($Token) { $headers["X-Voice-Token"] = $Token }

try {
  $response = Invoke-RestMethod -Method Post -Uri "$Url/hotkey" -Headers $headers -TimeoutSec 180
  # Only the request that actually produced a transcript pastes. The stop
  # request returns `stopping` without text.
  if ($Paste -and $response.ok -and $response.text -and $Target -ne 0) {
    # Only paste if the user is still in the window they pressed the hotkey in.
    if ([VoiceWorker]::GetForegroundWindow().ToInt64() -eq $Target) {
      [void][VoiceWorker]::SetForegroundWindow([IntPtr]$Target)
      Start-Sleep -Milliseconds 80
      [VoiceWorker]::Paste()
    }
  }
} catch {
  # A failed request or a cancelled recording must not leave anything running.
}
