[CmdletBinding()]
param(
    [string]$AppHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config/herdr-app' }),
    [switch]$Force,
    [switch]$Backup,
    [switch]$Switch,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
    $removed = 0
    foreach ($rel in @('layouts/orca.json', 'layouts/orca.svg')) {
        $target = Join-Path $AppHome $rel
        if (Test-Path -LiteralPath $target) {
            Remove-Item -LiteralPath $target -Force
            $removed++
        }
    }
    foreach ($dir in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'mods') -Directory) {
        $targetDir = Join-Path $AppHome (Join-Path 'mods' $dir.Name)
        if (Test-Path -LiteralPath $targetDir) {
            Remove-Item -LiteralPath $targetDir -Recurse -Force
            $removed++
        }
    }
    Write-Output "Removed $removed Orca item(s) from $AppHome."
    exit 0
}

$pending = @()
foreach ($group in 'mods', 'layouts') {
    $source = Join-Path $PSScriptRoot $group
    foreach ($item in Get-ChildItem -LiteralPath $source -Recurse -File) {
        if ($item.Name -in 'gpui-kit.d.ts', 'jsconfig.json') { continue }
        $relative = $item.FullName.Substring($PSScriptRoot.Length + 1)
        $target = Join-Path $AppHome $relative
        if (Test-Path -LiteralPath $target) {
            if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $item.FullName).Hash) {
                if (-not $Force) {
                    throw "A different copy of $relative already exists. Re-run with -Force (and optionally -Backup) to update it."
                }
                $pending += [pscustomobject]@{ Source = $item.FullName; Target = $target; Action = 'Update' }
            }
        } else {
            $pending += [pscustomobject]@{ Source = $item.FullName; Target = $target; Action = 'Install' }
        }
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$installed = 0
$updated = 0
foreach ($entry in $pending) {
    if ($entry.Action -eq 'Update' -and $Backup) {
        $bak = "$($entry.Target).bak-$stamp"
        [IO.File]::Copy($entry.Target, $bak, $true)
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($entry.Target)) | Out-Null
    [IO.File]::Copy($entry.Source, $entry.Target, [bool]$Force)
    if ($entry.Action -eq 'Update') { $updated++ } else { $installed++ }
}

Write-Output "Orca installed in $AppHome ($installed new, $updated updated)."

if ($Switch) {
    $herdr = Get-Command herdr-app -ErrorAction SilentlyContinue
    if (-not $herdr) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Programs/herdr-app/herdr-app.exe'
        if (Test-Path -LiteralPath $candidate) { $herdr = $candidate }
    } else { $herdr = $herdr.Source }
    if ($herdr) {
        & $herdr do layout.switch --name orca
    } else {
        Write-Warning "Could not locate herdr-app to switch layouts automatically. Run 'herdr-app do layout.switch --name orca'."
    }
} else {
    Write-Output "In Herdr select the orca layout, or run 'herdr-app do layout.switch --name orca'."
}
