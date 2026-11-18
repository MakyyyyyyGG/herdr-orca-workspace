import { comparable } from "./repository.js";

// Repository discovery is optional when opening an existing local directory.
async function gitRoot(folder, git) {
  try {
    const result = await git(["-C", folder, "rev-parse", "--show-toplevel"]);
    return result.code === 0 ? comparable(result.stdout.trimEnd()) : "";
  } catch {
    return "";
  }
}

export async function openProject(folder, spaces, panes, git, run) {
  const local = spaces.filter(space => !space.machine);
  const tabs = new Set(local.flatMap(space => (space.tabs || []).map(tab => tab.id)));
  const candidates = panes.filter(pane => pane.terminal && pane.cwd && tabs.has(pane.tab));
  const path = comparable(folder);
  const direct = candidates.find(pane => comparable(pane.cwd) === path);
  if (direct) return run("pane.focus", { pane: direct.pane });

  const existing = local.find(space => space.folder && comparable(space.folder) === path);
  if (existing) return run("space.select", { id: existing.id });

  const root = candidates.length && await gitRoot(folder, git);
  if (root) {
    for (const pane of candidates) {
      const cwd = comparable(pane.cwd);
      if (cwd !== root && !cwd.startsWith(root.replace(/\/$/, "") + "/")) continue;
      if (await gitRoot(pane.cwd, git) === root) return run("pane.focus", { pane: pane.pane });
    }
  }
  return run("space.new", { folder, machine: "" });
}
