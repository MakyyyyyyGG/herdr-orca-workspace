import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, appHome, checking, closeOverlay, exec, focused, hc, home, layout, openOverlay, panes, props, run, setAgentOrder, setShared, shared, spaces, terminals, theme, window } from "herdr";
import { normalize, basename, key, parseWorktrees, locations, groupProjects } from "./projects.js";

import { webAddress } from "./web-port.js";
import { exitedAgent, endpoints, portLabel, portHint } from "./activity.js";

const asset = (name, size) => svg("mods/workspace-chrome/" + name + ".svg").size(size).flex_none();
const statusLabel = { working: "Working", idle: "Idle", done: "Done", blocked: "Needs you", error: "Needs you" };
const runtime = "orca.runtime.local";
const portKey = p => JSON.stringify([p.bind,p.port,p.pid]);
const itemsNow = () => locations(spaces(), panes(), agents(), terminals(), shared(runtime) || {});
const menu = space => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space.id } } });

export default class Projects extends View {
  init(_, cx) {
    this.repos = new Map();
    if (props()?.portProject) {
      this.protocols = new Map();
      if (!checking()) cx.timer.every(10000, ctx => this.inspectPorts(ctx));
    }
    this.folded = new Set();
    if (props()?.checkout) this.pick = { path: normalize(props().checkout), space: { machine: props().machine || null } };
    if (!checking() && !props()?.portProject) {
      if (!this.pick && window().platform === "windows") {
        this.roots = new Map();
        this.sample(cx);
        cx.timer.every(4000, ctx => this.sample(ctx));
      }
      this.scan(cx);
      cx.timer.every(2500, ctx => this.scan(ctx));
    }
  }

  sample(cx) {
    if (this.sampling) return;
    this.sampling = true;
    cx.spawn(async ctx => {
      try {
        const all = terminals(), ps = panes(), ag = agents();
        const items = locations(spaces(), ps, ag, all);
        const owned = new Set(items.map(i => i.terminal));
        const local = all.filter(t => t.state === "live" && !t.address.includes("/") && owned.has(t.address));
        for (const a of this.roots.keys()) if (!owned.has(a)) this.roots.delete(a);
        const ids = new Map();
        for (const t of local) {
          let id = Number(t.pid || this.roots.get(t.address));
          if (!id) {
            const result = await hc(["get", t.address, "--json"]);
            if (result.code === 0) id = Number(JSON.parse(result.stdout).pid);
          }
          if (Number.isSafeInteger(id) && id > 0) { this.roots.set(t.address,id); ids.set(t.address,id); }
        }
        const next = {};
        if (ids.size) {
          const r = await exec("powershell.exe", ["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",appHome()+"/mods/orca-projects/listeners.ps1",[...new Set(ids.values())].join(",")], { timeout: 9000 });
          if (r.code !== 0) throw Error("Process information unavailable");
          const rows = new Map(JSON.parse(r.stdout).map(row => [row.root,row]));
          for (const term of local) {
            const row = rows.get(ids.get(term.address));
            if (!row) { this.roots.delete(term.address); continue; }
            const a = ag.find(a => a.address === term.address);
            const p = ps.find(p => p.terminal === term.address);
            next[term.address] = { exited: exitedAgent(a?.program || p?.program || term.program, a?.app || term.report, row.names), ports: row.ports };
          }
        }
        if (JSON.stringify(shared(runtime)) !== JSON.stringify(next)) setShared(runtime,next);
      } catch { if (Object.keys(shared(runtime) || {}).length) setShared(runtime,{}); }
      finally { this.sampling = false; ctx.notify(); }
    });
  }

