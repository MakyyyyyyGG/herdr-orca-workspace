import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, checking, closeOverlay, exec, focused, layout, openOverlay, panes, props, run, shared, spaces, theme, window } from "herdr";

const icon = (name, size = 14) => svg("mods/workspace-chrome/" + name + ".svg").size(size).flex_none();
function find(node, id) {
  if (node?.id === id) return node;
  for (const item of node?.children || []) { const child = find(item, id); if (child) return child; }
}
function location() {
  const f = focused(), s = spaces().find(s => s.active), p = panes().find(p => p.pane === f?.pane);
  const on = f && f.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : s?.machine;
  return { space: s, cwd: p?.cwd || f?.cwd || s?.folder || "", branch: p?.branch, on: on || null };
}
function githubProject(remote) {
  const match = /^(?:https?:\/\/(?:[^/]*@)?github\.com\/|ssh:\/\/(?:git@)?github\.com(?::22)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)\/?$/i.exec(remote.trim());
  if (!match) return null;
  const repo = match[2].replace(/\.git$/i,"");
  if (!repo || [".",".."].includes(repo) || [".",".."].includes(match[1])) return null;
  return "https://github.com/" + match[1] + "/" + repo;
}
export default class Inspector extends View {
  init(_, cx) {
    this.width = 320;
    if (!checking() && !props()?.github) cx.timer.every(20000, ctx => this.lookup(location(), ctx));
  }
  lookup(loc, cx) {
    if (checking()) return;
    const id = JSON.stringify([loc.on, loc.cwd, loc.branch]);
    if (this.key !== id) { this.key = id; this.repo = null; this.branch = null; this.github = null; }
    if (!loc.cwd || this.pending === id) return;
    this.pending = id;
    cx.spawn(async ctx => {
      try {
        const git = !loc.on && window().platform === "windows" ? "C:/Program Files/Git/cmd/git.exe" : "git";
        const read = args => exec(git, ["-C", loc.cwd, ...args], { on: loc.on, timeout: 4500 });
        const top = await read(["rev-parse", "--show-toplevel"]);
        let branch, remoteUrl;
        if (top.code === 0) {
          branch = await read(["symbolic-ref", "--short", "-q", "HEAD"]);
          const tracked = branch.code === 0 ? await read(["config","--get","branch."+branch.stdout.trim()+".remote"]) : null;
          const name = tracked?.code === 0 && tracked.stdout.trim() !== "." ? tracked.stdout.trim() : "origin";
          remoteUrl = await read(["remote","get-url","--",name]);
        }
        if (this.key === id) {
          this.repo = top.code === 0 ? top.stdout.trim() : null;
          this.branch = branch?.code === 0 ? branch.stdout.trim() : this.repo ? "Detached HEAD" : null;
          this.github = remoteUrl?.code === 0 ? githubProject(remoteUrl.stdout) : null;
        }
      } catch {} finally { if (this.pending === id) this.pending = null; ctx.notify(); }
    });
  }
  render(cx) {
    const browserRepo = props()?.github && githubProject(props().github);
    if (browserRepo) {
      const t = theme();
      return v_flex().p(10).gap(3).bg(t.popover).text_color(t.foreground)
        .child(div().px(6).py(4).text_size(11).text_color(t.muted).child(browserRepo.slice("https://github.com/".length)))
        .children([["pulls","Pull requests"],["issues","Issues"]].map(([page,label])=>h_flex().id(page).h(30).px(7).items_center().rounded(5)
          .cursor_pointer().hover(e=>e.bg(t.hover)).on_click((_,ctx)=>{ctx.open_url(browserRepo+"/"+page);closeOverlay(props().overlay);})
          .child(div().flex_1().child(label)).child(div().text_color(t.dim).child("↗"))));
    }
    const loc = location(), t = theme(), id = JSON.stringify([loc.on, loc.cwd, loc.branch]);
    if (!checking() && this.key !== id) this.lookup(loc, cx);
    const folder = (this.repo || loc.cwd).replace(/\\/g, "/").split("/").filter(Boolean).pop() || loc.space?.name || "Workspace";
    const active = find(layout(), "panel-body")?.active || "files";
    const activity = shared("orca.runtime.local") || {};
    const running = agents().filter(a => a.space === loc.space?.id && a.status === "working" && !activity[a.address]?.exited).length;
    const norm = p => (p || "").replace(/\\/g,"/").replace(/\/+$/,"").toLowerCase();
    const root = norm(this.repo || loc.cwd), tabsHere = new Set(loc.space?.tabs?.map(tab => tab.id));
    const members = !loc.on ? panes().filter(p => tabsHere.has(p.tab) && p.terminal && (norm(p.cwd) === root ||
      (this.repo && norm(p.cwd).startsWith(root + "/")))).map(p => p.terminal) : [];
    const numbers = [...new Set(members.flatMap(id => (activity[id]?.ports || []).map(p => p.port)))];
    const motion = shared("orca.account.summary")?.motion !== false;
    const tabs = [["files","Files","files"],["changes","Changes","git-compare"]].filter(([id]) => (shared("workspace.panels") || ["files","changes"]).includes(id));
    const cell = Math.max(50,(this.width - 8) / Math.max(1,tabs.length));
    return v_flex().size_full().px(12).pt(12).gap(10).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().items_center().gap(9)
        .child(h_flex().size(32).rounded(8).bg("#30423f").justify_center().items_center().child(icon("folder",17).text_color(t.accent)))
        .child(v_flex().flex_1().min_w(0).child(div().truncate().font_family("Bahnschrift").text_size(17).tooltip(loc.cwd).child(folder))
          .child(h_flex().id("inspect-branch").gap(4).items_center()
            .when(Boolean(this.repo), el => el.cursor_pointer().tooltip("Switch checkout or agent").hover(st => st.bg(t.hover))
              .on_click(() => openOverlay({ mod: "orca-projects", kind: "dialog", width: 435, props: { checkout: this.repo, machine: loc.on } })))
            .child(icon(this.branch ? "branch" : "monitor",10).text_color(t.dim))
            .child(div().truncate().text_size(10.8).text_color(t.muted).child(this.branch || loc.branch || loc.on || "This computer")).when(Boolean(this.repo), el => el.child(icon("chevron-down", 10).text_color(t.dim)))))
        .when(Boolean(this.github), el=>el.child(div().id("repo-links").px(5).py(2).rounded(4).text_color(t.muted).cursor_pointer()
          .tooltip("Pull requests and issues on GitHub").hover(e=>e.bg(t.hover))
          .on_click(()=>openOverlay({mod:"orca-inspector",kind:"popup",width:220,height:106,props:{github:this.github}})).child("⋯")))
        .when(numbers.length > 0, el => el.child(div().id("inspect-ports").px(6).py(3).rounded(4).bg(t.canvas).text_color(t.accent).text_size(10.5)
          .cursor_pointer().tooltip("Listening TCP ports: " + numbers.join(", ")).on_click(() => openOverlay({mod:"orca-projects",kind:"dialog",width:400,props:{portProject:root,addresses:members}}))
          .child(numbers.length === 1 ? ":" + numbers[0] : numbers.length + " ports")))
        .when(running > 0, el => el.child(h_flex().gap(5).items_center().tooltip("Working agents in this space")
          .child(div().size(5).rounded(3).bg(t.working).when(motion, dot => dot.loop("opacity", { from: 0.45, to: 1, period: 1600 })))
          .child(div().text_size(10.5).text_color(t.muted).child(running + " working")))))
      .child(h_flex().id("inspector-segments").w_full().relative().h(30).px(4).rounded(7).bg(t.canvas).items_center()
        .on_size_change((s, ctx) => { if (s.width !== this.width) { this.width = s.width; ctx.notify(); } })
        .child(div().id("inspector-cursor").absolute().top(3).h(24).w(cell).left(4 + Math.max(0,tabs.findIndex(v => v[0] === active))*cell).rounded(5).bg(t.selected)
          .when(motion, el => el.transition("left", 170)))
        .children(tabs.map(([id, name, glyph]) => h_flex().id("inspect-"+id).flex_1().h(27).gap(6).justify_center().items_center().cursor_pointer()
          .text_color(active === id ? t.foreground : t.muted).on_click(() => run("layout.select",{stack:"panel-body",child:id}))
          .child(icon(glyph,12)).child(div().text_size(11.8).child(name)))));
  }
}

