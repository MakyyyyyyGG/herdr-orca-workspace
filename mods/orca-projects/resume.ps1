# Called from the root PowerShell profile in Herdr, or from a Codex session hook.
param([switch]$Record)

if ($env:HC_TERMINAL_ID -notmatch '^t[a-z0-9]+$') { return }
$core = Join-Path $env:LOCALAPPDATA 'Programs/herdr-core/hc.exe'
if (!(Test-Path -LiteralPath $core)) { return }
$address = $env:HC_TERMINAL_ID
$uuid = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}'
try {
    $term = & $core get $address --json 2>$null | ConvertFrom-Json
    if (!$term.keep -or $term.state -ne 'live') { return }
    if ($Record) {
        $event = [Console]::In.ReadToEnd() | ConvertFrom-Json
        if ($event.session_id -notmatch "^$uuid$" -or $event.hook_event_name -notin 'SessionStart','UserPromptSubmit') { return }
        if ($term.foreground.name -ne 'codex.exe') { return }
        $client = $term.foreground.pid
        & $core label $address "orca.codexPane=$($term.pid)/$client" "orca.codexThread=$client/$($event.session_id)" | Out-Null
        return
    }
    if ($term.pid -ne $PID -or !$term.labels.'orca.codexPane') { return }
    $mark = $term.labels.'orca.codexPane'
    if ($mark -notmatch '^(\d+)/(\d+)$') { return }
    $client = $Matches[2]
    $arguments = @('resume')
    if ($term.labels.'orca.codexThread' -match "^$client/($uuid)$") { $arguments += $Matches[1] }
    $codex = Get-Command codex.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $core label $address 'orca.codexPane=' 'orca.codexThread=' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not claim the saved terminal.' }
    & $codex.Source @arguments
} catch {
    if (!$Record) { Write-Warning "Herdr could not resume this agent. $($_.Exception.Message)" }
}
