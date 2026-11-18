import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, closeOverlay, hc, notify, props, run, shared, setShared, theme } from "herdr";
import { asleep, changeAgent } from "./lifecycle.js";

const history = "orca.closed-agents";
const titles = { sleep: "Sleep agent", wake: "Wake agent", close: "Close agent", delete: "Delete agent" };
const descriptions = {
  sleep: "Interrupt the current turn and keep the session open.",
  wake: "Return to this session for your next prompt.",
  close: "End this terminal and keep its Herdr history when available.",
  delete: "End this terminal and erase its Herdr terminal record and scrollback."
};

export default class AgentActions extends View {
  init(_, cx) {
    this.handle = cx.focus_handle(); this.handle.focus();
    this.target = props()?.target;
    if (this.target && !checking()) this.inspect(cx);
  }
  dismiss() { closeOverlay(props().overlay); }
  async call(args) {
    const r = await hc([...args, "--json"]);
    if (r.code !== 0) throw Error((r.stderr || r.stdout || "Herdr could not complete the action.").trim().slice(0, 320));
    return r.stdout;
  }
  async get() { return JSON.parse(await this.call(["get", this.target.address])); }
  inspect(cx) {
    cx.spawn(async ctx => {
      try {
        const term = await this.get();
        if ((this.target.created != null && term.created_ms !== this.target.created) ||
            (this.target.closed && term.state === "live")) throw Error("This record no longer matches the selected terminal.");
        if (term.state === "live" && shared("orca.runtime.local")?.[this.target.address]?.exited) throw Error("This agent has already exited.");
        this.target = { ...this.target, created: term.created_ms, app: term.status?.app, foreground: term.foreground?.pid };
        this.term = term;
      } catch (e) { this.error = e.message || String(e); }
      ctx.notify();
    });
  }
  perform(op, cx) {
    if (this.busy || !this.term) return;
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async ctx => {
      try {
        await changeAgent(op, this.target, () => this.get(), args => this.call(args));
        const { address, name, created } = this.target;
        if (op === "close" || op === "delete") {
          const list = (shared(history) || []).filter(r => r.address !== address || r.created !== created);
          if (op === "close" && !this.term.rm) list.unshift({ address, created, name, closed: true });
          setShared(history, list);
        }
        this.dismiss();
        if (op === "wake") {
          if (this.target.pane) run("pane.focus", { pane: this.target.pane });
          else run("terminal.peek", { terminal: address });
        }
        notify({ title: ({sleep:"Agent sleeping",wake:"Agent awake",close:"Agent closed",delete:"Herdr terminal deleted"})[op], body: name, timeout: 2300 });
      } catch (e) { this.error = e.message || String(e); this.busy = false; ctx.notify(); }
    });
  }
  render() {
    const t = theme(), target = this.target;
    const button = (id, title, cb, danger = false) => h_flex().id(id).h(31).px(10).items_center().rounded(6)
      .bg(danger ? "#593a3e" : t.raised).text_color(danger ? "#ffc1ba" : t.foreground).text_size(12).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click((_, ctx) => { if (!this.busy) cb(ctx); }).child(title);
    const root = v_flex().id("agent-actions").track_focus(this.handle).w_full().p(15).gap(9).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, ctx) => { if (e.key === "escape") { if (!this.busy) this.dismiss(); ctx.stop_propagation(); } })
      .child(h_flex().items_center().gap(8).child(div().flex_1().min_w(0).truncate().font_semibold().text_size(15).child(target ? target.name : "Closed agents"))
        .child(button("dismiss", "×", () => this.dismiss())));
    if (!target) {
      const closed = shared(history) || [];
      return root.child(v_flex().id("closed-list").max_h(330).overflow_y_scrollbar().gap(4)
        .children(closed.map(r => button("closed-"+r.address+r.created, r.name + " · " + r.address, ctx => {
          this.target = r; this.error = ""; this.inspect(ctx); ctx.notify();
        }))).when(!closed.length, el => el.child(div().text_size(12).text_color(t.muted).child("No closed agents"))))
        .when(closed.length > 0, el => el.child(h_flex().pt(6).border_t(1).border_color(t.border).justify_end()
          .child(button("clear-closed", "Clear list", () => { setShared(history, []); this.dismiss(); }))));
    }
    if (this.error) root.child(div().text_size(12).text_color(t.blocked).child(this.error));
    if (!this.term) return root.when(!this.error, el => el.child("Reading terminal…")).when(target.closed && Boolean(this.error), el =>
      el.child(button("forget", "Dismiss from closed list", () => {
        setShared(history,(shared(history) || []).filter(r => r.created !== target.created || r.address !== target.address)); this.dismiss();
      })));
    if (this.confirm) {
      const op = this.confirm;
      return root.child(div().text_size(13).text_color(t.muted).child(op === "delete" && this.term.state !== "live" ? "Erase this finished terminal’s Herdr record and scrollback." : descriptions[op]))
        .child(div().text_size(11).text_color(t.dim).child("Terminal " + target.address + (this.term.state === "live" ? " · Closing the last pane also closes its tab." : "")))
        .child(h_flex().justify_end().gap(6).child(button("cancel","Cancel",ctx => { this.confirm = null; ctx.notify(); }))
          .child(button("confirm",this.busy ? "Working…" : titles[op],ctx => this.perform(op,ctx),true)));
    }
    const live = this.term.state === "live";
    const actions = live ? [asleep(this.term) ? "wake" : "sleep","close","delete"] : ["delete"];
    return root.children(actions.map(op => v_flex().id("action-"+op).px(8).py(6).gap(2).rounded(6).cursor_pointer().hover(el => el.bg(t.hover))
      .on_click((_,ctx) => { if (this.busy) return; if (op === "close" || op === "delete") { this.confirm = op; ctx.notify(); } else this.perform(op,ctx); })
      .child(div().font_medium().text_size(12.5).text_color(op === "delete" ? (t.ansi1 || "#f4a69e") : t.foreground).child(titles[op]))
      .child(div().text_size(11).text_color(t.muted).child(descriptions[op]))))
      .when(this.busy, el => el.child(div().text_size(11).text_color(t.muted).child("Waiting for the terminal…")));
  }
}
