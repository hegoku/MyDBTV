[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$MountPath,

  [string]$WebDavUrl = "http://127.0.0.1:5178/",

  [string]$WebDavUsername = "",

  [string]$WebDavPassword = "",

  [string]$RclonePath = "rclone.exe"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $projectRoot "downloads\mount"
$statePath = Join-Path $stateDir "rclone-mount.json"

if (-not (Get-Command $RclonePath -ErrorAction SilentlyContinue)) {
  throw "rclone was not found. Install rclone and WinFsp before mounting MyTV Favorites."
}

$parent = Split-Path -Parent $MountPath
if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
  throw "The parent directory of MountPath must already exist: $parent"
}
if (Test-Path -LiteralPath $MountPath) {
  throw "MountPath must not already exist: $MountPath"
}
if (($WebDavUsername -and -not $WebDavPassword) -or ($WebDavPassword -and -not $WebDavUsername)) {
  throw "Specify both WebDavUsername and WebDavPassword, or neither."
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
if (Test-Path -LiteralPath $statePath) {
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if (Get-Process -Id $state.processId -ErrorAction SilentlyContinue) {
    throw "A MyTV virtual drive is already running (PID $($state.processId)). Stop it first."
  }
  Remove-Item -LiteralPath $statePath -Force
}

$arguments = @(
  "mount",
  ":webdav:",
  $MountPath,
  "--webdav-url", $WebDavUrl,
  "--webdav-vendor", "other",
  "--read-only",
  "--vfs-cache-mode", "minimal",
  "--vfs-read-chunk-size", "4M",
  "--vfs-read-chunk-size-limit", "32M",
  "--buffer-size", "16M",
  "--dir-cache-time", "30s",
  "--attr-timeout", "30s",
  "--volname", "MyTV Favorites"
)

if ($WebDavUsername) {
  $obscuredPassword = & $RclonePath obscure $WebDavPassword
  if ($LASTEXITCODE -ne 0 -or -not $obscuredPassword) {
    throw "rclone could not protect the WebDAV password."
  }
  $arguments += @("--webdav-user", $WebDavUsername, "--webdav-pass", $obscuredPassword.Trim())
}

$stdout = Join-Path $stateDir "rclone-mount.stdout.log"
$stderr = Join-Path $stateDir "rclone-mount.stderr.log"
# Start-Process takes one command-line string on Windows. None of the values
# accepted here may contain a literal double quote (Windows paths cannot either),
# so quoting each argument preserves spaces in mount paths and credentials.
if ($arguments | Where-Object { $_.Contains('"') }) {
  throw "Double quotes are not supported in mount arguments."
}
$argumentLine = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join " "
$process = Start-Process -FilePath $RclonePath -ArgumentList $argumentLine -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Start-Sleep -Milliseconds 800
if ($process.HasExited) {
  $details = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { "" }
  throw "rclone could not mount MyTV Favorites. $details"
}

@{
  processId = $process.Id
  mountPath = $MountPath
  webDavUrl = $WebDavUrl
  startedAt = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

Write-Host "Mounted MyTV Favorites at $MountPath"
Write-Host "Run .\mount\publish-smb-share.ps1 -MountPath '$MountPath' -ShareName MyTV -ReadAccess '$env:COMPUTERNAME\$env:USERNAME' from an elevated PowerShell to publish it over SMB."
