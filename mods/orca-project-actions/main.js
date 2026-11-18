import { View } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, theme } from "herdr";

export default class ProjectActions extends View {
  render() {
    const t = theme();
    const workspace = layout()?.children?.find(node => node.id === "workspace");
    const sidebar = workspace?.children?.find(node => node.id === "sidebar");
    const compact = (sidebar?.size?.px ?? 284) < 160;
    const button = (id, label, shortLabel, hint, action, primary) =>
      h_flex().id(id).h(compact ? 20 : 30).flex_1().min_w(0).rounded(5)
        .items_center().justify_center().cursor_pointer().tooltip(hint)
        .bg(primary ? t.solid : t.surface).text_color(primary ? t.solid_foreground : t.foreground)
        .hover(style => style.opacity(0.85)).text_size(12).font_medium()
        .on_click(action).child(compact ? shortLabel : label);
    return h_flex().size_full().when(compact, row => row.flex_col())
      .px(compact ? 2 : 8).gap(compact ? 1 : 6).items_center().bg(t.chrome)
      .child(button("new-space", "New space", "+", "Create a new local space", () => run("space.new", { machine: "" }), true))
      .child(button("open-project", "Add project…", "…", "Open a folder or clone a repository",
        () => run("mod.open", { name: "orca-add-project" }), false));
  }
}
