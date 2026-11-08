param([string]$combo)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class K {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  public static void Down(byte vk) { keybd_event(vk, (byte)MapVirtualKey(vk, 0), 0, UIntPtr.Zero); }
  public static void Up(byte vk) { keybd_event(vk, (byte)MapVirtualKey(vk, 0), 2, UIntPtr.Zero); }
}
"@
$vks = $combo.Split(',') | ForEach-Object { [byte][Convert]::ToInt32($_, 16) }
foreach ($v in $vks) { [K]::Down($v); Start-Sleep -Milliseconds 30 }
Start-Sleep -Milliseconds 80
[array]::Reverse($vks)
foreach ($v in $vks) { [K]::Up($v); Start-Sleep -Milliseconds 30 }
