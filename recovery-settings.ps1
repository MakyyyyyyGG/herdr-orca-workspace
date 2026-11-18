# Installs just the Windows integration. The regular Orca installer owns the mod files.
param([Parameter(Mandatory)][string]$AppHome, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $AppHome 'mods/orca-projects/resume.ps1'
$profilePath = $PROFILE.CurrentUserAllHosts
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$hooksPath = Join-Path $codexDir 'hooks.json'
$profileLine = "if (`$env:HC_TERMINAL_ID -and (Test-Path -LiteralPath '$($scriptPath.Replace("'","''"))')) { & '$($scriptPath.Replace("'","''"))' }"
$psExe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$hookCommand = '"{0}" -NoProfile -NonInteractive -File "{1}" -Record' -f $psExe,$scriptPath

function Save-Settings($path, $value) {
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
    $stage = "$path.$([guid]::NewGuid()).tmp"
    try {
        [IO.File]::WriteAllText($stage, $value, [Text.UTF8Encoding]::new($path -eq $profilePath))
        if ([IO.File]::Exists($path)) {
            [IO.File]::Replace($stage, $path, "$path.orca-$(Get-Date -Format yyyyMMdd-HHmmssfff).bak")
        } else { [IO.File]::Move($stage, $path) }
    } finally { if ([IO.File]::Exists($stage)) { [IO.File]::Delete($stage) } }
}
$oldProfile = if ([IO.File]::Exists($profilePath)) { [IO.File]::ReadAllText($profilePath) } else { '' }
$hasLine = ($oldProfile -split '\r?\n') -ccontains $profileLine
$config = if ([IO.File]::Exists($hooksPath)) { [IO.File]::ReadAllText($hooksPath) | ConvertFrom-Json } else { [pscustomobject]@{} }
if (!$config.PSObject.Properties['hooks']) { $config | Add-Member hooks ([pscustomobject]@{}) }
$changed = $false
foreach ($event in 'SessionStart','UserPromptSubmit') {
    $groups = @($config.hooks.$event | Where-Object { $null -ne $_ })
    $ours = @($groups | Where-Object { $_.hooks.Count -eq 1 -and $_.hooks[0].command -ceq $hookCommand })
    if (($Remove -and !$ours.Count) -or (!$Remove -and $ours.Count)) { continue }
    $groups = @($groups | Where-Object { $_ -notin $ours })
    if (!$Remove) { $groups += @{ hooks = @(@{ type = 'command'; command = $hookCommand; timeout = 5 }) } }
    $config.hooks | Add-Member -Force -NotePropertyName $event -NotePropertyValue $groups
    $changed = $true
}
if ($changed) { Save-Settings $hooksPath (($config | ConvertTo-Json -Depth 100) + [Environment]::NewLine) }
if ($Remove -and $hasLine) {
    Save-Settings $profilePath ([regex]::Replace($oldProfile, '(?m)^' + [regex]::Escape($profileLine) + '\r?$\n?', ''))
} elseif (!$Remove -and !$hasLine) {
    Save-Settings $profilePath ($oldProfile + [Environment]::NewLine + $profileLine + [Environment]::NewLine)
}
