// Project tasks: search and run the commands of the project you're in.
//
// Tasks come from `.herdr/tasks.json`, found by walking up from the focused
// terminal's folder:
//   { "tasks": [
//       { "name": "server", "cwd": "backend", "argv": ["./gradlew", "bootRun"] },
//       { "name": "client", "cwd": "frontend", "cmd": "npm start" } ] }
// `cwd` is relative to the project root. `cmd` runs through `sh -c`.
// Without a tasks file, package.json scripts at the root are offered.
//
// Enter: start the task in a background tab, or peek at it if it already runs.
// ctrl+n / ctrl+p (or the arrows): move.  ctrl+x: stop.  ctrl+r: restart.  Esc: leave.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, focused, terminals, run, theme, props, closeOverlay, readTextFile, notify } from "herdr";

const LABEL = "herdr.task";

const dirname = (p) => (p.lastIndexOf("/") > 0 ? p.slice(0, p.lastIndexOf("/")) : "/");
const join = (a, b) => (b.startsWith("/") ? b : `${a}/${b}`.replace(/\/\.$/, ""));

// A terminal's labels, whatever shape the core reports them in.
function labelOf(term, key) {
  const l = term.labels;
  if (!l) return null;
  if (Array.isArray(l)) {
    const hit = l.find((x) => typeof x === "string" && x.startsWith(key + "="));
    return hit ? hit.slice(key.length + 1) : null;
  }
  return l[key] ?? null;
}

export default class Tasks extends View {
  init(_props, cx) {
    this.root = null;
    this.source = "";
    this.all = [];
    this.loading = true;
    this.error = null;
    this.filter = "";
    this.at = 0;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Run a task…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.activate(this.rows()[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        await this.load();
      } catch (err) {
        this.error = String(err?.message ?? err);
      }
      this.loading = false;
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Walk up from the focused terminal's folder to the nearest project file.
  async load() {
    const f = focused();
    const machine = null; // local projects only for now
    let dir = f?.cwd;
    if (!dir) {
      this.error = "No folder to look in: focus a terminal first.";
      return;
    }
    for (;;) {
      const text = await readTextFile(`${dir}/.herdr/tasks.json`, { on: machine });
      if (text) {
        const j = JSON.parse(text);
        this.root = dir;
        this.source = ".herdr/tasks.json";
        this.all = (j.tasks ?? []).map((x) => this.normalize(dir, x));
        return;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    // Fallback: package.json scripts where we started, then upward.
    dir = f.cwd;
    for (;;) {
      const text = await readTextFile(`${dir}/package.json`, { on: machine });
      if (text) {
        const scripts = JSON.parse(text).scripts ?? {};
        this.root = dir;
        this.source = "package.json";
        this.all = Object.keys(scripts).map((name) => this.normalize(dir, { name, cmd: `npm run ${name}`, detail: scripts[name] }));
        return;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    this.error = "No .herdr/tasks.json or package.json found above this folder.";
  }

  normalize(root, x) {
    const argv = x.argv ?? (x.cmd ? ["sh", "-c", x.cmd] : null);
    return {
      name: x.name ?? (argv ? argv.join(" ") : "?"),
      cwd: join(root, x.cwd ?? "."),
      argv,
      detail: x.detail ?? x.cmd ?? (x.argv ? x.argv.join(" ") : ""),
      key: `${root}::${x.name}`,
    };
  }

  // The live terminal started for a task, if any.
  running(task) {
    return terminals().find((t) => t.state === "live" && labelOf(t, LABEL) === task.key) ?? null;
  }

  rows() {
    const f = this.filter.toLowerCase();
    return this.all
      .filter((t) => !f || `${t.name} ${t.detail}`.toLowerCase().includes(f))
      .map((task) => ({ task, term: this.running(task) }));
  }

  // Closing the dialog cancels this view's pending work, so the whole sequence
  // (optional kill, create the tab, label its terminal) is one shell command that
  // keeps running on its own.
  start(task, killAddress = "") {
    if (!task.argv) return notify({ title: "Task has no command", body: task.name, level: "error" });
    const script = [
      'if [ -n "$5" ]; then hc kill "$5" >/dev/null 2>&1; fi',
      'out=$(herdr-app do tab.new --name "$1" --folder "$2" --argv "$3" --focus false) || { echo "$out"; exit 1; }',
      't=$(printf "%s" "$out" | sed -n \'s/.*"terminal": *"\\([^"]*\\)".*/\\1/p\')',
      '[ -n "$t" ] || { echo "$out"; exit 1; }',
      'hc label "$t" "$4"',
    ].join("\n");
    return exec("sh", ["-c", script, "sh", task.name, task.cwd, JSON.stringify(task.argv), `${LABEL}=${task.key}`, killAddress]);
  }

  activate(row, cx) {
    if (!row) return;
    this.close();
    if (row.term) run("terminal.peek", { terminal: row.term.address });
    else this.start(row.task);
  }

  stop(row) {
    if (!row?.term) return;
    run("terminal.kill", { terminal: row.term.address });
  }

  restart(row, cx) {
    if (!row) return;
    this.close();
    this.start(row.task, row.term?.address ?? "");
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));

    const move = (d) => {
      if (rows.length) this.at = (this.at + d + rows.length) % rows.length;
    };

    const rowEl = (r, i) => {
      const on = i === this.at;
      return h_flex()
        .id(`task-${i}`)
        .mx(4)
        .px(10)
        .h(36)
        .gap(10)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.activate(r, cx))
        .child(div().w(12).flex_none().text_color(r.term ? t.working : t.dim).child(r.term ? "●" : "○"))
        .child(div().text_color(t.foreground).child(r.task.name))
        .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(r.task.detail))
        .child(div().text_size(11).text_color(r.term ? t.working : t.dim).child(r.term ? "running" : ""));
    };

    return v_flex()
      .id("tasks")
      .track_focus(this.handle)
      .w_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        const ctrl = e.modifiers.control;
        if (k === "escape") return this.close();
        if (k === "down" || (ctrl && k === "n")) move(1);
        else if (k === "up" || (ctrl && k === "p")) move(-1);
        else if (ctrl && k === "x") this.stop(rows[this.at]);
        else if (ctrl && k === "r") this.restart(rows[this.at], cx);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex().items_center()
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Tasks"))
          .child(div().text_size(11).text_color(t.dim).child(this.root ? `${this.root.split("/").pop()} · ${this.source}` : "")),
      )
      .child(
        h_flex().h(36).flex_none().px(10).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex().id("tasks-list").w_full().h(Math.max(40, Math.min(360, rows.length * 36 + 8))).min_h(0).overflow_y_scrollbar()
          .when(this.loading, (el) => el.child(div().p(10).text_color(t.dim).child("Looking for tasks…")))
          .when(!this.loading && this.error, (el) => el.child(div().p(10).text_color(t.blocked).child(this.error)))
          .when(!this.loading && !this.error && !rows.length, (el) => el.child(div().p(10).text_color(t.dim).child("No matching task.")))
          .children(rows.map(rowEl)),
      )
      .child(
        div().text_size(11).text_color(t.dim).child("enter run/peek · ctrl+n/p move · ctrl+x stop · ctrl+r restart · esc close"),
      );
  }
}
