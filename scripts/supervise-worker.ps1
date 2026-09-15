[CmdletBinding()]
param(
    [ValidateRange(5, 300)]
    [int] $RestartDelaySeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $PSScriptRoot 'invoke-worker.ps1'
$serviceStateRoot = Join-Path $projectRoot 'state\service'
$supervisorLog = Join-Path $serviceStateRoot 'supervisor.log'
$mutex = [System.Threading.Mutex]::new($false, 'Local\CameoDispatcherSupervisor')
$ownsMutex = $false

function Write-SupervisorEvent {
    param([string] $Message)

    New-Item -ItemType Directory -Path $serviceStateRoot -Force | Out-Null
    $line = "$(Get-Date -Format o) $Message$([Environment]::NewLine)"
    [System.IO.File]::AppendAllText($supervisorLog, $line, [System.Text.Encoding]::UTF8)
}

try {
    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) {
        throw 'Another Cameo dispatcher supervisor is already active in this Windows session.'
    }
    if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) {
        throw "Worker launcher is missing: $workerScript"
    }

    Write-SupervisorEvent -Message 'Supervisor started.'
    while ($true) {
        try {
            & $workerScript
            Write-SupervisorEvent -Message 'Worker cycle exited unexpectedly without an error.'
        }
        catch {
            Write-SupervisorEvent -Message 'Worker cycle failed; retrying after the bounded delay.'
        }

        Start-Sleep -Seconds $RestartDelaySeconds
    }
}
finally {
    Write-SupervisorEvent -Message 'Supervisor stopped.'
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
