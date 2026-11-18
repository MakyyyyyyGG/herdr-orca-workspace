[CmdletBinding()]
param([string]$AppHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config/herdr-app' }))

$ErrorActionPreference = 'Stop'
$pending = @()
foreach ($group in 'mods', 'layouts') {
    $source = Join-Path $PSScriptRoot $group
    foreach ($item in Get-ChildItem -LiteralPath $source -Recurse -File) {
        if ($item.Name -in 'gpui-kit.d.ts', 'jsconfig.json') { continue }
        $relative = $item.FullName.Substring($PSScriptRoot.Length + 1)
        $target = Join-Path $AppHome $relative
        if (Test-Path -LiteralPath $target) {
            if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $item.FullName).Hash) {
                throw "A different copy of $relative already exists. Back it up and move it aside before installing."
            }
        } else {
            $pending += [pscustomobject]@{ Source = $item.FullName; Target = $target }
        }
    }
}
foreach ($entry in $pending) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($entry.Target)) | Out-Null
    [IO.File]::Copy($entry.Source, $entry.Target, $false)
}
Write-Output "Orca is installed in $AppHome. In Herdr select the orca layout, or run 'herdr-app do layout.switch --name orca'."
