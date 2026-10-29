param(
  [switch]$AutoStart,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Release = Join-Path $Root 'release'
$Exe = Join-Path $Release 'AgentManager.exe'
$Launcher = Join-Path $Release 'AgentManager.vbs'
$Wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$Desktop = [Environment]::GetFolderPath('Desktop')
$Programs = [Environment]::GetFolderPath('Programs')
$DesktopLink = Join-Path $Desktop 'AgentManager.lnk'
$StartLink = Join-Path $Programs 'AgentManager.lnk'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function New-Shortcut([string]$Path) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Wscript
  $shortcut.Arguments = '"' + $Launcher + '"'
  $shortcut.WorkingDirectory = $Release
  $shortcut.IconLocation = $Exe + ',0'
  $shortcut.Description = 'AgentManager - 多 code agent 配置管理器'
  $shortcut.WindowStyle = 1
  $shortcut.Save()
}

if ($Uninstall) {
  Remove-Item $DesktopLink, $StartLink -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $RunKey -Name 'AgentManager' -ErrorAction SilentlyContinue
  Write-Host 'AgentManager 快捷方式与开机启动项已移除。'
  exit 0
}

if (-not (Test-Path $Exe)) {
  throw "缺少 $Exe，先运行 npm run build:exe"
}
if (-not (Test-Path $Launcher)) {
  throw "缺少 $Launcher，先运行 npm run build:exe"
}

New-Shortcut $DesktopLink
New-Shortcut $StartLink
Write-Host "桌面快捷方式: $DesktopLink"
Write-Host "开始菜单:     $StartLink"

if ($AutoStart) {
  New-Item -Path $RunKey -Force | Out-Null
  New-ItemProperty -Path $RunKey -Name 'AgentManager' -Value ('"' + $Wscript + '" "' + $Launcher + '"') -PropertyType String -Force | Out-Null
  Write-Host '已加入开机启动（HKCU Run）。'
}
