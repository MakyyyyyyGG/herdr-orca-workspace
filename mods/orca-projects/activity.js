const aliases = {
  antigravity:["agy","antigravity"], codex:["codex","codex-cli"], "claude-code":["claude","claude-code"], claude:["claude","claude-code"],
  gemini:["gemini","gemini-cli"], "gemini-cli":["gemini","gemini-cli"], opencode:["opencode"], aider:["aider"],
  pi:["pi","pi-coding-agent"], copilot:["copilot","github-copilot-cli"], qwen:["qwen","qwen-code"]
};
const shells = new Set(["powershell","pwsh","cmd","bash","sh","zsh","fish","nu","conhost","openconsole","windowsterminal"]);
export function exitedAgent(program, report, names) {
  if (!names?.length) return false;
  const ids = [program?.key, report?.app, typeof report === "string" ? report : null].filter(Boolean).map(x=>String(x).toLowerCase());
  const known = ids.flatMap(id => aliases[id] || []);
  if (known.some(name => names.includes(name))) return false;
  if (names.every(name => shells.has(name))) return true;
  // A script host may wrap a provider we cannot identify. Keep ambiguous sessions.
  if (!known.length || names.some(n => ["wsl","wslhost","ssh","docker","podman"].includes(n))) return false;
  return true;
}
export function endpoints(items) {
  const map = new Map();
  for (const item of items) for (const p of item.ports || []) {
    const id = [p.bind,p.port,p.pid].join("/");
    if (!map.has(id)) map.set(id,p);
  }
  return [...map.values()].sort((a,b) => a.port-b.port || a.pid-b.pid);
}
export function portLabel(ports) {
  const nums = [...new Set(ports.map(p => p.port))];
  return nums.length ? ":" + nums[0] + (nums.length > 1 ? " +" + (nums.length-1) : "") : "";
}
export const portHint = ports => ports.map(p => p.process + " · " + p.bind + ":" + p.port).join("\n");
