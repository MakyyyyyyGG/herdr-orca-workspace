$ErrorActionPreference = 'Stop'
$cmd = Get-Command codex.exe -ErrorAction SilentlyContinue
if (-not $cmd) { $cmd = Get-Command codex -ErrorAction Stop }
$start = New-Object Diagnostics.ProcessStartInfo
if ($cmd.Source -match '\.(cmd|bat)$') {
    $start.FileName = 'cmd.exe'
    $start.Arguments = '/d /c ""' + $cmd.Source + '" app-server --stdio"'
} else {
    $start.FileName = $cmd.Source
    $start.Arguments = 'app-server --stdio'
}
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$client = [Diagnostics.Process]::Start($start)
try {
    $client.BeginErrorReadLine()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    function Read-Reply([int]$id) {
        while ($clock.ElapsedMilliseconds -lt 14000) {
            $next = $client.StandardOutput.ReadLineAsync()
            if (-not $next.Wait([Math]::Max(1, 14000 - [int]$clock.ElapsedMilliseconds))) { break }
            if ($null -eq $next.Result) { break }
            $reply = $next.Result | ConvertFrom-Json
            if ($reply.id -eq $id) {
                if ($reply.error) { throw 'Codex could not report account limits.' }
                return $reply.result
            }
        }
        throw 'Codex did not respond before the timeout.'
    }
    $client.StandardInput.WriteLine('{"method":"initialize","id":1,"params":{"clientInfo":{"name":"herdr_usage","title":"Herdr usage bar","version":"1.0"}}}')
    $null = Read-Reply 1
    $client.StandardInput.WriteLine('{"method":"initialized"}')
    $client.StandardInput.WriteLine('{"method":"account/rateLimits/read","id":2,"params":{}}')
    $limits = Read-Reply 2
    $pool = $limits.rateLimitsByLimitId.codex
    if (-not $pool) { $pool = $limits.rateLimits }
    $windows = foreach ($bucket in @($pool.primary, $pool.secondary)) {
        if ($null -ne $bucket.usedPercent) {
            [pscustomobject]@{ used = $bucket.usedPercent; minutes = $bucket.windowDurationMins; reset = $bucket.resetsAt }
        }
    }
    $animation = $true
    try {
        $sig = '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref bool pvParam, uint fWinIni);'
        $win = Add-Type -MemberDefinition $sig -Name WinAnim -Namespace OrcaWin32 -PassThru
        $enabled = $true
        if ($win::SystemParametersInfo(0x1042, 0, [ref]$enabled, 0)) { $animation = $enabled }
    } catch {}
    [pscustomobject]@{
        windows = @($windows)
        balance = $pool.credits.balance
        unlimited = $pool.credits.unlimited
        motion = $animation
    } | ConvertTo-Json -Depth 4 -Compress
} finally {
    if (-not $client.HasExited) {
        $client.StandardInput.Close()
        if (-not $client.WaitForExit(1500)) { $client.Kill() }
    }
    $client.Dispose()
}
