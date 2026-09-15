[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'Cameo Agent Dispatcher Worker'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

$workerProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -like '*worker-service.mjs*'
})
$tunnelProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'ssh.exe' -and $_.CommandLine -like '*127.0.0.1:18765:127.0.0.1:8765*'
})

if ($workerProcesses.Count -gt 1 -or $tunnelProcesses.Count -gt 1) {
    throw 'Refusing to stop the dispatcher because its worker or tunnel process scope is ambiguous.'
}

foreach ($process in @($workerProcesses + $tunnelProcesses)) {
    Stop-Process -Id $process.ProcessId -Force
}

Start-Sleep -Milliseconds 500
$workerRemaining = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^node(\.exe)?$' -and $_.CommandLine -like '*worker-service.mjs*'
})
$tunnelRemaining = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'ssh.exe' -and $_.CommandLine -like '*127.0.0.1:18765:127.0.0.1:8765*'
})
if ($workerRemaining.Count -gt 0 -or $tunnelRemaining.Count -gt 0) {
    throw 'The dispatcher scheduled task stopped, but an owned child process is still active.'
}

[pscustomobject]@{
    TaskName = $taskName
    State = (Get-ScheduledTask -TaskName $taskName).State
    WorkerProcesses = 0
    TunnelProcesses = 0
}
