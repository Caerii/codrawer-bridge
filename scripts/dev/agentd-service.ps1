# A per-user Windows Task Scheduler launcher for the managed responder.
# Configuration stays outside the repository; this script never prints pairing codes.
param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet('validate', 'install', 'status', 'restart', 'update', 'uninstall', 'run')]
    [string]$Command,
    [string]$Config = (Join-Path $HOME '.codrawer-agentd/config.toml'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Config = [IO.Path]::GetFullPath($Config)

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Directory) {
    Push-Location $Directory
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$File exited with $LASTEXITCODE" }
    } finally { Pop-Location }
}

function Get-Definition {
    Push-Location $root
    try {
        $raw = & uv run python -m codrawer_bridge.agentd.daemon inspect --config $Config
        if ($LASTEXITCODE -ne 0) { throw 'agentd configuration is invalid' }
        return ($raw | ConvertFrom-Json)
    } finally { Pop-Location }
}

function Get-LiveStatus($definition) {
    $python = Join-Path $definition.checkout '.venv/Scripts/python.exe'
    if (Test-Path -LiteralPath $python) {
        $raw = & $python -m codrawer_bridge.agentd.daemon status --config $Config
    } else {
        Push-Location $root
        try { $raw = & uv run python -m codrawer_bridge.agentd.daemon status --config $Config }
        finally { Pop-Location }
    }
    if ($LASTEXITCODE -ne 0) { throw 'could not inspect the running responder' }
    return ($raw | ConvertFrom-Json)
}

function Assert-Quiescent($definition) {
    $task = Get-ScheduledTask -TaskName $definition.task_name -ErrorAction SilentlyContinue
    $live = Get-LiveStatus $definition
    if (-not $live.running) { return }
    if (-not $task -or $task.State -ne 'Running') {
        throw 'A responder holds the lock outside the managed task; stop it deliberately first.'
    }
    if ($Force) { return }
    if (-not $live.health -or $live.health_age_s -gt 30) {
        throw 'Health is missing or stale; refusing to interrupt an unknown Ask. Use -Force only after checking it.'
    }
    if ($live.health.in_flight -ne 0) {
        throw "There are $($live.health.in_flight) accepted Asks; wait for them to finish."
    }
}

function Wait-Unlocked($definition) {
    for ($n = 0; $n -lt 30; $n++) {
        if (-not (Get-LiveStatus $definition).running) { return }
        Start-Sleep -Seconds 1
    }
    throw 'The old responder still holds its lock after stopping the task.'
}

function Sync-Checkout([string]$checkout) {
    Invoke-Checked uv @('sync', '--project', $checkout, '--frozen') $root
    Invoke-Checked pnpm.cmd @('install', '--filter', 'hand', '--frozen-lockfile') $checkout
    $python = Join-Path $checkout '.venv/Scripts/python.exe'
    Invoke-Checked $python @('-m', 'codrawer_bridge.agentd.daemon', 'validate', '--config', $Config) $checkout
}

