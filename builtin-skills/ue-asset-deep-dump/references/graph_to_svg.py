"""Render a dumped Blueprint or Material graph to a standalone SVG (no external deps).

Examples:
  python graph_to_svg.py --asset Docs/_data/assets/FluidNinjaLive__Core__NinjaLiveGUI.json \
      --graph GetSelectedActor --out Docs/FluidNinjaLIVE/assets/graphs/NinjaLiveGUI_GetSelectedActor.svg

  python graph_to_svg.py --asset Docs/_data/assets/...M_NinjaOutput_Basic.json \
      --material --out Docs/FluidNinjaLIVE/assets/materials/M_NinjaOutput_Basic.svg
"""

import argparse
import json
import os
import re
import sys


def esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def short(text, limit=44):
    text = str(text or "")
    return text if len(text) <= limit else text[:limit - 1] + "…"


def pin_dir(pin):
    d = str(pin.get("direction", ""))
    return "out" if "OUTPUT" in d or "EGPD_OUTPUT" in d else "in"


def node_color(cls):
    if "Event" in cls:
        return "#b4232c", "#fbe9ea"
    if "FunctionEntry" in cls or "FunctionResult" in cls:
        return "#8a3ab9", "#f3e9fa"
    if "VariableGet" in cls:
        return "#1d7a46", "#e8f7ee"
    if "VariableSet" in cls:
        return "#157a7a", "#e6f7f7"
    if "Macro" in cls:
        return "#7a4b00", "#fff4df"
    if "CallFunction" in cls:
        return "#1c4f8a", "#e8f1fb"
    if "Comment" in cls:
        return "#666666", "#f2f2f2"
    return "#444444", "#f4f4f4"


