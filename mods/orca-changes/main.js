import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window } from "herdr";

import { pushBranch, pushInfo } from "./push.js";
import { sections, reviewFiles, committedFiles, committedRange } from "./review.js";
import { createHost } from "./host.js";

const host = createHost({ exec, window });

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

function badgeColor(file, t) {
  if (file.conflict || file.status === "U") return t.blocked;
  if (file.status === "A" || file.status === "?") return t.ansi2 || t.working;
  if (file.status === "D") return t.ansi1 || t.blocked;
  if (file.section === "Committed") return t.done || t.accent;
  return t.muted;
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.folds = new Set(); this.pushState = null;
    this.range = null; this.preview = null; this.code = null; this.previewError = null;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  stopWatch() {
    this.watched = null;
    this.watchHandle?.cancel?.();
    this.watchHandle = null;
  }

  async close() {
    this.stopWatch();
    this.code?.release?.();
    this.code = null;
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.stopWatch();
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const handle = watchFolder(root);
          this.watchHandle = handle;
          await handle;
          if (this.watched === root) this.refresh(cx);
        }
      } catch { if (this.watched === root) this.stopWatch(); }
    });
  }

  closePreview(cx) {
    this.code?.release?.();
    this.code = null;
    this.preview = null;
    this.previewError = null;
    cx?.notify();
  }

  openFile(file, cx) {
    if (!this.root || !file) return;
    this.code?.release?.();
    this.code = null;
    this.preview = file;
    this.previewError = null;
    const { root, on, context, range } = this;
    cx.notify();
    cx.spawn(async (ctx) => {
      try {
        const git = (args) => host.git([...READ, ...args], { cwd: root, on });
        let text = null, lang = "diff";
        if (file.section === "Uncommitted" && file.status === "?") {
          text = await readTextFile(`${root}/${file.path}`, { on });
          if (text === null) throw new Error("File is no longer available.");
          if (text.includes("\0")) throw new Error("Binary file · no text preview");
          const ext = file.path.includes(".") ? file.path.split(".").pop() : "txt";
          lang = LANG[ext] ?? ext;
        } else {
          let r;
          if (file.section === "Staged") {
            r = await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", file.path]);
          } else if (file.section === "Committed") {
            const target = range || await committedRange(git, this.pushState || {});
            if (!target) throw new Error("No outgoing commit diff available.");
            r = target.base
              ? await git(["diff", "--no-ext-diff", "--no-textconv", target.base, target.head, "--", file.path])
              : await git(["show", "--no-ext-diff", "--no-textconv", `${target.head}:${file.path}`]);
            if (!target.base) {
              const ext = file.path.includes(".") ? file.path.split(".").pop() : "txt";
              lang = LANG[ext] ?? ext;
            }
          } else {
            r = await git(["diff", "--no-ext-diff", "--no-textconv", "--", file.path]);
          }
          if (r.code !== 0) throw new Error(r.stderr || "Cannot read diff.");
          text = r.stdout;
          if (!text.trim()) {
            text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
            if (!text) throw new Error("No textual diff for this change.");
            const ext = file.path.includes(".") ? file.path.split(".").pop() : "txt";
            lang = LANG[ext] ?? ext;
          }
        }
        if (this.preview !== file || this.context !== context) return;
        const t = theme();
        this.code = EditorState.new({
          language: lang,
          readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (diff truncated)" : text,
          font_family: settings().font_family,
          font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 }
        });
      } catch (e) {
        if (this.preview === file && this.context === context) {
          this.previewError = e.message || String(e);
        }
      } finally { ctx.notify(); }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.folds.clear();
      this.pushState = null; this.range = null; this.remote = null; this.error = null; this.note = null;
      this.stopWatch();
      this.closePreview();
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await host.git(["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.pushState = null; this.range = null; this.files = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => host.git([...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const entries = status.stdout.split("\0").filter(Boolean);
        const destination = await pushInfo(git,this.remote);
        const range = await committedRange(git,destination);
        const committed = await committedFiles(git,destination);
        if (key() !== context) return;
        this.pushState = destination;
        this.range = range;
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
        const message = await pushBranch((args,timeout) => host.git(args,{cwd:root,on,timeout:timeout || 5000}),pushState);
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
        .cursor_pointer().hover(e=>e.bg(t.hover)).on_click((_,ctx)=>this.toggle(id,ctx))
        .child(div().w(9).text_color(t.dim).child(closed ? "›" : "⌄"))
        .child(div().text_size(11.5).font_medium().text_color(section==="Staged" ? t.working : t.foreground).child(section))
        .child(div().text_size(10).px(4).rounded(3).bg(t.raised).text_color(t.muted).child(String(files.length))));
      if (closed) continue;
      for (const file of files.slice(0,1000)) {
        const name = file.path.split("/").pop();
        rows.push(h_flex().id(section+":"+file.path).h(26).pl(20).pr(8).flex_none().gap(6).items_center().rounded(4)
          .cursor_pointer().hover(e=>e.bg(t.hover))
          .tooltip(file.conflict ? file.path + " · Merge conflict" : file.path)
          .on_click((_,ctx)=>this.openFile(file,ctx))
          .child(div().flex_1().min_w(0).truncate().text_size(12).when(file.conflict,e=>e.text_color(t.blocked)).child(name))
          .when(Boolean(file.status && file.status !== "C"), e => e.child(div().text_size(10.5).text_color(badgeColor(file, t)).child(file.status))));
      }
      if (files.length > 1000) rows.push(div().px(20).text_size(10).text_color(t.dim).child("Showing the first 1,000 files"));
    }
    return rows;
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const push = this.pushState, enabled = Boolean(push?.ready && !this.busy && !this.loading);
    if (this.preview) {
      return v_flex().id("changes").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(13)
        .child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().id("changes-back").px(4).py(2).rounded(4).cursor_pointer().text_color(t.muted).hover(e=>e.bg(t.hover).text_color(t.foreground))
            .on_click((_,ctx)=>this.closePreview(ctx)).child("←"))
          .child(div().text_size(11).px(5).py(1).rounded(4).bg(t.raised).text_color(t.muted).child(this.preview.section))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).tooltip(this.preview.path).child(this.preview.path)))
        .child(div().flex_1().min_h(0).child(this.code ? Editor.new(this.code).size_full() : div().p(12).text_size(12).text_color(this.previewError ? t.blocked : t.dim).child(this.previewError || "Loading diff…")));
    }
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
