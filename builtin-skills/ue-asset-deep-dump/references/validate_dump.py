"""Validate a UE asset dump produced by dump_assets.py.

Usage:
  python -I validate_dump.py --data Docs/_data [--summary Docs/_data/validation.json]

Checks:
  - index.json is a list and every entry has package/name/class
  - every deep_file exists, parses, and matches its index entry
  - Blueprint graphs: node_count == len(nodes), node ids are 0..N-1,
    every edge endpoint is a valid node index, every linked pin target exists
  - Material/function: expressions is a list
  - MaterialInstanceConstant: overrides is a list
  - DataTable: row_count == len(rows)
Exit code 1 if any hard error is found; warnings do not fail the run.
"""

import argparse
import json
import os
import sys
from collections import Counter


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def check_graph(graph, where, errors, warnings):
    nodes = graph.get("nodes", [])
    if graph.get("node_count") != len(nodes):
        errors.append("%s/%s: node_count %r != len(nodes) %d" % (
            where, graph.get("name"), graph.get("node_count"), len(nodes)))
    names = set()
    for i, node in enumerate(nodes):
        if node.get("id") != i:
            errors.append("%s/%s: node id %r at position %d" % (
                where, graph.get("name"), node.get("id"), i))
        names.add(node.get("name"))
    for edge in graph.get("edges", []):
        a, b = edge.get("from_index"), edge.get("to_index")
        if not isinstance(a, int) or not (0 <= a < len(nodes)):
            errors.append("%s/%s: bad from_index %r" % (where, graph.get("name"), a))
        if not isinstance(b, int) or not (0 <= b < len(nodes)):
            errors.append("%s/%s: bad to_index %r" % (where, graph.get("name"), b))
    for node in nodes:
        for pin in node.get("pins", []):
            for link in pin.get("linked", []):
                if link.get("node") not in names:
                    warnings.append("%s/%s: pin %s.%s links to unknown node %r" % (
                        where, graph.get("name"), node.get("name"), pin.get("name"),
                        link.get("node")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="Docs/_data", help="dump output directory")
    ap.add_argument("--summary", default=None, help="optional JSON summary path")
    args = ap.parse_args()

    root = os.path.abspath(args.data)
    index_path = os.path.join(root, "index.json")
    if not os.path.isfile(index_path):
        print("ERROR: missing %s" % index_path)
        return 1
    index = load_json(index_path)
    if not isinstance(index, list):
        print("ERROR: index.json is not a list")
        return 1

    errors, warnings = [], []
    classes = Counter()
    deep_count = 0
    graphs = 0
    expressions = 0
    instances = 0
    datatables = 0

    for entry in index:
        for key in ("package", "name", "class"):
            if not entry.get(key):
                errors.append("index entry missing %s: %r" % (key, entry))
        cls = entry.get("class", "?")
        classes[cls] += 1
        rel = entry.get("deep_file")
        if not rel:
            continue
        path = os.path.join(root, rel.replace("/", os.sep))
        if not os.path.isfile(path):
            errors.append("%s: missing deep_file %s" % (entry.get("package"), rel))
            continue
        try:
            deep = load_json(path)
        except Exception as exc:
            errors.append("%s: cannot parse %s: %r" % (entry.get("package"), rel, exc))
            continue
        deep_count += 1
        if deep.get("path") != entry.get("package"):
            errors.append("%s: deep path %r != index package" % (rel, deep.get("path")))

        bp = deep.get("blueprint")
        if bp is not None:
            for graph in bp.get("graphs", []):
                graphs += 1
                check_graph(graph, rel, errors, warnings)

        mat = deep.get("material") or deep.get("material_function")
        if mat is not None:
            exprs = mat.get("expressions")
            if not isinstance(exprs, list):
                errors.append("%s: expressions is not a list" % rel)
            else:
                expressions += len(exprs)

        mi = deep.get("material_instance")
        if mi is not None:
            instances += 1
            if not isinstance(mi.get("overrides"), list):
                errors.append("%s: overrides is not a list" % rel)

        dt = deep.get("datatable")
        if dt is not None:
            datatables += 1
            if dt.get("row_count") != len(dt.get("rows", [])):
                errors.append("%s: row_count %r != len(rows) %d" % (
                    rel, dt.get("row_count"), len(dt.get("rows", []))))

    summary = {
        "data": root,
        "assets": len(index),
        "deep_files": deep_count,
        "classes": dict(classes.most_common()),
        "blueprint_graphs": graphs,
        "material_expressions": expressions,
        "material_instances": instances,
        "datatables": datatables,
        "errors": errors,
        "warnings": warnings[:200],
        "warning_count": len(warnings),
    }
    if args.summary:
        with open(args.summary, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print("VALIDATION %s: %d error(s), %d warning(s)" % (
        "FAILED" if errors else "OK", len(errors), len(warnings)))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
