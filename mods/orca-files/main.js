// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, home, readTextFile, watchFolder, theme, settings, window } from "herdr";
import { createHost } from "./host.js";

const host = createHost({ exec, window });

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const normPath = path => (path || "").replace(/\\/g, "/").replace(/\/+$/, "") || (path ? "/" : "");
const pathKey = path => {
  const p = normPath(path);
  return /^[a-z]:|^\/\//i.test(p) ? p.toLowerCase() : p;
};
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
function fileColor(entry, t) {
  if (entry.dir) return t.ansi3 || "#e6bf86";
  if (/\.(jsx?|tsx?|rs|py|go|cs|java)$/i.test(entry.name)) return t.ansi4 || "#9abce9";
  if (/\.(css|scss|svg|png|jpe?g|webp)$/i.test(entry.name)) return t.ansi5 || "#bca9df";
  if (/\.(ya?ml|json|toml|env)$/i.test(entry.name)) return t.ansi2 || "#91ccbb";
  return t.dim;
}
function markColor(mark, t) {
  if (mark === "A") return t.ansi2 || t.working;
  if (mark === "D" || mark === "U") return t.ansi1 || t.blocked;
  return t.blocked;
}
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { $target = @($_.Target)[0]; $isDir = $_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $target))))); @{ name=$_.Name; dir=$isDir } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && host.isWindows()) return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.query = "";
    this.filter = InputState.new({ placeholder: "Filter by filename…" });
    this.filter.on("change", (_, ctx) => {
      this.query = this.filter.value().trim().toLowerCase();
      if (this.query && this.context) this.indexFiles(this.context, ctx);
      ctx.notify();
    });
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
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
    // Avoid watching the entire home directory or filesystem root recursively.
    const normalized = pathKey(root);
    if (!normalized || normalized === "/" || /^[a-z]:$/.test(normalized) || normalized === pathKey(home?.())) return;
    this.stopWatch();
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context && this.watched === root) {
          const handle = watchFolder(root);
          this.watchHandle = handle;
          await handle;
          if (this.current(context) && this.watched === root) this.refresh(cx);
        }
      } catch { if (this.context === context) this.stopWatch(); }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${normPath(root)}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.index = null; this.indexPending = null; this.indexTime = 0;
      if (this.query) { this.query = ""; this.filter.set_value(""); }
      this.pending = new Set(); this.marks = {}; this.show(null); this.stopWatch(); this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    if (this.query) this.indexFiles(context, cx);
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          try { await this.loadFolder(path, context); }
          catch (e) { if (!path) throw e; }
        }
        const top = await host.git(["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const topRoot = normPath(top.stdout.trim());
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await host.git(["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: topRoot, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[pathKey(`${topRoot}/${entry.slice(3)}`)] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  indexFiles(context, cx) {
    if (!context.cwd || this.indexPending === context || (this.index && Date.now() - this.indexTime < 10000)) return;
    this.indexPending = context;
    cx.spawn(async ctx => {
      const options = { cwd: context.cwd, on: context.on, timeout: 5500 };
      try {
        let result = await host.git(["ls-files", "-co", "--exclude-standard", "-z", "--", "."], options).catch(() => null);
        if (result?.code !== 0) result = await exec("rg", ["--files", "--null", "--glob", "!.git"], options).catch(() => null);
        if (!this.current(context)) return;
        this.partialIndex = result?.code !== 0;
        this.index = this.partialIndex
          ? [...this.entries].flatMap(([dir, entries]) => entries.filter(e => !e.dir).map(e => dir ? dir + "/" + e.name : e.name))
          : [...new Set(result.stdout.split("\0").filter(Boolean))].map(p => context.cwd.includes("\\") ? p.replace(/\\/g, "/") : p);
        this.indexTime = Date.now();
      } finally { if (this.indexPending === context) this.indexPending = null; ctx.notify(); }
    });
  }

  matches(t) {
    if (!this.index) return [div().p(8).text_color(t.dim).child("Finding files…")];
    const query = this.query, paths = this.index.filter(p => p.toLowerCase().includes(query));
    const rootNorm = normPath(this.root);
    const rows = paths.slice(0, 120).map(path => {
      const cut = path.lastIndexOf("/"), name = path.slice(cut + 1);
      const absPath = `${rootNorm}/${path}`, mark = this.marks[pathKey(absPath)];
      return h_flex().id("match-" + path).h(31).flex_none().px(7).gap(6).items_center().rounded(5)
        .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(path)
        .drag_paths([absPath], { on: this.on || null })
        .on_click((_, ctx) => { this.show(path, ctx); ctx.notify(); })
        .child(svg("mods/orca-files/file.svg").size(13).flex_none().text_color(fileColor({ name }, t)))
        .child(div().min_w(0).max_w(175).truncate().child(name))
        .when(cut >= 0, el => el.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(path.slice(0, cut))))
        .when(cut < 0, el => el.child(div().flex_1()))
        .when(Boolean(mark), el => el.child(div().text_size(10.5).text_color(markColor(mark, t)).child(mark)));
    });
    if (!rows.length) rows.push(div().p(8).text_color(t.dim).child("No matching files"));
    if (this.partialIndex || paths.length > rows.length) rows.push(div().p(8).text_size(11).text_color(t.dim)
      .child(this.partialIndex ? "Searching loaded folders only" : "Showing 120 of " + paths.length + " matches"));
    return rows;
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  collapseAll(cx) {
    for (const folder of [...this.folders]) this.entries.delete(folder);
    this.folders.clear();
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = normPath(this.root), on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    const rootNorm = normPath(this.root);
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      const absPath = `${rootNorm}/${path}`, mark = this.marks[pathKey(absPath)];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .drag_paths([absPath], { on: this.on || null })
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/orca-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/orca-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(fileColor(entry, t)))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(markColor(mark, t)).child(mark))));
      if (entry.dir && open) {
        if (this.pending.has(path) && !this.entries.has(path)) {
          out.push(div().id(`loading-${path}`).h(24).pl(26 + depth * 18).flex().items_center().text_size(11).text_color(t.dim).child("Loading…"));
        } else {
          this.rows(path, depth + 1, out, t);
        }
      }
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(13)
      .child(h_flex().h(32).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").px(4).py(2).rounded(4).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().text_size(11.5).text_color(t.muted).child(this.file ? "Preview" : "File tree"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? (this.entries.has("") ? String(this.entries.get("").length) + " items" : "")))
        .when(!this.file && this.folders.size > 0, el => el.child(div().id("files-collapse").px(4).py(2).rounded(4).cursor_pointer().text_size(11.5).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Collapse all folders").on_click((_e, cx) => this.collapseAll(cx)).child("⊟")))
        .when(!this.file && Boolean(this.root), el => el.child(div().id("files-refresh").px(4).py(2).rounded(4).cursor_pointer().text_size(12).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh files").on_click((_e, cx) => this.refresh(cx)).child("↻"))))
      .when(!this.file, el => el.child(h_flex().mx(8).my(6).px(8).gap(6).h(30).flex_none().rounded(6).bg(t.canvas).items_center()
        .child(svg("mods/workspace-chrome/search.svg").size(13).text_color(t.dim))
        .child(Input.new(this.filter).flex_1().h_full().text_size(12).text_color(t.foreground))
        .when(Boolean(this.query), row => row.child(div().id("clear-filter").p(4).rounded(4).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, ctx) => { this.query = ""; this.filter.set_value(""); ctx.notify(); }).child("×")))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.query ? this.matches(t) : this.rows("", 0, [], t))
        .when(!this.query && (Boolean(this.error) || !this.entries.get("")?.length), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(!this.query && this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
