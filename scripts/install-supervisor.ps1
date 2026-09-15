[CmdletBinding()]
param(
    [switch] $Start
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'Cameo Agent Dispatcher Worker'
$supervisorScript = Join-Path $PSScriptRoot 'supervise-worker.ps1'
$powerShell = 'C:\Program Files\PowerShell\7\pwsh.exe'
$userId = "$env:USERDOMAIN\$env:USERNAME"

foreach ($requiredPath in @($supervisorScript, $powerShell)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required supervisor file is missing: $requiredPath"
    }
}

$actionArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$supervisorScript`""
$action = New-ScheduledTaskAction -Execute $powerShell -Argument $actionArguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RunOnlyIfNetworkAvailable `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Keeps the owner-controlled Cameo Discord-to-Codex runner online under Blackrobe user credentials.' `
    -Force | Out-Null

if ($Start) {
    Start-ScheduledTask -TaskName $taskName
}

$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
    TaskName = $task.TaskName
    State = $task.State
    UserId = $task.Principal.UserId
    LogonType = $task.Principal.LogonType
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
}
