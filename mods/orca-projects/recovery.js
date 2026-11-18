// Core keeps labels across shell replacement. Only the shell that armed a
// checkpoint can disarm it when its foreground agent exits normally.
export function checkpoint(row, saved) {
  const next = row.codexPid ? row.root + "/" + row.codexPid : "";
  if (!next && row.names?.includes("codex")) return null;
  if (next === saved || (!next && !saved.startsWith(row.root + "/"))) return null;
  return next;
}
