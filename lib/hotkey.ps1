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
  public static extern IntPtr GetForegroundWindow();

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
}
"@

$id = 1
if (-not [VoiceHotkey]::RegisterHotKey([IntPtr]::Zero, $id, [uint32]$Modifiers, [uint32]$VirtualKey)) {
  Write-Error "RegisterHotKey failed (the combination may already be used by another application)"
  exit 1
}

Write-Output "registered"

$worker = Join-Path $PSScriptRoot "hotkey-worker.ps1"
$powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

try {
  while ($true) {
    $msg = New-Object VoiceHotkey+MSG
    $result = [VoiceHotkey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)
    if ($result -le 0) { break }
    if ($msg.message -ne [VoiceHotkey]::WM_HOTKEY) { continue }
    if ($msg.wParam -ne [IntPtr]$id) { continue }

    # Remember the focused window and hand the HTTP request to a short-lived
    # worker. The listener stays responsive, so a second press can cancel a
    # recording that is still running.
    $target = [VoiceHotkey]::GetForegroundWindow().ToInt64()
    $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$worker`" -Url `"$Url`" -Target $target"
    if ($Token) { $arguments += " -Token `"$Token`"" }
    if ($Paste) { $arguments += " -Paste" }

    try {
      Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    } catch {
      # A failed spawn must not kill the listener.
    }
  }
} finally {
  [void][VoiceHotkey]::UnregisterHotKey([IntPtr]::Zero, $id)
}
