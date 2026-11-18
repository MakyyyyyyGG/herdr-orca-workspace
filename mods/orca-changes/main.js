import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, window } from "herdr";

import { pushBranch, pushInfo } from "./push.js";
import { sections, reviewFiles, recentCommits, committedFiles } from "./review.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const gitBin = on => !on && window().platform === "windows" ? "C:/Program Files/Git/cmd/git.exe" : "git";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0, inHunk = false;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (line.startsWith("diff --git ")) { inHunk = false; return { kind: "@", text: line }; }
    if (match) { old = +match[1]; next = +match[2]; inHunk = true; return { kind: "@", text: line }; }
    if (!inHunk) return { kind: "", text: line };
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.fileCount = 0; this.files = []; this.commits = []; this.rows = []; this.diffWidth = 0; this.pushState = null;
    this.mode = "changes"; this.folds = new Set(); this.committed = []; this.committedTotal = 0;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.fileCount = 0; this.files = []; this.commits = []; this.open = null; this.committed = []; this.committedTotal = 0; this.folds.clear();
      this.setLines([]); this.pushState = null; this.remote = null; this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec(gitBin(on), ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.pushState = null; this.fileCount = 0; this.files = []; this.commits = []; this.committed = []; this.committedTotal = 0; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec(gitBin(on), [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const entries = status.stdout.split("\0").filter(Boolean);
        const files = reviewFiles(entries.slice(0, 1000));
        const [destination, commits] = await Promise.all([pushInfo(git,this.remote), recentCommits(git)]);
        const committed = await committedFiles(git,destination,commits[0]);
        if (key() !== context) return;
        this.pushState = destination; this.commits = commits; this.committed = committed.files.slice(0,1000); this.committedTotal = committed.files.length; this.committedLabel = committed.label;
        this.root = root; this.on = on; this.fileCount = entries.length; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !commits.some((f) => f.id === this.open)) { this.open = null; this.setLines([]); }
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(id, context) {
    const commit = this.commits.find(c => c.id === id);
    if (this.mode !== "commits" || !commit) return;
    const args = commit.parent ? ["diff", commit.parent, commit.oid] : ["show", "--format=", "--root", commit.oid];
    const r = await exec(gitBin(this.on), [...READ, ...args, "--patch", "--no-ext-diff", "--no-textconv", "--no-color", "--"], {cwd:this.root,on:this.on});
    if (r.code !== 0) throw Error(r.stderr);
    let lines = r.stdout.trimEnd() ? r.stdout.trimEnd().split("\n") : ["This commit has no file changes."];
    if (lines.length > 1500) lines = [...lines.slice(0,1499), "Preview limited to 1,500 lines."];
    if (key() === context && this.open === id) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  push(cx) {
    if (!this.pushState?.ready || this.busy || this.loading || key() !== this.context) return;
    const {root,on,context,pushState} = this;
    this.busy = true; this.note = null; cx.notify();
    cx.spawn(async ctx => {
      try {
        const message = await pushBranch((args,timeout) => exec(gitBin(on),args,{cwd:root,on,timeout:timeout || 5000}),pushState);
        if (key() === context) { this.note = message; this.failed = false; }
      } catch(e) {
        if (key() === context) { this.note = e.message || String(e); this.failed = true; }
      } finally { this.busy = false; this.refresh(ctx); ctx.notify(); }
    });
  }

  switchMode(mode, cx) {
    if (mode === this.mode) return;
    this.mode = mode; this.open = null; this.setLines([]); this.note = null;
    cx.notify();
  }

  toggle(id,cx) {
    if (this.folds.has(id)) this.folds.delete(id); else this.folds.add(id);
    cx.notify();
  }

  fileRows(t) {
    const rows = [];
    for (const section of [...sections,"Committed"]) {
      const files = section === "Committed" ? this.committed : this.files.filter(f=>f.section===section);
      if (!files.length) continue;
      const id = "group-"+section, closed = this.folds.has(id);
      rows.push(h_flex().id(id).h(28).flex_none().px(5).gap(6).items_center().border_b(1).border_color(t.border)
        .cursor_pointer().on_click((_,ctx)=>this.toggle(id,ctx))
        .child(div().w(9).text_color(t.dim).child(closed ? "›" : "⌄"))
        .child(div().text_size(11.5).font_medium().text_color(section==="Staged" ? t.working : section==="Conflicts" ? t.blocked : t.foreground).child(section))
        .child(div().text_size(10).px(4).rounded(3).bg(t.raised).text_color(t.muted).child(String(section==="Committed" ? this.committedTotal : files.length)))
        .when(section==="Committed",e=>e.child(div().flex_1().min_w(0).truncate().text_right().text_size(10).text_color(t.dim).child(this.committedLabel))));
      if (closed) continue;
      for (const file of files) {
        rows.push(div().id("change-"+file.id).h(26).px(20).flex_none().flex().items_center()
          .child(div().min_w(0).truncate().text_size(12).child(file.path.split("/").pop())));
      }
    }
    if(this.limited || this.committedTotal>1000)rows.push(div().p(6).text_size(10).text_color(t.dim).child("Showing up to 1,000 files per list"));
    if(!rows.length && !this.error)rows.push(div().p(8).text_color(t.dim).child(this.root ? "No file changes" : this.loading ? "Loading changes…" : "No folder"));
    return rows;
  }

  historyRows(t) {
    const rows = [div().px(7).py(4).text_size(11).text_color(t.muted).child("Recent commits")];
    for (const c of this.commits) rows.push(v_flex().id(c.id).h(42).flex_none().px(7).justify_center().rounded(5).cursor_pointer()
      .when(this.open===c.id,e=>e.bg(t.selected)).hover(e=>e.bg(t.hover)).on_click((_,ctx)=>this.pick(c.id,ctx))
      .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(12).child(c.subject))
        .child(div().text_size(10).text_color(t.accent).child(c.oid.slice(0,7))))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(c.author+" · "+c.date)));
    if(!this.commits.length)rows.push(div().p(7).text_color(t.dim).child(this.root ? "No commits yet" : "No repository"));
    return rows;
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(8).flex_none().text_color(kind === "+" ? t.ansi2 : t.ansi1).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const push = this.pushState, enabled = Boolean(push?.ready && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .children([["changes","Changes",this.fileCount],["commits","Commits",push?.ahead]].map(([mode,title,count]) =>
          h_flex().id("review-"+mode).h(27).px(8).gap(5).items_center().rounded(6).cursor_pointer()
            .when(this.mode === mode,e => e.bg(t.raised).border_1().border_color(t.border))
            .text_color(this.mode === mode ? t.foreground : t.muted)
            .on_click((_,ctx) => this.switchMode(mode,ctx)).child(title)
            .when(Number.isInteger(count) && (mode==="commits" || count>0),e => e.child(div().px(4).rounded(3).bg(t.canvas).text_size(10)
              .tooltip(mode==="commits" ? "Outgoing commits" : "Changed files").child(String(count))))))
        .child(div().flex_1()).child(div().id("refresh-review").px(6).py(2).rounded(4).cursor_pointer().hover(e=>e.bg(t.hover))
          .tooltip("Refresh Git status and history").on_click((_,ctx)=>this.refresh(ctx)).child("↻")))
      .child(div().flex_1().min_h(40).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("review-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(this.mode==="changes" ? this.fileRows(t) : this.historyRows(t))
          .when(Boolean(this.error),e=>e.child(div().p(6).text_color(t.blocked).child(this.error))))
        .child(Scrollbar.vertical("review-list").absolute().inset_0()))
      .when(this.mode === "commits" && Boolean(this.open), el => el.child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(this.note), e => e.child(div().px(10).py(5).text_size(11.5).text_color(this.failed ? t.blocked : t.working).child(this.note)))
      .child(h_flex().p(10).flex_none().gap(8).items_center().border_t(1).border_color(t.border)
        .child(v_flex().min_w(0).flex_1().gap(3)
          .child(div().id("push-target").truncate().font_medium().text_size(12).text_color(t.foreground)
            .when((push?.remotes?.length || 0) > 1, el => el.cursor_pointer().tooltip("Choose the next remote").on_click((_,ctx) => {
              if (this.busy || this.loading) return;
              this.remote = push.remotes[(push.remotes.indexOf(push.remote)+1)%push.remotes.length]; this.note = null; this.refresh(ctx);
            })).child(push?.remote ? push.remote + "/" + push.destName + (push.remotes.length > 1 ? "  ↻" : "") : push?.branch || "Push branch"))
          .child(div().text_size(10.5).text_color(t.dim).child(push?.message || (this.loading ? "Reading branch…" : "Open a repository to push."))))
        .child(h_flex().id("push").h(31).px(10).rounded(6).items_center().text_size(12)
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
          .tooltip("Push existing local commits on this branch").when(enabled, el => el.cursor_pointer().hover(s=>s.opacity(0.87)))
          .on_click((_,ctx) => this.push(ctx)).child(this.busy ? "Pushing…" : "Push branch")));
  }
}
