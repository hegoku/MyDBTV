[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $projectRoot "downloads\mount\rclone-mount.json"
if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Host "No MyTV virtual drive state was found."
  exit 0
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$process = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $process.Id -Force
  Write-Host "Stopped MyTV virtual drive at $($state.mountPath)."
}
Remove-Item -LiteralPath $statePath -Force
