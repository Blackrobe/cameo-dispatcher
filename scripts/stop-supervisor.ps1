[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'Cameo Agent Dispatcher Worker'
$projectRoot = Split-Path -Parent $PSScriptRoot
$worktreeRoot = 'C:\Users\Blackrobe\CameoDispatcherWorktrees'

function Get-DispatcherProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $command = [string]$_.CommandLine
        ($_.Name -match '^node(\.exe)?$' -and (
            $command -like "*$projectRoot\src\worker-service.mjs*" -or
            $command -like "*$projectRoot\src\run-job.mjs*" -or
            $command -like "*$projectRoot\src\run-followup.mjs*" -or
            $command -like "*$projectRoot\src\recover-publication.mjs*"
        )) -or
        ($_.Name -ieq 'codex-app.exe' -and $command -like "*-C $worktreeRoot*") -or
        ($_.Name -ieq 'ssh.exe' -and $command -like '*127.0.0.1:18765:127.0.0.1:8765*') -or
        ($_.Name -in @('git.exe', 'gh.exe') -and $command -like "*$worktreeRoot*")
    })
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

$owned = @(Get-DispatcherProcesses | Sort-Object ProcessId -Unique)
$ownedIds = @($owned.ProcessId)
$roots = @($owned | Where-Object { $ownedIds -notcontains $_.ParentProcessId })
foreach ($process in $roots) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $process.ProcessId /T /F | Out-Null
}

Start-Sleep -Milliseconds 750
$remaining = @(Get-DispatcherProcesses)
if ($remaining.Count -gt 0) {
    throw 'The dispatcher scheduled task stopped, but an owned child process is still active.'
}

[pscustomobject]@{
    TaskName = $taskName
    State = (Get-ScheduledTask -TaskName $taskName).State
    StoppedOwnedProcesses = $owned.Count
    RemainingOwnedProcesses = 0
}
