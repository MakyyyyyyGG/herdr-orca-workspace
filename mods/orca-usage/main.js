import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, nextCommand, openOverlay, props, run, shared, setShared, theme, window } from "herdr";
import { changePreference, creditPreference, snapshot } from "./account.js";
import { createHost } from "./host.js";

const host = createHost({ exec, window });
const cache = "orca.account.summary";
const busyKey = "orca.account.refreshing";
const colors = { Codex: "#84d6c4", Gemini: "#a6c5f5", "Claude/GPT": "#f2bc8a", Argon: "#b5a2eb", Antigravity: "#b5a2eb" };
const ink = name => colors[name] || colors.Antigravity;
const clamp = n => Math.max(0, Math.min(100, n));
const icon = (name, px = 14) => svg("mods/workspace-chrome/" + name + ".svg").size(px).flex_none();
const logo = (name, px) => image("icons/" + (name === "Codex" ? "codex" : "antigravity") + ".svg").size(px).flex_none();
const money = account => {
  if (account?.unlimited) return "Unlimited";
  if (typeof account?.balance !== "number") return "Unavailable";
  const rounded = account.balance.toFixed(2).replace(/\.00$/, "");
  const [whole, fraction] = rounded.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? "." + fraction : "");
};
function until(end) {
  if (!end) return "";
  const m = Math.ceil((end - Date.now()) / 60000);
  if (m <= 0) return "Reset due";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h >= 24 ? Math.floor(h / 24) + "d " + h % 24 + "h" : h + "h " + m % 60 + "m";
}
const open = tab => openOverlay({ mod: "orca-usage", kind: "dialog", width: 566, props: { tab } });
const label = (str, size, color) => div().text_size(size).text_color(color).child(str);
const action = (id, text, cb, t) => h_flex().id(id).px(9).h(26).rounded(6).items_center().bg(t.raised)
  .text_size(11.5).text_color(t.foreground).cursor_pointer().hover(el => el.bg(t.hover)).on_click(cb).child(text);

