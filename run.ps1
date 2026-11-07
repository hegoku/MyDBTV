[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position=0)]
  [ValidateSet("run", "stop", "status")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

$stateDir = Join-Path $PSScriptRoot "downloads"
$statePath = Join-Path $stateDir "server-pid.json"

function Run-MyTv-Server {
    $env:WEBDAV_ENABLED=1

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error "Cannot find node in the system PATH"
        exit 1
    }

    $process = Start-Process -FilePath "node" -ArgumentList "server.js" -PassThru
    Start-Sleep -Milliseconds 800
    if ($process.HasExited) {
        throw "npm start failed"
    }

    @{
        processId = $process.Id
        startedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

    .\mount\start-virtual-drive.ps1 -MountPath "C:\MyTV-Favorites"
}

function Stop-MyTv-Server {
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-Host "No PID of running server was found."
        exit 0
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    if ($process) {
        .\mount\stop-virtual-drive.ps1
        Stop-Process -Id $process.Id -Force
        Write-Host "Stopped MyTV server, PID: $($state.processId)."
    }
    Remove-Item -LiteralPath $statePath -Force
}

function Status-MyTv-Server {
    if (-not (Test-Path -LiteralPath $statePath)) {
        Write-Host "No PID of running server was found."
        exit 0
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    if ($process) {
        Write-Host "MyTV server is runnning, PID: $($state.processId)."
    } else {
        Write-Host "MyTV server is not runnning, PID: $($state.processId)."
    }
}

if ($Action -eq "run") {
    Run-MyTv-Server
} elseif ($Action -eq "stop") {
    Stop-MyTv-Server
} elseif ($Action -eq "status") {
    Status-MyTv-Server
}

