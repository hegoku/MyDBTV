[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MountPath,

  [Parameter(Mandatory = $true)]
  [string]$ShareName,

  [string[]]$ReadAccess = @("$env:COMPUTERNAME\$env:USERNAME")
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

$ResolvedReadAccess = $ReadAccess | ForEach-Object {
  $account = ($_ -replace "\\+", "\").Trim()
  if ($account -ieq "COMPUTER\user" -or $account -ieq "MY-PC\mytvreader") {
    $fallback = "$env:COMPUTERNAME\$env:USERNAME"
    Write-Warning "Replacing placeholder account '$account' with current user '$fallback'."
    return $fallback
  }
  return $account
}

New-SmbShare -Name $ShareName -Path $MountPath -ReadAccess $ResolvedReadAccess -Description "MyTV read-only favorites" | Out-Null
Write-Host "Created \\$env:COMPUTERNAME\$ShareName for: $($ResolvedReadAccess -join ', ')"