export default class Usage extends View {
  init(_, cx) {
    this.width = 1200; this.track = 246; this.ready = false;
    this.tab = props()?.tab || "limits";
    cx.timer.after(100, ctx => { this.ready = true; ctx.notify(); });
    if (checking() || props()?.overlay) return;
    setShared(busyKey, 0);
    this.refresh(cx);
    cx.timer.every(60000, ctx => { if (Date.now() - (this.checked || 0) > 294000) this.refresh(ctx); ctx.notify(); });
    cx.spawn(async ctx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(ctx);
        if (command === "credits") open("credits");
      }
    });
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    setShared(busyKey, Date.now());
    cx.spawn(async ctx => {
      try { setShared(cache, await snapshot()); this.checked = Date.now(); }
      finally { this.busy = false; setShared(busyKey, 0); ctx.notify(); }
    });
  }

  meter(id, value, width, height, color, t, motion) {
    const track = div().w(width).h(height).rounded(height / 2).flex_none().overflow_hidden().bg(t.input);
    const target = width * clamp(value) / 100;
    return track.child(div().id(id).h(height).rounded(height / 2).bg(color)
      .w(this.ready || !motion ? target : 0).when(motion, el => el.transition("width", 380)));
  }

  setFallback(cx, before) {
    if (this.saving || typeof before !== "boolean") return;
    this.saving = true; this.error = ""; cx.notify();
    cx.spawn(async ctx => {
      try {
        await changePreference(before, !before);
        const data = shared(cache);
        if (data) setShared(cache, { ...data, google: { ...data.google, fallback: !before } });
        run("orca-usage.refresh");
      } catch (e) {
        this.error = String(e.message || e);
        try { const value = await creditPreference(), d = shared(cache); if (d) setShared(cache, { ...d, google: { ...d.google, fallback: value } }); } catch {}
      } finally { this.saving = false; ctx.notify(); }
    });
  }

  balance(provider, account, t) {
    const headingFont = host.isWindows() ? "Bahnschrift" : undefined;
    const accent = ink(provider);
    return v_flex().flex_1().min_w(0).gap(5).p(12).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().gap(7).items_center().child(logo(provider, 15)).child(label(provider, 12, t.foreground)))
      .child(h_flex().items_center().gap(7)
        .child(div().when(Boolean(headingFont), el => el.font_family(headingFont)).font_semibold().text_size(25).text_color(account?.available === false ? t.dim : accent).child(money(account)))
        .when(typeof account?.balance === "number" && !account.unlimited, el => el.child(label("credits", 11, t.muted))))
      .when(Boolean(account?.error), el => label(account.error, 10.5, t.dim));
  }

  limits(d, t) {
    const rows = [];
    for (const group of d.groups || []) {
      const windows = group.windows.length ? [...group.windows].sort((a,b) => (a.end || Infinity) - (b.end || Infinity)) : [null];
      windows.forEach((w, i) => {
        const title = w?.label === "7d" ? "Weekly" : w?.label === "5h" ? "5-hour" : w?.label || "";
        const color = w && w.left <= 15 ? t.blocked : ink(group.name);
        rows.push(h_flex().id("limit-" + group.name + i).h(32).flex_none().gap(9).items_center()
          .child(div().w(84).truncate().text_size(12).text_color(t.foreground).child(i ? "" : group.name))
          .child(div().w(45).text_size(11).text_color(t.muted).child(title))
          .child(w ? this.meter("fill-" + group.name + i, w.left, this.track, 6, color, t, d.motion !== false) : div().w(this.track).child(label("Unavailable", 11, t.dim)))
          .child(div().w(34).text_right().text_size(12).text_color(w && w.left <= 15 ? t.blocked : t.foreground).child(w ? Math.round(w.left) + "%" : ""))
          .child(div().flex_1().text_right().text_size(11).text_color(t.muted).child(until(w?.end))));
      });
    }
    const emptyMsg = d.checked ? "No signed-in provider CLIs reported quota limits." : "Reading provider limits…";
    return v_flex().id("limits-page").gap(2).child(h_flex().h(27).items_center()
      .child(label("Remaining allowance", 12, t.muted)).child(div().flex_1()).child(label("Resets in", 11, t.dim)))
      .children(rows).when(!rows.length, el => el.child(div().py(8).child(label(emptyMsg, 12, t.muted))));
  }

  credits(d, t) {
    const pref = d.google?.fallback;
    const canChange = typeof pref === "boolean" && typeof d.google?.balance === "number";
    const row = (title, detail, button) => v_flex().py(8).gap(4)
      .child(h_flex().items_center().gap(10).child(div().flex_1().font_medium().text_size(13).child(title)).child(button))
      .child(label(detail, 12, t.muted));
    return v_flex().gap(4)
      .child(row("Codex credits", "Available credits can cover eligible use after your plan allowance runs out.",
        action("manage-codex", "Usage & billing ↗", (_, ctx) => ctx.open_url("https://chatgpt.com/codex/settings/usage"), t)))
      .child(div().h(1).w_full().bg(t.border))
      .child(row("Antigravity credit fallback", "Allow Antigravity to use personal credits after your plan quota runs out.",
        h_flex().id("fallback").gap(6).items_center()
          .when(canChange && !this.saving, el => el.cursor_pointer().on_click((_, ctx) => this.setFallback(ctx, pref)))
          .child(label(this.saving ? "Saving…" : canChange ? (pref ? "On" : "Off") : "Unavailable", 11, t.muted))
          .child(div().w(30).h(17).rounded(9).relative().bg(pref ? ink("Antigravity") : t.input)
            .child(div().id("fallback-thumb").absolute().top(3).left(pref ? 16 : 3).size(11).rounded(6).bg(t.foreground)
              .when(d.motion !== false, el => el.transition("left", 160))))))
      .when(Boolean(d.google?.manage), el => el.child(h_flex().child(action("manage-google", "Manage Google credits ↗", (_, ctx) => ctx.open_url(d.google.manage), t))))
      .when(Boolean(this.error), el => el.child(label(this.error, 11, t.blocked)));
  }

  dialog(d, t, refreshing) {
    const chips = [["limits","Limits"],["credits","Credit controls"]];
    const headingFont = host.isWindows() ? "Bahnschrift" : undefined;
    return v_flex().id("account-dialog").w_full().p(20).gap(12).bg(t.popover).text_color(t.foreground)
      .on_size_change((s, ctx) => { const w = Math.max(35, Math.min(260, s.width - 302)); if (w !== this.track) { this.track = w; ctx.notify(); } })
      .child(h_flex().items_center().gap(9).child(div().flex_1().when(Boolean(headingFont), el => el.font_family(headingFont)).font_semibold().text_size(23).child("Usage & credits"))
        .child(action("refresh", refreshing ? "Refreshing…" : "Refresh", () => run("orca-usage.refresh"), t))
        .child(div().id("close").p(5).rounded(4).cursor_pointer().hover(el => el.bg(t.hover)).tooltip("Close").on_click(() => closeOverlay(props().overlay)).child(icon("x", 15))))
      .child(h_flex().gap(8).child(this.balance("Codex", d.codex, t)).child(this.balance("Antigravity", d.google, t)))
      .child(h_flex().gap(6).items_center().children(chips.map(([id, text]) => h_flex().id("view-" + id).h(27).px(10).rounded(6).items_center()
        .bg(this.tab === id ? t.selected : t.popover).text_color(this.tab === id ? t.foreground : t.muted).text_size(12).cursor_pointer()
        .hover(el => el.bg(t.hover)).on_click((_, ctx) => { this.tab = id; ctx.notify(); }).child(text))))
      .child(v_flex().id("account-page").max_h(310).overflow_y_scrollbar().child(this.tab === "credits" ? this.credits(d, t) : this.limits(d, t)))
      .child(h_flex().pt(9).border_t(1).border_color(t.border).items_center().child(label(d.checked ? "Updated " + new Date(d.checked).toTimeString().slice(0,5) : "Waiting for account data", 10.8, t.dim)));
  }

  render() {
    const t = theme(), d = shared(cache) || {}, p = props() || {};
    const refreshing = Date.now() - Number(shared(busyKey) || 0) < 25000;
    if (p.overlay) return this.dialog(d, t, refreshing);
    const compact = this.width < 930;
    const groups = (d.groups || []).filter(g => g.windows?.length > 0);
    const hasCodexBalance = typeof d.codex?.balance === "number" || d.codex?.unlimited;
    const creditLabel = !hasCodexBalance ? "Usage" : compact ? "Credits" : "Credits  " + money(d.codex);
    return h_flex().id("usage-strip").size_full().px(12).gap(compact ? 9 : 16).items_center().bg(t.chrome).border_t(1).border_color(t.border)
      .on_size_change((s, ctx) => { if (this.width !== s.width) { this.width = s.width; ctx.notify(); } })
      .child(div().id("limits").text_size(11.5).font_medium().text_color(t.foreground).cursor_pointer().tooltip("Open quota & credit details").on_click(() => open("limits")).child("Quota left"))
      .when(!d.checked && !groups.length, el => el.child(label("Reading limits…", 11, t.muted)))
      .when(Boolean(d.checked) && !groups.length, el => el.child(div().cursor_pointer().on_click(() => open("limits")).child(label("No provider CLIs signed in", 11, t.dim))))
      .children(groups.map(g => {
        const sorted = [...g.windows].sort((a,b) => (a.end || Infinity) - (b.end || Infinity));
        const lowest = [...sorted].sort((a,b) => a.left - b.left)[0];
        const visible = this.width < 1160 ? (lowest ? [lowest] : []) : sorted;
        const barColor = lowest && lowest.left <= 15 ? t.blocked : ink(g.name);
        return h_flex().id("usage-" + g.name).gap(5).items_center().cursor_pointer().on_click(() => open("limits"))
          .when(!compact, el => el.child(logo(g.provider, 12))).child(label(g.name, 11, t.muted))
          .when(!compact && lowest, el => el.child(this.meter("foot-" + g.name, lowest.left, 27, 4, barColor, t, d.motion !== false)))
          .when(!visible.length, el => el.child(label("—", 11, t.dim)))
          .children(visible.map(b => h_flex().gap(4).items_center().child(label(Math.round(b.left) + "%", 11, b.left <= 15 ? t.blocked : ink(g.name)))
            .when(!compact, el => el.child(label(until(b.end), 10, t.dim)))));
      }))
      .child(div().flex_1())
      .child(action("credits", creditLabel, () => open("credits"), t))
      .child(div().id("refresh").p(3).rounded(4).text_color(t.muted).cursor_pointer().hover(el => el.bg(t.hover)).tooltip("Refresh usage").on_click((_,ctx) => this.refresh(ctx))
        .child(refreshing && d.motion !== false ? icon("spinner",12).spin(850) : "↻"));
  }
}