def render_blueprint(data, graph_name, title=None, max_nodes=160):
    graphs = data.get("blueprint", {}).get("graphs", [])
    graph = next((g for g in graphs if g.get("name") == graph_name), None)
    if graph is None:
        names = ", ".join(g.get("name", "?") for g in graphs[:40])
        raise SystemExit("graph %r not found. Available: %s" % (graph_name, names))
    nodes = [n for n in graph.get("nodes", []) if n.get("pos")]
    if max_nodes and len(nodes) > max_nodes:
        raise SystemExit("graph has %d nodes (> %d). Select a smaller graph or raise --max-nodes."
                         % (len(nodes), max_nodes))
    if not nodes:
        raise SystemExit("graph has no renderable nodes")
    xs = [n["pos"][0] for n in nodes]
    ys = [n["pos"][1] for n in nodes]
    min_x, min_y = min(xs), min(ys)
    max_x, max_y = max(xs), max(ys)
    row = 17
    header = 26
    sizes = {}
    for n in nodes:
        ins = [p for p in n.get("pins", []) if pin_dir(p) == "in"]
        outs = [p for p in n.get("pins", []) if pin_dir(p) == "out"]
        w = max(170, min(340, 9 * len(n.get("title", "")) + 60, 90 + 7 * max(len(p.get("name", "")) for p in n.get("pins", []) or [{"name": ""}])))
        h = header + row * max(1, max(len(ins), len(outs))) + 8
        sizes[n["name"]] = (w, h)
    # map editor coordinates to canvas
    span_x = max(1, max_x - min_x)
    span_y = max(1, max_y - min_y)
    pad = 40
    width = min(4200, max(900, span_x + 420))
    scale = min(1.0, (width - 2 * pad) / float(span_x + 340))
    canvas_h = int(max(600, (span_y + 120) * scale + 2 * pad))
    def tx(x):
        return int(pad + (x - min_x) * scale)
    def ty(y):
        return int(pad + (y - min_y) * scale)
    # node boxes and pin y positions
    box = {}
    for n in nodes:
        w, h = sizes[n["name"]]
        x, y = tx(n["pos"][0]), ty(n["pos"][1])
        box[n["name"]] = (x, y, int(w * max(0.7, scale)), int(h * max(0.7, scale)))
    pin_y = {}
    for n in nodes:
        x, y, w, h = box[n["name"]]
        ins = [p for p in n.get("pins", []) if pin_dir(p) == "in"]
        outs = [p for p in n.get("pins", []) if pin_dir(p) == "out"]
        for group, side in ((ins, "in"), (outs, "out")):
            for i, p in enumerate(group):
                key = (n["name"], p.get("name", ""), side)
                pin_y[key] = (x if side == "in" else x + w,
                              y + 26 + int(i * 17 * max(0.7, scale)))
    parts = []
    parts.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' %
                 (width, canvas_h, width, canvas_h))
    parts.append('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                 '<path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker></defs>')
    parts.append('<rect width="100%" height="100%" fill="#ffffff"/>')
    title = title or ("%s / %s" % (data.get("name", "?"), graph_name))
    parts.append('<text x="20" y="26" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="16" font-weight="600" fill="#111">%s</text>' % esc(title))
    parts.append('<text x="20" y="44" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" fill="#666">nodes=%d  edges=%d  (Blueprint graph, layout from editor positions)</text>' % (len(nodes), len(graph.get("edges", []))))
    # comments behind nodes: draw bounding box of contained nodes
    for c in graph.get("comments", []):
        contained = [box[nm] for nm in c.get("nodes", []) if nm in box]
        if not contained:
            continue
        cx = min(b[0] for b in contained) - 14
        cy = min(b[1] for b in contained) - 14
        cw = max(b[0] + b[2] for b in contained) - cx + 14
        ch = max(b[1] + b[3] for b in contained) - cy + 14
        parts.append('<rect x="%d" y="%d" width="%d" height="%d" rx="8" fill="#fff7d6" fill-opacity="0.55" stroke="#d6b656" stroke-dasharray="5 3"/>' % (cx, cy, cw, ch))
        parts.append('<text x="%d" y="%d" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" fill="#7a5b00">%s</text>' % (cx + 6, cy + 15, esc(short(c.get("text", ""), 70))))
    # edges
    for e in graph.get("edges", []):
        a = (e.get("from_node"), e.get("from_pin"), "out")
        b = (e.get("to_node"), e.get("to_pin"), "in")
        if a not in pin_y or b not in pin_y:
            continue
        x1, y1 = pin_y[a]
        x2, y2 = pin_y[b]
        col = "#b86e00" if "执行" in str(e.get("from_pin")) else "#5b7fa6"
        dx = max(30, abs(x2 - x1) * 0.45)
        parts.append('<path d="M %d %d C %d %d, %d %d, %d %d" fill="none" stroke="%s" stroke-width="1.2" marker-end="url(#arrow)"/>' %
                     (x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2, col))
    # nodes
    for n in nodes:
        x, y, w, h = box[n["name"]]
        dark, light = node_color(n.get("class", ""))
        parts.append('<g><rect x="%d" y="%d" width="%d" height="%d" rx="6" fill="%s" stroke="%s" stroke-width="1.2"/>' %
                     (x, y, w, h, light, dark))
        parts.append('<path d="M %d %d h %d a 6 6 0 0 1 6 6 v 18 h -%d z" fill="%s"/>' % (x, y, w, w, dark))
        parts.append('<text x="%d" y="%d" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" font-weight="600" fill="#ffffff">%s</text>' % (x + 8, y + 17, esc(short(n.get("title", ""), 38))))
        ins = [p for p in n.get("pins", []) if pin_dir(p) == "in"]
        outs = [p for p in n.get("pins", []) if pin_dir(p) == "out"]
        for i, p in enumerate(ins):
            py = y + 26 + int(i * 17 * max(0.7, scale))
            parts.append('<circle cx="%d" cy="%d" r="3" fill="#2b6cb0"/>' % (x, py))
            parts.append('<text x="%d" y="%d" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9" fill="#222">%s</text>' % (x + 6, py + 3, esc(short(p.get("name", ""), 18))))
        for i, p in enumerate(outs):
            py = y + 26 + int(i * 17 * max(0.7, scale))
            parts.append('<circle cx="%d" cy="%d" r="3" fill="#b86e00"/>' % (x + w, py))
            parts.append('<text x="%d" y="%d" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9" fill="#222">%s</text>' % (x + w - 6, py + 3, esc(short(p.get("name", ""), 18))))
        parts.append('</g>')
    parts.append('</svg>')
    return "\n".join(parts), len(nodes), len(graph.get("edges", []))


def render_material(data, title=None, max_expr=160):
    mat = data.get("material") or data.get("material_function") or {}
    exprs = [e for e in mat.get("expressions", []) if e.get("pos")]
    if not exprs:
        raise SystemExit("material has no renderable expressions")
    if max_expr and len(exprs) > max_expr:
        raise SystemExit("material has %d expressions (> %d); raise --max-expr." % (len(exprs), max_expr))
    xs = [e["pos"][0] for e in exprs]
    ys = [e["pos"][1] for e in exprs]
    min_x, min_y = min(xs), min(ys)
    max_x, max_y = max(xs), max(ys)
    span_x, span_y = max(1, max_x - min_x), max(1, max_y - min_y)
    pad = 40
    width = min(4200, max(900, span_x + 420))
    scale = min(1.0, (width - 2 * pad) / float(span_x + 340))
    height = int(max(600, (span_y + 120) * scale + 2 * pad))
    def tx(x):
        return int(pad + (x - min_x) * scale)
    def ty(y):
        return int(pad + (y - min_y) * scale)
    row = 17
    box = {}
    for e in exprs:
        label = e.get("class", "").replace("MaterialExpression", "")
        prop = e.get("props", {})
        pname = prop.get("parameter_name") or prop.get("description") or ""
        w = max(160, min(320, 8 * (len(label) + len(str(pname))) + 40))
        ins = e.get("inputs", [])
        h = 24 + row * max(1, len(ins)) + 6
        box[e["name"]] = (tx(e["pos"][0]), ty(e["pos"][1]), int(w * max(0.7, scale)), int(h * max(0.7, scale)), label, pname, ins)
    name_to = {e["name"]: e for e in exprs}
    parts = []
    parts.append('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (width, height, width, height))
    parts.append('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#555"/></marker></defs>')
    parts.append('<rect width="100%" height="100%" fill="#ffffff"/>')
    title = title or (data.get("name", "?") + " / material graph")
    parts.append('<text x="20" y="26" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="16" font-weight="600" fill="#111">%s</text>' % esc(title))
    parts.append('<text x="20" y="44" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" fill="#666">expressions=%d (material graph, layout from editor positions)</text>' % len(exprs))
    # edges: use input order -> left side rows
    for e in exprs:
        for i, inp in enumerate(e.get("inputs", [])):
            src = inp.get("connected")
            if src not in box:
                continue
            sx, sy, sw, sh = box[src][:4]
            dx, dy, dw, dh = box[e["name"]][:4]
            x1, y1 = sx + sw, sy + int(sh * 0.5)
            x2, y2 = dx, dy + 24 + int(i * row * max(0.7, scale))
            mid = max(24, abs(x2 - x1) * 0.4)
            parts.append('<path d="M %d %d C %d %d, %d %d, %d %d" fill="none" stroke="#5b7fa6" stroke-width="1.2" marker-end="url(#arrow)"/>' %
                         (x1, y1, x1 + mid, y1, x2 - mid, y2, x2, y2))
    for e in exprs:
        x, y, w, h, label, pname, ins = box[e["name"]]
        is_param = "Parameter" in e.get("class", "") or "TextureObject" in e.get("class", "")
        dark = "#7a3e00" if is_param else "#1c4f8a"
        light = "#fff2df" if is_param else "#e8f1fb"
        parts.append('<g><rect x="%d" y="%d" width="%d" height="%d" rx="6" fill="%s" stroke="%s" stroke-width="1.2"/>' %
                     (x, y, w, h, light, dark))
        parts.append('<path d="M %d %d h %d a 6 6 0 0 1 6 6 v 18 h -%d z" fill="%s"/>' % (x, y, w, w, dark))
        label_text = label + (("  [" + str(pname) + "]") if pname else "")
        parts.append('<text x="%d" y="%d" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" font-weight="600" fill="#ffffff">%s</text>' % (x + 8, y + 17, esc(short(label_text, 40))))
        for i, inp in enumerate(ins):
            py = y + 24 + int(i * row * max(0.7, scale))
            parts.append('<circle cx="%d" cy="%d" r="3" fill="#2b6cb0"/>' % (x, py))
            parts.append('<text x="%d" y="%d" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9" fill="#222">%s</text>' % (x + 6, py + 3, esc(short(inp.get("name", ""), 18))))
        parts.append('</g>')
    parts.append('</svg>')
    return "\n".join(parts), len(exprs), sum(len(e.get("inputs", [])) for e in exprs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--asset", required=True)
    ap.add_argument("--graph")
    ap.add_argument("--material", action="store_true")
    ap.add_argument("--out", required=True)
    ap.add_argument("--title")
    ap.add_argument("--max-nodes", type=int, default=160)
    ap.add_argument("--max-expr", type=int, default=160)
    args = ap.parse_args()
    with open(args.asset, "r", encoding="utf-8") as f:
        data = json.load(f)
    if args.material:
        svg, n, e = render_material(data, args.title, args.max_expr)
    else:
        if not args.graph:
            raise SystemExit("--graph is required unless --material is given")
        svg, n, e = render_blueprint(data, args.graph, args.title, args.max_nodes)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(svg)
    print("wrote %s (%d nodes/exprs, %d edges)" % (args.out, n, e))


if __name__ == "__main__":
    main()
