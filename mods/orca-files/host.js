// Shared host helpers. Herdr mods cannot import across mod folders, so every
// Orca mod carries an identical copy of this file (tests keep them in sync).
// It takes the herdr functions it needs instead of importing "herdr" so it
// stays a plain module that tests can load.

const DEFAULT_GIT = "C:/Program Files/Git/cmd/git.exe";
const caches = new WeakMap();

export function createHost({ exec, window }) {
  if (!caches.has(exec)) caches.set(exec, new Map());
  const cache = caches.get(exec);
  const platform = () => window?.()?.platform
    ?? (globalThis.process?.platform === "win32" ? "windows" : globalThis.process?.platform === "darwin" ? "macos" : "linux");
  const isWindows = () => platform() === "windows";

  // Resolve a local Windows program to an absolute path once, searching PATH
  // only (`$PATH:` keeps where.exe away from the current folder, so a program
  // planted in a cloned repository is never picked up).
  function resolve(name, fallbacks) {
    if (!cache.has(name)) cache.set(name, (async () => {
      try {
        const r = await exec("where.exe", ["$PATH:" + name], { timeout: 4000 });
        const hit = r.code === 0 && r.stdout.split(/\r?\n/).map(s => s.trim())
          .find(p => /^(?:[a-z]:|\\\\)[\\/].+\.(?:exe|cmd)$/i.test(p));
        if (hit) return hit.replace(/\\/g, "/");
      } catch {}
      for (const candidate of fallbacks) if (candidate) return candidate;
      return null;
    })());
    return cache.get(name);
  }

  async function gitPath(on) {
    if (on || !isWindows()) return "git";
    return (await resolve("git.exe", [DEFAULT_GIT])) || "git";
  }

  // exec git with the same options exec takes ({ cwd, on, timeout }).
  async function git(args, options = {}) {
    return exec(await gitPath(options.on), args, options);
  }

  return { platform, isWindows, resolve, gitPath, git };
}
