[CmdletBinding()]
param(
    [switch] $Once,
    [ValidateRange(1024, 65535)]
    [int] $LocalPort = 18765,
    [string] $SshDestination = '',
    [string] $RemoteHost = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int] $RemotePort = 8765
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $projectRoot 'state\secrets\runner-token.dpapi'
$configPath = Join-Path $projectRoot 'config.json'
$workerPath = Join-Path $projectRoot 'src\worker-service.mjs'
$serviceStateRoot = Join-Path $projectRoot 'state\service'
$environmentNames = @(
    'CAMEO_DISPATCHER_URL',
    'CAMEO_RUNNER_TOKEN',
    'CAMEO_RUNNER_CONFIG',
    'CAMEO_POLL_INTERVAL_MS',
    'CAMEO_MAX_CONSECUTIVE_ERRORS'
)
$previousEnvironment = @{}
$tunnel = $null
$tokenBytes = $null
$token = $null
$mutex = [System.Threading.Mutex]::new($false, 'Local\CameoDispatcherWorker')
$ownsMutex = $false
$transcriptStarted = $false

function Test-LoopbackPort {
    param([int] $Port)

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $client.Connect('127.0.0.1', $Port)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

try {
    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) {
        throw 'Another Cameo dispatcher worker is already active in this Windows session.'
    }

    if (-not $Once) {
        New-Item -ItemType Directory -Path $serviceStateRoot -Force | Out-Null
        Start-Transcript -Path (Join-Path $serviceStateRoot 'worker.log') -Append | Out-Null
        $transcriptStarted = $true
        Write-Output "Cameo dispatcher worker supervisor starting at $(Get-Date -Format o)."
    }

    foreach ($requiredPath in @($secretPath, $configPath, $workerPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required worker file is missing: $requiredPath"
        }
    }

    $runnerConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($SshDestination)) {
        $SshDestination = [string] $runnerConfig.sshDestination
    }
    if ([string]::IsNullOrWhiteSpace($SshDestination)) {
        throw 'SshDestination must be provided as a parameter or in config.json.'
    }

    if (Test-LoopbackPort -Port $LocalPort) {
        throw "Local loopback port $LocalPort is already in use."
    }

    $sshArguments = @(
        '-N',
        '-T',
        '-L', "127.0.0.1:${LocalPort}:${RemoteHost}:${RemotePort}",
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        $SshDestination
    )
    $tunnel = Start-Process -FilePath 'ssh.exe' -ArgumentList $sshArguments -WindowStyle Hidden -PassThru

    $tunnelReady = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ($tunnel.HasExited) {
            throw "SSH tunnel exited before becoming ready (exit $($tunnel.ExitCode))."
        }

        if (Test-LoopbackPort -Port $LocalPort) {
            $tunnelReady = $true
            break
        }

        Start-Sleep -Milliseconds 250
    }
    if (-not $tunnelReady) {
        throw 'SSH tunnel did not become ready within five seconds.'
    }

    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/healthz" -TimeoutSec 5
    if ($health.status -ne 'ok') {
        throw 'Forwarded dispatcher health check failed.'
    }

    $protectedBytes = [System.IO.File]::ReadAllBytes($secretPath)
    $tokenBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $token = [System.Text.Encoding]::UTF8.GetString($tokenBytes)
    if ([string]::IsNullOrWhiteSpace($token) -or $token -match '[\r\n]') {
        throw 'Protected runner credential is invalid.'
    }

    foreach ($name in $environmentNames) {
        $previousEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
    }
    [System.Environment]::SetEnvironmentVariable('CAMEO_DISPATCHER_URL', "http://127.0.0.1:$LocalPort", 'Process')
    [System.Environment]::SetEnvironmentVariable('CAMEO_RUNNER_TOKEN', $token, 'Process')
    [System.Environment]::SetEnvironmentVariable('CAMEO_RUNNER_CONFIG', $configPath, 'Process')
    [System.Environment]::SetEnvironmentVariable('CAMEO_POLL_INTERVAL_MS', '5000', 'Process')
    [System.Environment]::SetEnvironmentVariable('CAMEO_MAX_CONSECUTIVE_ERRORS', '6', 'Process')

    $workerArguments = @($workerPath)
    if ($Once) {
        $workerArguments += '--once'
    }

    & node.exe @workerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Cameo dispatcher worker exited with code $LASTEXITCODE."
    }
}
finally {
    foreach ($name in $environmentNames) {
        [System.Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }

    if ($tokenBytes) {
        [System.Security.Cryptography.CryptographicOperations]::ZeroMemory($tokenBytes)
    }
    $token = $null
    $tokenBytes = $null

    if ($tunnel -and -not $tunnel.HasExited) {
        Stop-Process -Id $tunnel.Id -Force
        $tunnel.WaitForExit(5000) | Out-Null
    }

    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()

    if ($transcriptStarted) {
        Write-Output "Cameo dispatcher worker supervisor stopped at $(Get-Date -Format o)."
        Stop-Transcript | Out-Null
    }
}
