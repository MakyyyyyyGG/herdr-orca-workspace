param([string]$RootIds)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$roots = @($RootIds.Split(',') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$procs = @{}
$children = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine) {
    $id = [int]$p.ProcessId
    $procs[$id] = $p
    $parent = [int]$p.ParentProcessId
    if (!$children.ContainsKey($parent)) { $children[$parent] = [Collections.Generic.List[int]]::new() }
    $children[$parent].Add($id)
}
$ports = @{}
$net = & "$env:SystemRoot/System32/netstat.exe" -ano -p TCP
$net6 = & "$env:SystemRoot/System32/netstat.exe" -ano -p TCPv6
foreach ($line in @($net) + @($net6)) {
    if ($line -notmatch '^\s*TCP\s+(.+):([0-9]+)\s+\S+\s+LISTENING\s+([0-9]+)\s*$') { continue }
    $bind = $Matches[1]; $port = [int]$Matches[2]; $owner = [int]$Matches[3]
    if (!$ports.ContainsKey($owner)) { $ports[$owner] = [Collections.Generic.List[object]]::new() }
    $ports[$owner].Add(@{ bind=$bind; port=$port; pid=$owner; process=$procs[$owner].Name })
}
$rows = foreach ($root in $roots) {
    if (!$procs.ContainsKey($root)) { continue }
    $queue = [Collections.Generic.Queue[int]]::new()
    $seen = [Collections.Generic.HashSet[int]]::new()
    $names = [Collections.Generic.HashSet[string]]::new()
    $listeners = [Collections.Generic.List[object]]::new()
    $queue.Enqueue($root)
    while ($queue.Count) {
        $id = $queue.Dequeue()
        if (!$seen.Add($id)) { continue }
        $p = $procs[$id]
        $name = [IO.Path]::GetFileNameWithoutExtension($p.Name).ToLowerInvariant()
        $null = $names.Add($name)
        if ($name -in @('node','bun','deno','python','python3','uv','uvx')) {
            # Only executable/module paths identify a JS/Python agent. Never return its arguments.
            if ($p.CommandLine -match '(?i)^\s*(?:"[^"]+"|\S+)\s+(?:--?[\w=-]+\s+)*(?:"([^"]+)"|(\S+))') {
                $scriptPath = ($Matches[1] + $Matches[2]).Replace('\','/')
                foreach ($part in ($scriptPath -split '/')) {
                    $tag = ($part -replace '\.(js|cjs|mjs|py|exe)$','').ToLowerInvariant()
                    if ($tag -in @('claude-code','claude','codex','gemini-cli','gemini','opencode','antigravity','agy','aider','pi-coding-agent','copilot','qwen-code')) { $null=$names.Add($tag) }
                }
            }
        }
        if ($ports.ContainsKey($id)) { foreach ($endpoint in $ports[$id]) { $listeners.Add($endpoint) } }
        foreach ($child in $children[$id]) {
            if ($child -ne $id -and $procs[$child].CreationDate -ge $p.CreationDate -and $roots -notcontains $child) { $queue.Enqueue($child) }
        }
    }
    @{ root=$root; names=@($names | Sort-Object); ports=$listeners.ToArray() }
}
ConvertTo-Json -Compress -Depth 5 -InputObject @($rows)
