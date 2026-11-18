import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window } from "herdr";

import { pushBranch, pushInfo } from "./push.js";
import { sections, reviewFiles, committedFiles } from "./review.js";

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

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.folds = new Set(); this.pushState = null;
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
      this.context = context; this.root = null; this.files = []; this.folds.clear();
      this.pushState = null; this.remote = null; this.error = null; this.note = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec(gitBin(on), ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.pushState = null; this.files = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec(gitBin(on), [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const entries = status.stdout.split("\0").filter(Boolean);
        const destination = await pushInfo(git,this.remote);
        const committed = await committedFiles(git,destination);
        if (key() !== context) return;
        this.pushState = destination;
        this.root = root; this.on = on; this.files = [...reviewFiles(entries), ...committed]; this.error = null;
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
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

  toggle(id,cx) {
    if (this.folds.has(id)) this.folds.delete(id); else this.folds.add(id);
    cx.notify();
  }

  fileRows(t) {
    const rows = [];
    if (!this.root) return this.error ? [] : [div().p(8).text_color(t.dim).child(this.loading ? "Loading changes…" : "No folder")];
    for (const section of sections) {
      const files = this.files.filter(file => file.section === section);
      const id = "group-"+section, closed = this.folds.has(id);
      rows.push(h_flex().id(id).h(28).flex_none().px(5).gap(6).items_center().border_b(1).border_color(t.border)
        .cursor_pointer().on_click((_,ctx)=>this.toggle(id,ctx))
        .child(div().w(9).text_color(t.dim).child(closed ? "›" : "⌄"))
        .child(div().text_size(11.5).font_medium().text_color(section==="Staged" ? t.working : t.foreground).child(section))
        .child(div().text_size(10).px(4).rounded(3).bg(t.raised).text_color(t.muted).child(String(files.length))));
      if (closed) continue;
      for (const file of files.slice(0,1000)) {
        rows.push(div().id(section+":"+file.path).h(26).px(20).flex_none().flex().items_center()
          .child(div().min_w(0).truncate().text_size(12).when(file.conflict,e=>e.text_color(t.blocked).tooltip("Merge conflict")).child(file.path.split("/").pop())));
      }
      if (files.length > 1000) rows.push(div().px(20).text_size(10).text_color(t.dim).child("Showing the first 1,000 files"));
    }
    return rows;
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const push = this.pushState, enabled = Boolean(push?.ready && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(div().flex_1().min_h(40).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("review-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(this.fileRows(t))
          .when(Boolean(this.error),e=>e.child(div().p(6).text_color(t.blocked).child(this.error))))
        .child(Scrollbar.vertical("review-list").absolute().inset_0()))
      .when(Boolean(this.note), e => e.child(div().px(10).py(5).text_size(11.5).text_color(this.failed ? t.blocked : t.working).child(this.note)))
      .child(h_flex().p(10).flex_none().gap(8).items_center().border_t(1).border_color(t.border)
        .child(v_flex().min_w(0).flex_1().gap(3)
          .child(div().id("push-target").truncate().font_medium().text_size(12).text_color(t.foreground)
            .when((push?.remotes?.length || 0) > 1, el => el.cursor_pointer().tooltip("Choose the next remote").on_click((_,ctx) => {
              if (this.busy || this.loading) return;
              this.remote = push.remotes[(push.remotes.indexOf(push.remote)+1)%push.remotes.length]; this.note = null; this.refresh(ctx);
            })).child(push?.remote ? push.remote + "/" + push.destName + (push.remotes.length > 1 ? "  ↻" : "") : push?.branch || "Push branch"))
          .child(div().text_size(10.5).text_color(t.dim).child(push?.message || (this.loading ? "Reading branch…" : "Open a repository to push."))))
        .child(div().id("refresh-review").px(6).py(2).rounded(4).cursor_pointer().hover(e=>e.bg(t.hover))
          .tooltip("Refresh Git status").on_click((_,ctx)=>this.refresh(ctx)).child("↻"))
        .child(h_flex().id("push").h(31).px(10).rounded(6).items_center().text_size(12)
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
          .tooltip("Push existing local commits on this branch").when(enabled, el => el.cursor_pointer().hover(s=>s.opacity(0.87)))
          .on_click((_,ctx) => this.push(ctx)).child(this.busy ? "Pushing…" : "Push branch")));
  }
}