function Register-Responder($definition) {
    $python = Join-Path $definition.checkout '.venv/Scripts/python.exe'
    $argument = '-m codrawer_bridge.agentd.daemon run --config "{0}"' -f $Config
    $action = New-ScheduledTaskAction -Execute $python -Argument $argument -WorkingDirectory $definition.checkout
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $definition.task_name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

$definition = Get-Definition
switch ($Command) {
    'validate' { Write-Output "Valid: $Config"; break }
    'run' {
        $python = Join-Path $definition.checkout '.venv/Scripts/python.exe'
        if (-not (Test-Path -LiteralPath $python)) { throw "Checkout is not installed: $($definition.checkout)" }
        Invoke-Checked $python @('-m', 'codrawer_bridge.agentd.daemon', 'run', '--config', $Config) $definition.checkout
        break
    }
    'status' {
        $task = Get-ScheduledTask -TaskName $definition.task_name -ErrorAction SilentlyContinue
        [pscustomobject]@{
            task = $definition.task_name
            task_state = if ($task) { [string]$task.State } else { 'not installed' }
            checkout = $definition.checkout
            commit = if (Test-Path -LiteralPath $definition.checkout) { git -C $definition.checkout rev-parse --short HEAD } else { $null }
            runtime = Get-LiveStatus $definition
        } | ConvertTo-Json -Depth 8
        break
    }
    'install' {
        $existingTask = Get-ScheduledTask -TaskName $definition.task_name -ErrorAction SilentlyContinue
        if ($existingTask -and $existingTask.State -eq 'Running') {
            throw 'Task is already running; use update or restart after checking its health.'
        }
        if (-not (Test-Path -LiteralPath $definition.checkout)) {
            Invoke-Checked git @('-C', $definition.source, 'worktree', 'add', '--detach', $definition.checkout, $definition.ref) $root
        } else {
            $actual = (git -C $definition.checkout rev-parse --show-toplevel).Trim()
            if ([IO.Path]::GetFullPath($actual) -ne [IO.Path]::GetFullPath($definition.checkout)) {
                throw 'Configured checkout exists but is not its own Git worktree.'
            }
        }
        Sync-Checkout $definition.checkout
        Register-Responder $definition
        Write-Output "Installed $($definition.task_name) at $($definition.checkout); run restart to start it."
        break
    }
    'restart' {
        $task = Get-ScheduledTask -TaskName $definition.task_name -ErrorAction Stop
        Assert-Quiescent $definition
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $definition.task_name
            Wait-Unlocked $definition
        }
        Start-ScheduledTask -TaskName $definition.task_name
        Write-Output "Started $($definition.task_name); inspect status for connection and health."
        break
    }
    'update' {
        $task = Get-ScheduledTask -TaskName $definition.task_name -ErrorAction Stop
        $wasRunning = $task.State -eq 'Running'
        Invoke-Checked git @('-C', $definition.source, 'fetch', 'origin') $root
        $target = (git -C $definition.source rev-parse $definition.ref).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Cannot resolve $($definition.ref)" }
        $old = (git -C $definition.checkout rev-parse HEAD).Trim()
        if ($old -eq $target) { Write-Output 'Already at the configured ref.'; break }
        $candidate = "$($definition.checkout)-candidate-$($target.Substring(0, 12))"
        if (Test-Path -LiteralPath $candidate) { throw "Candidate already exists: $candidate" }
        Invoke-Checked git @('-C', $definition.source, 'worktree', 'add', '--detach', $candidate, $target) $root
        Sync-Checkout $candidate
        $python = Join-Path $candidate '.venv/Scripts/python.exe'
        Invoke-Checked $python @('-m', 'pytest', '-q', 'tests/test_agentd_service_scaffold.py', 'tests/test_agentd.py', 'tests/test_agentd_stream_pool.py') $candidate
        Assert-Quiescent $definition
        if ($wasRunning) {
            Stop-ScheduledTask -TaskName $definition.task_name
            Wait-Unlocked $definition
        }
        try {
            Invoke-Checked git @('-C', $definition.checkout, 'switch', '--detach', $target) $root
            Sync-Checkout $definition.checkout
            if ($wasRunning) { Start-ScheduledTask -TaskName $definition.task_name }
        } catch {
            Invoke-Checked git @('-C', $definition.checkout, 'switch', '--detach', $old) $root
            Sync-Checkout $definition.checkout
            if ($wasRunning) { Start-ScheduledTask -TaskName $definition.task_name }
            throw
        }
        Write-Output "Updated to $target; candidate preserved at $candidate for inspection."
        break
    }
    'uninstall' {
        $task = Get-ScheduledTask -TaskName $definition.task_name -ErrorAction SilentlyContinue
        if (-not $task) { Write-Output 'Task is not installed.'; break }
        Assert-Quiescent $definition
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $definition.task_name
            Wait-Unlocked $definition
        }
        Unregister-ScheduledTask -TaskName $definition.task_name -Confirm:$false
        Write-Output 'Task removed; checkout, configuration, and state retained.'
        break
    }
}
