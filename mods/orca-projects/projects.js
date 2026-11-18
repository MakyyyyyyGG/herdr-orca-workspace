export function normalize(path) {
  if (typeof path !== "string" || !path) return "";
  const slashes = path.replace(/\\/g, "/");
  if (/^[a-z]:\/+$/i.test(slashes)) return slashes.slice(0, 3);
  return slashes.replace(/\/+$/, "") || "/";
}
export const basename = path => normalize(path).split("/").pop() || path || "Home";
export const key = (machine, path) => JSON.stringify([machine ?? null, /^[a-z]:|^\/\//i.test(path) ? path.toLowerCase() : path]);

export function parseWorktrees(output) {
  return output.split("\0\0").filter(Boolean).map(block => {
    const fields = block.split("\0");
    const get = prefix => fields.find(f => f.startsWith(prefix))?.slice(prefix.length);
    return {
      path: normalize(get("worktree ")), branch: get("branch refs/heads/"),
      detached: fields.includes("detached") ? get("HEAD ")?.slice(0, 8) : null,
      bare: fields.includes("bare"), prunable: fields.some(f => /^prunable(?: |$)/.test(f))
    };
  }).filter(tree => tree.path);
}

// An unkept child has no pane. Follow its parent chain to find its space,
// but use its own terminal cwd to place it when it works in another checkout.
export function locations(spaces, panes, agents, terminals, activity = {}) {
  const live = new Map(terminals.filter(t => t.state === "live").map(t => [t.address, t]));
  const byPane = new Map(panes.map(p => [p.pane, p]));
  const byTab = new Map(spaces.flatMap(s => (s.tabs || []).map(t => [t.id, s])));
  const items = [];
  const owners = new Map();
  const listed = new Map(agents.map(a => [a.address, a]));
  for (const p of panes) {
    const space = byTab.get(p.tab);
    if (!space || !p.terminal) continue;
    const terminal = live.get(p.terminal);
    const agent = activity[p.terminal]?.exited ? null : listed.get(p.terminal) || (p.program?.agent ? {
      address: p.terminal, pane: p.pane, status: p.status, title: p.title, program: p.program
    } : null);
    const item = { space, terminal: p.terminal, ports: activity[p.terminal]?.ports, pane: p.pane, path: normalize(p.cwd || terminal?.cwd || space.folder), branch: p.branch,
      parent: terminal?.parent, agent };
    items.push(item);
    owners.set(p.terminal, item);
  }
  for (const a of agents) if (!owners.has(a.address) && !activity[a.address]?.exited) {
    const space = spaces.find(s => s.id === a.space);
    if (!space) continue;
    const item = { space, terminal: a.address, ports: activity[a.address]?.ports, pane: a.pane, agent: a, parent: live.get(a.address)?.parent,
      path: normalize(live.get(a.address)?.cwd || byPane.get(a.pane)?.cwd || space.folder) };
    items.push(item); owners.set(a.address, item);
  }
  function owner(address, seen) {
    if (owners.has(address)) return owners.get(address);
    const term = live.get(address);
    if (!term?.parent || seen.has(address)) return null;
    seen.add(address);
    const parent = owner(term.parent, seen);
    if (!parent) return null;
    const item = { space: parent.space, terminal: address, ports: activity[address]?.ports, agent: activity[address]?.exited ? null : term, parent: term.parent, path: normalize(term.cwd || parent.path) };
    items.push(item); owners.set(address, item);
    return item;
  }
  for (const t of live.values()) if (t.parent) owner(t.address, new Set());
  for (const space of spaces) if (!items.some(i => i.space.id === space.id)) items.push({ space, path: normalize(space.folder), branch: space.branch });
  return items;
}

export function groupProjects(items, repos) {
  const groups = new Map();
  for (const item of items) {
    const machine = item.space.machine;
    const info = repos.get(key(machine, item.path));
    const root = info?.main || item.path;
    const id = key(machine, root);
    if (!groups.has(id)) groups.set(id, { id, root, machine, checkouts: new Map() });
    const group = groups.get(id);
    function add(tree) {
      const k = key(machine, tree.path);
      if (!group.checkouts.has(k)) group.checkouts.set(k, { ...tree, entries: new Map() });
      return group.checkouts.get(k);
    }
    for (const tree of info?.trees || []) if (!tree.bare && !tree.prunable) add(tree);
    const checkout = add({ path: info?.top || item.path, branch: item.branch });
    if (!checkout.branch && !checkout.detached && item.branch) checkout.branch = item.branch;
    if (!checkout.entries.has(item.space.id)) checkout.entries.set(item.space.id, { space: item.space, items: [] });
    checkout.entries.get(item.space.id).items.push(item);
  }
  return [...groups.values()];
}