  scan(cx) {
    if (this.looking) return;
    const paths = new Map();
    for (const item of [...itemsNow(), ...(this.pick ? [this.pick] : [])]) if (item.path) paths.set(key(item.space.machine, item.path), item);
    for (const id of this.repos.keys()) if (!paths.has(id)) this.repos.delete(id);
    const todo = [...paths].filter(([id, item]) => {
      const old = this.repos.get(id);
      return !old || old.hint !== item.branch || Date.now() - old.time > (old.main ? 15000 : 60000);
    });
    if (!todo.length) return;
    this.looking = true;
    cx.spawn(async ctx => {
      try {
        const lists = new Map();
        for (const [id, item] of todo) {
          const on = item.space.machine;
          const git = !on && window().platform === "windows" ? "C:/Program Files/Git/cmd/git.exe" : "git";
          let info = this.repos.get(id);
          try {
            const read = args => exec(git, ["-C", item.path, ...args], { on, timeout: 4500 });
            const r = await read(["rev-parse", "--show-toplevel"]);
            if (r.code === 0) {
              const top = normalize(r.stdout.trimEnd());
              let trees = lists.get(key(on, top));
              if (!trees) {
                const list = await read(["worktree", "list", "--porcelain", "-z"]);
                if (list.code === 0) {
                  trees = parseWorktrees(list.stdout);
                  for (const t of trees) lists.set(key(on, t.path), trees);
                }
              }
              if (trees?.length) info = { top, main: trees[0].path, trees };
              else info ??= { top, main: top, trees: [] };
            } else if (/not a git repository/i.test(r.stderr)) info = {};
          } catch {}
          this.repos.set(id, { ...info, hint: item.branch, time: Date.now() });
        }
      } finally { this.looking = false; ctx.notify(); }
    });
  }

  agentRow(a, depth, t) {
    const program = a.program || {};
    const state = a.status === "error" ? "blocked" : a.status;
    const title = (a.title || a.name || "").replace(/^\[ [!.] \]\s*/, "").trim();
    const generic = !title || title === a.address || /^(?:[a-z]:[\\/]|\/|~[\\/])/i.test(title);
    const name = generic ? [program.name, a.address].filter(Boolean).join(" · ") : title;
    const record = this.core.get(a.address), stamp = record?.labels?.["orca.sleep"];
    const sleeping = Boolean(stamp && state !== "working" && (record?.turn == null || stamp.split("/")[1] === String(record.turn)));
    const actions = () => openOverlay({ mod: "orca-agent-actions", kind: "dialog", width: 365,
      props: { target: { address: a.address, name, pane: a.pane, created: record?.created_ms } } });
    const selected = focused()?.terminal === a.address || focused()?.shown === a.address;
    return h_flex().id("agent-" + a.address).h(25).px(5).ml(8 + Math.min(depth, 4) * 10).gap(6).rounded(5).items_center()
      .when(selected, el => el.bg(t.selected)).hover(el => el.bg(t.hover)).cursor_pointer()
      .tooltip([program.name, name, statusLabel[state] || state, a.address].filter(Boolean).join(" · "))
      .on_mouse_down("right", (_, ctx) => { ctx.stop_propagation(); actions(); })
      .on_click(() => sleeping ? actions() : run(a.pane ? "pane.focus" : "terminal.peek", a.pane ? { pane: a.pane } : { terminal: a.address }))
      .child(div().size(6).rounded(3).flex_none().bg(t[state] || t.dim)
        .when(state === "working" && shared("orca.account.summary")?.motion !== false, dot => dot.loop("opacity", { from: 0.35, to: 1, period: 1500 })))
      .when(Boolean(program.icon), el => el.child(program.tint ? svg(program.icon).size(13).flex_none().text_color(t.foreground) : image(program.icon).size(13).flex_none()))
      .child(div().flex_1().min_w(0).truncate().text_size(11.8).text_color(t.foreground).child(name))
      .child(div().text_size(10).text_color(t.muted).child(sleeping ? "Sleeping" : statusLabel[state] || "Live"))
      .child(div().id("more-" + a.address).px(4).rounded(4).text_size(13).text_color(t.muted).tooltip("Agent actions")
        .hover(el => el.bg(t.raised)).on_click((_,ctx) => { ctx.stop_propagation(); actions(); }).child("⋯"));
  }

