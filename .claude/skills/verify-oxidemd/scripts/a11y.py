#!/usr/bin/env python3
"""Read and press OxideMD's UI through the accessibility tree (AT-SPI).

Called by `oxv`; not meant to be run directly. Every handle is the element's
accessible name (its ARIA label or visible text), so a recipe survives layout
and theme changes.
"""
import argparse
import subprocess
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

FLAGS = (
    ("showing", Atspi.StateType.SHOWING),
    ("enabled", Atspi.StateType.ENABLED),
    ("focused", Atspi.StateType.FOCUSED),
    ("pressed", Atspi.StateType.PRESSED),
    ("checked", Atspi.StateType.CHECKED),
    ("selected", Atspi.StateType.SELECTED),
)


def app_for(pid):
    desk = Atspi.get_desktop(0)
    for i in range(desk.get_child_count()):
        app = desk.get_child_at_index(i)
        try:
            if app is not None and app.get_process_id() == pid:
                return app
        except Exception:
            continue
    return None


def states(o):
    st = o.get_state_set()
    return {name for name, flag in FLAGS if st.contains(flag)}


def text_of(o):
    try:
        # Asking a non-text widget for its text makes GTK log a warning in the
        # app, so check the interface first.
        if "Text" not in o.get_interfaces():
            return ""
        n = Atspi.Text.get_character_count(o)
        return Atspi.Text.get_text(o, 0, n) if n > 0 else ""
    except Exception:
        return ""


def walk(o, depth=0):
    """Yield (depth, node) for the whole tree. Unreadable nodes are skipped."""
    if o is None or depth > 40:
        return
    yield depth, o
    try:
        count = o.get_child_count()
    except Exception:
        return
    for i in range(count):
        try:
            child = o.get_child_at_index(i)
        except Exception:
            continue
        yield from walk(child, depth + 1)


def describe(o):
    try:
        role = o.get_role_name()
        name = o.get_name() or ""
        st = states(o)
    except Exception:
        return None
    return role, name, st


def matches(o, args):
    d = describe(o)
    if d is None:
        return False
    role, name, st = d
    if args.role and role != args.role:
        return False
    if args.text:
        if args.name not in name and args.name not in text_of(o):
            return False
    elif args.contains:
        if args.name not in name:
            return False
    elif name != args.name:
        return False
    return args.hidden or "showing" in st


def find_all(app, args):
    return [o for _, o in walk(app) if matches(o, args)]


def line(o):
    d = describe(o)
    if d is None:  # the element went away (a press can replace it)
        return "<element no longer in the tree>"
    role, name, st = d
    out = f'{role} "{name}" [{" ".join(sorted(st))}]'
    txt = text_of(o).strip().replace("\n", "\\n")
    if txt and txt != name:
        out += f' text="{txt[:120]}"'
    return out


def cmd_tree(app, args):
    for depth, o in walk(app):
        d = describe(o)
        if d is None:
            continue
        if not args.all and "showing" not in d[2]:
            continue
        print("  " * depth + line(o))
    return 0


def one(app, args):
    found = find_all(app, args)
    if not found:
        print(f'not found: "{args.name}"' + (f" (role {args.role})" if args.role else ""), file=sys.stderr)
        return None
    if len(found) > 1:
        print(f'ambiguous: {len(found)} elements match "{args.name}"; add --role:', file=sys.stderr)
        for o in found:
            print("  " + line(o), file=sys.stderr)
        return None
    return found[0]


def cmd_press(app, args):
    o = one(app, args)
    if o is None:
        return 1
    if "enabled" not in states(o):
        print(f"disabled: {line(o)}", file=sys.stderr)
        return 1
    if o.get_role_name() == "page tab":
        # WebKit routes the press to the tab's close button, so this would
        # close the tab instead of selecting it.
        print("refusing to press a tab (it would close it); switch with: oxv key ctrl+Tab", file=sys.stderr)
        return 1
    try:
        if o.get_n_actions() < 1 or not o.do_action(0):
            print(f"no press action: {line(o)}", file=sys.stderr)
            return 1
    except Exception as e:
        print(f"press failed: {e}", file=sys.stderr)
        return 1
    print(f"pressed: {line(o)}")
    return 0


def cmd_text(app, args):
    o = one(app, args)
    if o is None:
        return 1
    sys.stdout.write(text_of(o))
    return 0


def cmd_show(app, args):
    found = find_all(app, args)
    for o in found:
        print(line(o))
    return 0 if found else 1


def pump(args):
    """Make the hidden window paint one frame. Off screen it only paints when
    it is captured, and showing/hidden states follow the paint."""
    if args.stable:
        subprocess.run(["grim", "-T", args.stable, "-"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def cmd_ready(pid, args):
    """The web UI is up once the webview's document node exists. It stays in
    the tree while a modal dialog hides the toolbar, so this is the right
    liveness probe."""
    deadline = time.monotonic() + args.timeout
    while True:
        app = app_for(pid)
        if app and any((describe(o) or ("",))[0] == "document web" for _, o in walk(app)):
            return 0
        if time.monotonic() > deadline:
            print(f"timeout after {args.timeout}s: the web UI is not in the accessibility tree", file=sys.stderr)
            return 1
        time.sleep(0.15)
        pump(args)


def cmd_wait(pid, args):
    deadline = time.monotonic() + args.timeout
    while True:
        app = app_for(pid)
        found = find_all(app, args) if app else []
        if args.enabled:
            found = [o for o in found if "enabled" in states(o)]
        ok = (not found) if args.gone else bool(found)
        if ok:
            if found:
                print(line(found[0]))
            return 0
        if time.monotonic() > deadline:
            what = "still present" if args.gone else "did not appear"
            print(f'timeout after {args.timeout}s: "{args.name}" {what}', file=sys.stderr)
            return 1
        time.sleep(0.12)
        pump(args)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--pid", type=int, required=True)
    p.add_argument("--stable", help="Hyprland stableId of the window, used to pump frames while waiting")
    sub = p.add_subparsers(dest="cmd", required=True)

    def target(sp):
        sp.add_argument("name")
        sp.add_argument("--role", help='AT-SPI role name, e.g. "button", "toggle button", "entry"')
        sp.add_argument("--contains", action="store_true", help="match a substring of the name")
        sp.add_argument("--text", action="store_true", help="match a substring of the name or the text content")
        sp.add_argument("--hidden", action="store_true", help="also match elements that are not showing")

    t = sub.add_parser("tree")
    t.add_argument("--all", action="store_true", help="include elements that are not showing")
    for name in ("press", "text", "show"):
        target(sub.add_parser(name))
    w = sub.add_parser("wait")
    target(w)
    w.add_argument("--gone", action="store_true")
    w.add_argument("--enabled", action="store_true")
    w.add_argument("--timeout", type=float, default=8.0)
    r = sub.add_parser("ready")
    r.add_argument("--timeout", type=float, default=0.0)
    args = p.parse_args()

    Atspi.set_timeout(3000, 8000)
    if args.cmd == "wait":
        return cmd_wait(args.pid, args)
    if args.cmd == "ready":
        return cmd_ready(args.pid, args)
    app = app_for(args.pid)
    if app is None:
        print(f"no accessible application for pid {args.pid}", file=sys.stderr)
        return 2
    return {"tree": cmd_tree, "press": cmd_press, "text": cmd_text, "show": cmd_show}[args.cmd](app, args)


if __name__ == "__main__":
    sys.exit(main())
