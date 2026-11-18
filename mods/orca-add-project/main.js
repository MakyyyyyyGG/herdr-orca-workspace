import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { closeOverlay, exec, home, panes, pickFolder, props, run, spaces, theme, window, shared } from "herdr";
import { cloneOrReuse, comparable, repository } from "./repository.js";

const icon = (name, size) => svg("mods/workspace-chrome/" + name + ".svg").size(size).flex_none();
const git = (args, timeout = 5000) => exec(window().platform === "windows" ? "C:/Program Files/Git/cmd/git.exe" : "git", args, { timeout });

async function openProject(path) {
  const local = spaces().filter(s => !s.machine);
  const tabs = new Set(local.flatMap(s => s.tabs.map(t => t.id)));
  const candidates = panes().filter(p => p.terminal && p.cwd && tabs.has(p.tab));
  const paths = new Map(candidates.map(p => [comparable(p.cwd), p]));
  const direct = paths.get(comparable(path));
  if (direct) { run("pane.focus", { pane: direct.pane }); return; }
  const top = await git(["-C", path, "rev-parse", "--show-toplevel"]);
  if (top.code === 0) {
    const root = comparable(top.stdout.trimEnd());
    for (const [cwd, p] of paths) {
      if (cwd !== root && !cwd.startsWith(root + "/")) continue;
      const candidate = await git(["-C", p.cwd, "rev-parse", "--show-toplevel"]);
      if (candidate.code === 0 && comparable(candidate.stdout.trimEnd()) === root) {
        run("pane.focus", { pane: p.pane }); return;
      }
    }
  }
  run("space.new", { folder: path, machine: "" });
}

export default class AddProject extends View {
  init(_, cx) {
    this.parent = localStorage.getItem("clone-parent") || home().replace(/\\/g, "/") + "/Projects";
    this.url = InputState.new({ placeholder: "https://github.com/owner/repo.git" });
    this.url.on("change", (_e, ctx) => { this.error = ""; ctx.notify(); });
    this.url.on("submit", (_e, ctx) => this.submit(ctx));
    this.handle = cx.focus_handle();
    this.url.focus();
    this.stage = 0;
    cx.timer.after(120, () => this.url.focus());
  }

  dismiss() { closeOverlay(props().overlay); }

  submit(cx, local = false) {
    if (this.busy) return;
    const value = this.url.value();
    if (!local) {
      try { repository(value); } catch (e) { this.error = e.message; cx.notify(); return; }
    }
    this.busy = local ? "Choose folder…" : "Preparing checkout…"; this.error = ""; this.stage = local ? 0 : 1;
    cx.notify();
    cx.spawn(async ctx => {
      try {
        const path = local ? await pickFolder({ prompt: "Open project" }) : await cloneOrReuse(value, this.parent, git);
        if (path) {
          this.busy = "Opening workspace…"; this.stage = 2; ctx.notify();
          await openProject(path);
          this.dismiss();
          return;
        }
      } catch (e) { this.error = e.message || String(e); }
      this.busy = ""; ctx.notify();
    });
  }

  render() {
    const t = theme();
    const motion = shared("orca.account.summary")?.motion !== false;
    const button = (id, label, action, primary = false) => h_flex().id(id).h(31).px(11).gap(6).rounded(6).items_center()
      .border_1().border_color(primary ? t.accent : t.input).bg(primary ? t.accent : t.raised)
      .text_size(12).font_medium().text_color(primary ? "#171717" : t.foreground)
      .when(Boolean(this.busy), el => el.opacity(0.65))
      .when(!this.busy, el => el.cursor_pointer().hover(s => s.opacity(0.85)))
      .on_click((_, ctx) => { if (!this.busy) action(ctx); }).child(label);
    return v_flex().id("add-project").track_focus(this.handle)
      .on_key_down((e, ctx) => { if (e.key === "escape") { if (!this.busy) this.dismiss(); ctx.stop_propagation(); } })
      .w_full().p(20).gap(13).bg(t.popover).text_color(t.foreground)
      .child(h_flex().h(24).items_center().justify_between().child(h_flex().gap(10).items_center()
          .child(h_flex().size(30).rounded(7).bg("#2c4040").justify_center().items_center().child(icon("folder-plus",16).text_color(t.accent)))
          .child(div().font_family("Bahnschrift").text_size(21).child("Add project")))
        .child(div().id("dismiss").p(3).cursor_pointer().on_click(() => { if (!this.busy) this.dismiss(); }).child(icon("x", 13))))
      .child(div().text_size(12).text_color(t.muted).child("Repository URL"))
      .child(h_flex().gap(6).items_center()
        .child(Input.new(this.url).flex_1().min_w(0).h(40).px(9).bg(t.background).rounded(6).border_1().border_color(t.accent).text_size(13).text_color(t.foreground))
        .child(button("paste", "Paste", ctx => { const text = ctx.read_from_clipboard(); if (text) { this.url.set_value(text.trim()); this.url.focus(); } })))
      .child(h_flex().px(9).h(34).rounded(6).bg(t.raised).gap(7).items_center().child(icon("folder",13).text_color(t.muted)).child(div().text_size(11).text_color(t.dim).child("Clone into"))
        .child(div().flex_1().min_w(0).truncate().tooltip(this.parent).text_size(11.5).text_color(t.muted).child(this.parent))
        .child(div().id("destination").p(3).text_size(12).text_color(t.accent).cursor_pointer().child("Change…")
          .on_click((_, ctx) => { if (this.busy) return; ctx.spawn(async ctx => {
            const dir = await pickFolder({ prompt: "Choose clone destination" });
            if (dir) { this.parent = dir; localStorage.setItem("clone-parent", dir); this.error = ""; ctx.notify(); }
          }); })))
      .when(Boolean(this.error), el => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.busy), el => el.child(v_flex().gap(5)
        .child(h_flex().gap(3).children(["Folder", "Checkout", "Workspace"].map((name, i) => v_flex().flex_1().gap(5)
          .child(div().h(3).rounded(2).bg(i <= this.stage ? t.accent : t.input)
            .when(i === this.stage && motion, bar => bar.loop("opacity", { from: 0.45, to: 1, period: 1450 })))
          .child(div().text_size(10.5).text_color(i <= this.stage ? t.foreground : t.dim).child(name)))))))
      .child(h_flex().pt(10).border_t(1).border_color(t.border).items_center().gap(7)
        .child(button("folder", "Open local folder…", ctx => this.submit(ctx, true)))
        .child(div().flex_1())
        .when(Boolean(this.busy), el => el.child(icon("spinner", 14).text_color(t.accent).when(motion, s => s.spin(850))))
        .child(button("clone", this.busy || "Clone & open", ctx => this.submit(ctx), true)));
  }
}

