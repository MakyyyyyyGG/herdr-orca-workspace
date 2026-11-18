import { appHome, exec, home, readTextFile, window, writeTextFile } from "herdr";
import { createHost } from "./host.js";

const host = createHost({ exec, window });
const settingsPath = () => home() + "/.gemini/antigravity-cli/settings.json";
const number = v => (typeof v === "number" || (typeof v === "string" && v.trim())) && Number.isFinite(Number(v)) ? Number(v) : null;
const names = { "Gemini Models": "Gemini", "Claude and GPT models": "Claude/GPT", "Gemini 4 Argon": "Argon" };
export const minutesLabel = minutes => minutes && minutes % 1440 === 0 ? minutes / 1440 + "d" : minutes && minutes % 60 === 0 ? minutes / 60 + "h" : minutes ? minutes + "m" : "Limit";

async function agyPath() {
  if (!host.isWindows()) return "agy";
  return (await host.resolve("agy.exe", [home() + "/AppData/Local/agy/bin/agy.exe"])) || "agy.exe";
}

async function google(command) {
  const r = await exec(await agyPath(), ["--print-timeout", "15s", "--output-format", "json", "-p", "/" + command], { timeout: 20000 });
  if (r.code !== 0) throw Error("Antigravity unavailable");
  const out = JSON.parse(r.stdout);
  if (out.command?.name !== command) throw Error("Missing account response");
  return out.command.data;
}

async function codex() {
  if (host.isWindows()) {
    const file = appHome() + "/mods/orca-usage/codex-limits.ps1";
    const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { timeout: 19000 });
    if (r.code !== 0) throw Error("Codex unavailable");
    return JSON.parse(r.stdout);
  }
  const script = `printf '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"herdr_usage","title":"Herdr usage bar","version":"1.0"}}}\\n{"method":"initialized"}\\n{"method":"account/rateLimits/read","id":2,"params":{}}\\n' | codex app-server --stdio`;
  const r = await exec("sh", ["-lc", script], { timeout: 15000 });
  if (r.code !== 0) throw Error("Codex unavailable");
  const reply = r.stdout.split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(m => m?.id === 2);
  if (!reply || reply.error) throw Error("Codex unavailable");
  const pool = reply.result?.rateLimitsByLimitId?.codex || reply.result?.rateLimits;
  const windows = [pool?.primary, pool?.secondary].filter(b => b && b.usedPercent != null)
    .map(b => ({ used: b.usedPercent, minutes: b.windowDurationMins, reset: b.resetsAt }));
  return { windows, balance: pool?.credits?.balance, unlimited: pool?.credits?.unlimited, motion: true };
}

function decode(text) {
  const obj = text === null ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw Error("Invalid Antigravity settings");
  return obj;
}
function preference(obj) {
  const v = obj.useG1Credits;
  if (v == null || v === false || v === "off") return false;
  if (v === true || v === "on") return true;
  throw Error("Unknown Antigravity credit setting");
}
export async function creditPreference() { return preference(decode(await readTextFile(settingsPath()))); }
export async function changePreference(expected, next) {
  const path = settingsPath(), raw = await readTextFile(path), obj = decode(raw);
  if (preference(obj) !== expected) throw Error("This setting changed in Antigravity. Refresh and try again.");
  obj.useG1Credits = typeof obj.useG1Credits === "string" ? (next ? "on" : "off") : next;
  await writeTextFile(path, JSON.stringify(obj, null, 2) + "\n", raw);
}

export async function snapshot() {
  const [c, quotas, credits, preference] = await Promise.allSettled([codex(), google("usage"), google("credits"), creditPreference()]);
  const cd = c.status === "fulfilled" ? c.value : null;
  const agQuotas = quotas.status === "fulfilled" ? quotas.value : null;
  const ag = credits.status === "fulfilled" ? credits.value : null;
  const groups = [];
  if (cd) {
    groups.push({
      name: "Codex",
      provider: "Codex",
      windows: (cd.windows || []).filter(b => number(b.used) !== null)
        .map(b => ({ label: minutesLabel(b.minutes), left: 100 - Number(b.used), end: b.reset ? b.reset * 1000 : null }))
    });
  }
  for (const group of agQuotas?.groups || []) {
    groups.push({
      name: names[group.name] || group.name,
      provider: "Antigravity",
      windows: (group.buckets || []).filter(b => !b.disabled && number(b.remaining_fraction) !== null)
        .map(b => ({ label: b.window === "weekly" ? "7d" : b.window || b.name, left: Number(b.remaining_fraction) * 100, end: Date.parse(b.reset_time) || null }))
    });
  }
  return {
    groups,
    motion: cd?.motion !== false,
    checked: Date.now(),
    codex: {
      available: Boolean(cd),
      balance: number(cd?.balance),
      unlimited: cd?.unlimited === true,
      error: c.status === "rejected" ? "Sign in to Codex CLI to view Codex limits and credits." : null
    },
    google: {
      available: Boolean(agQuotas || ag),
      balance: number(ag?.remaining_credits),
      fallback: preference.status === "fulfilled" ? preference.value : null,
      manage: typeof ag?.upgrade_uri === "string" && /^https:\/\/(?:antigravity\.google|one\.google\.com)\//i.test(ag.upgrade_uri) ? ag.upgrade_uri : null,
      error: quotas.status === "rejected" && credits.status === "rejected" ? "Sign in to Antigravity CLI (agy) to view Google quota." : null
    }
  };
}
