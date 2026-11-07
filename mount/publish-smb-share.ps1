[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MountPath,

  [Parameter(Mandatory = $true)]
  [string]$ShareName,

  [Parameter(Mandatory = $true)]
  [string[]]$ReadAccess
)

$ErrorActionPreference = "Stop"
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an elevated PowerShell window."
}
if (-not (Test-Path -LiteralPath $MountPath -PathType Container)) {
  throw "The mounted virtual directory is not available: $MountPath"
}
if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
  throw "An SMB share already exists with this name: $ShareName"
}

New-SmbShare -Name $ShareName -Path $MountPath -ReadAccess $ReadAccess -Description "MyTV read-only favorites" | Out-Null
Write-Host "Created \\$env:COMPUTERNAME\$ShareName for: $($ReadAccess -join ', ')"