  section(group, t, compact, order) {
    const here = focused();
    const trees = [...group.checkouts.values()];
    const entries = trees.flatMap(c => [...c.entries.values()]);
    const ports = endpoints(entries.flatMap(e => e.items));
    const selectedEntry = entries.find(e => e.items.some(i => (i.pane && i.pane === here?.pane) || (i.agent && i.agent.address === here?.shown)));
    const primary = selectedEntry || entries.find(e => e.space.active) || entries[0];
    const go = entry => {
      const item = entry.items.find(i => i.pane === here?.pane) || entry.items.find(i => i.pane) || entry.items[0];
      if (item.pane) run("pane.focus", { pane: item.pane });
      else if (item.agent) run("terminal.peek", { terminal: item.agent.address });
      else run("space.select", { id: entry.space.id });
    };
    const folder = !group.machine && key(null, group.root) === key(null, normalize(home())) ? "Home" : basename(group.root);
    const folded = this.folded.has(group.id);
    const head = h_flex().id("folder-" + group.id).px(compact ? 2 : 6).h(30).gap(6).items_center().rounded(6)
      .hover(el => el.bg(t.hover)).cursor_pointer().tooltip(group.root || folder)
      .on_click(() => go(primary)).on_mouse_down("right", () => menu(primary.space))
      .child(asset("folder", 15).text_color("#eac490")).when(!compact, el => el
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).text_color(t.foreground).child(folder))
        .when(ports.length > 0, row => row.child(div().id("ports-" + group.id).px(5).py(2).rounded(4).bg(t.canvas).text_size(10.5).text_color(t.accent)
          .tooltip(portHint(ports)).on_click((_, ctx) => { ctx.stop_propagation(); openOverlay({ mod: "orca-projects", kind:"dialog", width:400, props:{ portProject: group.id, addresses: entries.flatMap(e => e.items.map(i => i.terminal).filter(Boolean)) } }); }).child(portLabel(ports))))
        .child(div().id("fold-" + group.id).p(4).on_click((_, ctx) => {
          ctx.stop_propagation();
          if (folded) this.folded.delete(group.id); else this.folded.add(group.id);
          ctx.notify();
        }).child(asset(folded ? "chevron-right" : "chevron-down", 11).text_color(t.muted))));
    const card = v_flex().flex_none().px(compact ? 2 : 5).py(3).mb(4).rounded(7)
      .when(Boolean(selectedEntry), el => el.bg(t.raised).border_1().border_color(t.input)).child(head);
    if (compact) return card;
    const rows = [];
    let height = 0;
    const label = (id, text, icon, hint, action, space, suffix) => {
      rows.push(h_flex().id(id).ml(7).px(5).h(23).flex_none().gap(5).items_center().rounded(4)
        .tooltip(hint).cursor_pointer().hover(el => el.bg(t.hover)).on_click(action)
        .when(Boolean(space), el => el.on_mouse_down("right", () => menu(space)))
        .child(asset(icon, 12).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(11.6).text_color(t.foreground).child(text))
        .when(Boolean(suffix), el => el.child(div().text_size(10).text_color(t.dim).child(suffix))));
      height += 23;
    };
    for (const checkout of trees) {
      const checkoutId = key(group.machine, checkout.path);
      const occupants = [...checkout.entries.values()];
      const top = occupants.find(e => e === selectedEntry) || occupants.find(e => e.space.active) || occupants[0];
      const linked = checkoutId !== group.id;
      if (checkout.branch || checkout.detached || linked) {
        const text = checkout.branch || (checkout.detached ? "Detached · " + checkout.detached : basename(checkout.path));
        label("checkout-" + checkoutId, text, "branch", checkout.path, () => {
          if (top) go(top);
          else run("space.new", { folder: checkout.path, machine: group.machine || "" });
        }, top?.space, linked ? (basename(checkout.path) === text ? "worktree" : basename(checkout.path) + " · worktree") : "");
      }
      for (const entry of occupants) {
        const s = entry.space;
        if (s.named || occupants.length > 1) label("space-" + s.id + checkoutId, s.named ? s.name : "Space " + s.index, "layers", checkout.path, () => go(entry), s);
        const members = entry.items.filter(i => i.agent);
        const local = new Set(members.map(i => i.agent.address));
        const drawn = new Set();
        const draw = (i, depth) => {
          if (drawn.has(i.agent.address)) return;
          drawn.add(i.agent.address);
          if (!folded) order.push(i.agent.address);
          rows.push(this.agentRow(i.agent, depth, t).flex_none());
          height += 25;
          for (const child of members) if (child.parent === i.agent.address) draw(child, depth + 1);
        };
        const indent = checkout.branch || checkout.detached || linked || s.named || occupants.length > 1 ? 1 : 0;
        for (const i of members) if (!local.has(i.parent)) draw(i, indent);
        for (const i of members) if (!drawn.has(i.agent.address)) draw(i, indent);
      }
    }
    return card.child(v_flex().id("contents-" + group.id).flex_none().overflow_hidden()
      .h(folded ? 0 : height).when(shared("orca.account.summary")?.motion !== false, el => el.transition("height", 170)).children(rows));
  }

  currentPorts() {
    const active = shared(runtime) || {};
    return endpoints((props().addresses || []).map(address => active[address] || {}));
  }

  inspectPorts(cx) {
    if (!this.protocols || checking() || this.probing) return;
    const rows = this.currentPorts();
    const keys = new Set(rows.map(portKey));
    for (const k of this.protocols.keys()) if (!keys.has(k)) this.protocols.delete(k);
    const due = rows.filter(p => Date.now() - (this.protocols.get(portKey(p))?.at || 0) > 30000);
    if (!due.length) return;
    this.probing = true;
    // Expired proofs do not leave a browser action on an unverified endpoint.
    for (const p of due) this.protocols.delete(portKey(p));
    cx.spawn(async ctx => {
      try {
        let i = 0;
        const probe = async () => {
          while (i < due.length) {
            const p = due[i++], k = portKey(p);
            const present = () => this.currentPorts().some(v => portKey(v) === k);
            const url = await webAddress(p, args => exec("curl.exe",args,{timeout:3500}), present).catch(() => null);
            if (present()) this.protocols.set(k,{url,at:Date.now()});
            ctx.notify();
          }
        };
        await Promise.all(Array.from({length:Math.min(due.length,3)},probe));
      } finally { this.probing = false; ctx.notify(); }
    });
  }

  browse(port, cx) {
    if (this.webBusy || !this.protocols?.get(portKey(port))?.url) return;
    this.webBusy = port; this.webError = ""; cx.notify();
    const present = () => {
      const activity = shared(runtime) || {};
      return (props().addresses || []).some(a => activity[a]?.ports?.some(p => p.port === port.port && p.pid === port.pid && p.bind === port.bind));
    };
    cx.spawn(async ctx => {
      try {
        const url = await webAddress(port,args => exec("curl.exe",args,{timeout:3500}),present);
        ctx.open_url(url);
      } catch (e) { this.protocols.set(portKey(port),{url:null,at:Date.now()}); this.webError = e.message || String(e); }
      finally { this.webBusy = null; ctx.notify(); }
    });
  }

  picker(t, tree) {
    const { path, space } = this.pick, on = space.machine, id = key(on, path);
    const info = this.repos.get(id);
    const group = tree.find(g => g.id === key(on, info?.main || path) || g.checkouts.has(id));
    const trees = info?.trees?.filter(c => !c.bare && !c.prunable) || [];
    const choose = (c, i) => {
      closeOverlay(props().overlay);
      if (i?.pane) run("pane.focus", { pane: i.pane });
      else if (i?.agent) run("terminal.peek", { terminal: i.agent.address });
      else if (i?.space) run("space.select", { id: i.space.id });
      else run("space.new", { folder: c.path, machine: on || "" });
    };
    return v_flex().w_full().p(16).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_size(16).child("Switch checkout"))
        .child(div().id("dismiss-picker").p(4).cursor_pointer().on_click(() => closeOverlay(props().overlay)).child(asset("x", 14))))
      .child(v_flex().id("checkout-list").max_h(380).overflow_y_scrollbar().children(trees.map(c => {
        const entries = [...(group?.checkouts.get(key(on, c.path))?.entries.values() || [])];
        const items = entries.flatMap(e => e.items), members = items.filter(i => i.agent);
        return v_flex().py(4).gap(2).child(h_flex().id("pick-" + c.path).h(29).px(7).rounded(5).gap(7).items_center()
          .bg(key(on,c.path) === id ? t.selected : t.popover).cursor_pointer().hover(el => el.bg(t.hover)).tooltip(c.path)
          .on_click(() => choose(c, items.find(i => i.pane === focused()?.pane) || items.find(i => i.pane) || items[0]))
          .child(asset("branch", 13).text_color(t.accent)).child(div().flex_1().min_w(0).truncate().child(c.branch || "Detached · " + c.detached))
          .child(div().text_size(10.5).text_color(t.dim).child(basename(c.path))))
          .children(members.map(i => h_flex().id("pick-agent-" + i.agent.address).ml(20).px(7).h(24).gap(6).rounded(4).items_center()
            .cursor_pointer().hover(el => el.bg(t.hover)).on_click(() => choose(c, i))
            .child(div().size(6).rounded(3).bg(t[i.agent.status] || t.dim))
            .child(div().min_w(0).flex_1().truncate().text_size(12).child((i.agent.program?.name || "Agent") + " · " + i.agent.address))
            .child(div().text_size(10).text_color(t.muted).child(statusLabel[i.agent.status] || "Live"))));
      })).when(!trees.length, el => el.child(div().p(8).text_color(t.muted).child(info ? "No available checkouts" : "Reading worktrees…"))));
  }

  render(cx) {
    const t = theme();
    this.core = new Map(terminals().map(term => [term.address, term]));
    const tree = groupProjects(itemsNow(), this.repos);
    if (props()?.portProject) {
      this.inspectPorts(cx);
      const rows = this.currentPorts();
      return v_flex().w_full().p(15).gap(8).bg(t.popover).text_color(t.foreground)
        .child(h_flex().items_center().child(div().flex_1().font_semibold().child("Listening ports")).child(div().id("dismiss").p(4).cursor_pointer().on_click(() => closeOverlay(props().overlay)).child(asset("x",14))))
        .child(v_flex().id("port-list").max_h(300).overflow_y_scrollbar().children(rows.map(p => h_flex().gap(8).h(27).items_center()
          .child(div().text_size(12).text_color(t.accent).child(p.bind + ":" + p.port)).child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(p.process + " · PID " + p.pid))
          .when(Boolean(this.protocols.get(portKey(p))?.url), row => row.child(div().id("browse-"+p.bind+p.port+p.pid).px(6).py(3).rounded(5).bg(t.raised).text_size(11).text_color(t.accent).cursor_pointer()
            .on_click((_, ctx) => this.browse(p,ctx)).child(this.webBusy?.pid === p.pid && this.webBusy?.port === p.port ? "Checking…" : "Open in browser ↗")))))
          .when(!rows.length,el => el.child("No listening ports")))
        .when(Boolean(this.webError), el => el.child(div().text_size(11.5).text_color(t.blocked).child(this.webError)));
    }
    if (this.pick) return this.picker(t, tree);
    const sidebar = layout()?.children?.flatMap(n => [n, ...(n.children || [])]).find(n => n.id === "sidebar");
    const compact = (sidebar?.size?.px || 280) < 160;
    const sections = [], order = [];
    for (const machine of [...new Set(tree.map(g => g.machine))]) {
      const mine = tree.filter(g => g.machine === machine);
      if (!compact) sections.push(h_flex().h(27).mb(4).px(8).gap(7).items_center().rounded(6).bg(t.surface)
        .child(asset(machine ? "server" : "monitor", 13).text_color(t.muted))
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(machine || "This computer"))
        .child(div().text_size(10).text_color(t.dim).child(String(mine.length))));
      sections.push(...mine.map(g => this.section(g, t, compact, order)));
    }
    setAgentOrder(order);
    return v_flex().size_full().min_h(0).bg(t.chrome)
      .child(h_flex().h(32).px(compact ? 4 : 12).items_center().justify_between()
        .when(!compact, el => el.child(div().text_size(11.5).font_medium().text_color(t.muted).child("Projects")))
        .when(!compact, el => el.child(div().flex_1()))
        .when(!compact && Boolean(shared("orca.closed-agents")?.length), el => el.child(div().id("closed-agents").p(4).cursor_pointer().tooltip("Closed agents")
          .on_click(() => openOverlay({ mod: "orca-agent-actions", kind: "dialog", width: 365 })).child(asset("archive",14).text_color(t.muted))))
        .child(div().id("open-project").p(4).rounded(4).tooltip("Add project from URL or folder").cursor_pointer().hover(el => el.bg(t.hover))
          .on_click(() => run("mod.open", { name: "orca-add-project" })).child(asset("folder-plus", 15).text_color(t.muted))))
      .child(v_flex().id("project-list").flex_1().min_h(0).px(compact ? 2 : 8).overflow_y_scrollbar().children(sections));
  }
}

