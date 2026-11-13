"""Unreal Editor Python commandlet: deep asset dumper for the FluidNinja LIVE content pack.

Run with:
  UnrealEditor-Cmd.exe <project>.uproject -run=pythonscript -script="<this file>"
      -EnablePlugins=PythonScriptPlugin -unattended -nopause -nosplash -NullRHI

The script reads Docs/_tools/dump_config.json and writes JSON files under the configured
output directory. It is read-only with respect to the project: no assets are saved.
"""

import json
import os
import re
import traceback

import unreal

PROJECT_DIR = unreal.Paths.project_dir()


def resolve_config():
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else ""
    candidates = [
        os.environ.get("UE_DUMP_CONFIG"),
        os.path.join(PROJECT_DIR, "Docs", "_tools", "dump_config.json"),
        os.path.join(here, "dump_config.json") if here else None,
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    raise SystemExit(
        "dump_config.json not found. Put it in <project>/Docs/_tools/, next to this "
        "script, or set UE_DUMP_CONFIG to its absolute path."
    )


CONFIG_PATH = resolve_config()

BLUEPRINT_CLASSES = {"Blueprint", "WidgetBlueprint", "AnimBlueprint"}
MATERIAL_CLASSES = {"Material", "MaterialInstanceConstant", "MaterialFunction"}
PARAM_PROP_NAMES = [
    "parameter_name", "default_value", "texture", "r", "g", "b", "a",
    "constant", "const_a", "const_b", "const_r", "const_g", "const_b",
    "code", "description", "output_type", "function", "coordinates",
    "sampler_type", "mip_value_mode", "collection", "material_expression",
    "layer_name", "value", "input_name", "output_name", "expression",
    "texture_object", "speed", "levels", "quality", "tiling", "normal",
    "b_is_default_meshpaint", "channel", "preview", "virtual_texture",
]


def log(msg):
    print("[NINJA_DUMP] " + str(msg))


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def stext(value):
    try:
        return str(value)
    except Exception:
        return repr(value)


def jsonable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    return stext(value)


def pos_of(node):
    p = safe(lambda: unreal.BlueprintEditorLibrary.get_node_pos(node))
    if p is None:
        return None
    return [safe(lambda: p.x, 0), safe(lambda: p.y, 0)]


def pin_info(pin):
    name = safe(lambda: stext(unreal.BlueprintGraphPinLibrary.get_pin_name(pin)), "")
    direction = safe(lambda: stext(unreal.BlueprintGraphPinLibrary.get_pin_direction(pin)), "")
    ptype = safe(lambda: stext(unreal.BlueprintGraphPinLibrary.get_pin_type_display_string(pin)), "")
    value = safe(lambda: stext(unreal.BlueprintGraphPinLibrary.get_pin_value(pin)), "")
    linked = []
    for other in safe(lambda: list(unreal.BlueprintGraphPinLibrary.list_connected_pins(pin)), []) or []:
        owner = safe(lambda: unreal.BlueprintGraphPinLibrary.get_owning_node(other))
        linked.append({
            "node": safe(lambda: owner.get_name(), None),
            "node_title": safe(lambda: stext(unreal.BlueprintEditorLibrary.get_node_title(owner)), None),
            "pin": safe(lambda: stext(unreal.BlueprintGraphPinLibrary.get_pin_name(other)), ""),
            "direction": safe(lambda: stext(unreal.BlueprintGraphPinLibrary.get_pin_direction(other)), ""),
        })
    return {"name": name, "direction": direction, "type": ptype, "value": value, "linked": linked}


def dump_graph(graph):
    out = {"name": safe(lambda: graph.get_name(), ""), "class": safe(lambda: graph.get_class().get_name(), "")}
    editor = safe(lambda: unreal.BlueprintGraphEditor.get_graph_editor(graph))
    if editor is None:
        out["error"] = "no editor"
        return out
    out["entry_pin"] = safe(lambda: stext(editor.find_graph_entry_pin()), None)
    nodes = safe(lambda: list(editor.list_all_nodes()), []) or []
    out["node_count"] = len(nodes)
    out["local_variables"] = []
    node_records = []
    name_to_index = {}
    for idx, node in enumerate(nodes):
        name_to_index[safe(lambda: node.get_name(), "node_%d" % idx)] = idx
    for idx, node in enumerate(nodes):
        record = {
            "id": idx,
            "name": safe(lambda: node.get_name(), "node_%d" % idx),
            "class": safe(lambda: node.get_class().get_name(), ""),
            "title": safe(lambda: stext(unreal.BlueprintEditorLibrary.get_node_title(node)), ""),
            "category": safe(lambda: stext(unreal.BlueprintEditorLibrary.get_node_category(node)), ""),
            "pos": pos_of(node),
        }
        pins = safe(lambda: list(unreal.BlueprintEditorLibrary.list_all_pins(node)), []) or []
        record["pins"] = [pin_info(p) for p in pins]
        node_records.append(record)
    out["nodes"] = node_records
    edges = []
    for record in node_records:
        for pin in record["pins"]:
            for link in pin["linked"]:
                if link.get("node") in name_to_index:
                    edges.append({
                        "from_index": record["id"],
                        "from_node": record["name"],
                        "from_pin": pin["name"],
                        "to_index": name_to_index[link["node"]],
                        "to_node": link["node"],
                        "to_pin": link.get("pin"),
                    })
    out["edges"] = edges
    comments = []
    for c in safe(lambda: list(editor.list_comment_nodes()), []) or []:
        contained = safe(lambda: list(unreal.BlueprintEditorLibrary.get_nodes_in_comment(c)), []) or []
        comments.append({
            "text": safe(lambda: stext(unreal.BlueprintEditorLibrary.get_comment_text(c)), ""),
            "color": safe(lambda: stext(unreal.BlueprintEditorLibrary.get_comment_color(c)), ""),
            "nodes": [safe(lambda: x.get_name(), "") for x in contained],
        })
    out["comments"] = comments
    return out


def dump_variables(bp):
    names = safe(lambda: list(unreal.BlueprintEditorLibrary.list_member_variable_names(bp)), []) or []
    cdo = safe(lambda: unreal.get_default_object(bp.generated_class()) if bp.generated_class() else None)
    result = []
    for name in names:
        var = {"name": stext(name)}
        vtype = safe(lambda: unreal.BlueprintEditorLibrary.get_member_variable_type(bp, name))
        var["type"] = safe(lambda: stext(vtype.export_text()), "") if vtype else ""
        var["category"] = safe(lambda: stext(unreal.BlueprintEditorLibrary.get_blueprint_variable_category(bp, name)), "")
        var["replication"] = safe(lambda: stext(unreal.BlueprintEditorLibrary.get_blueprint_variable_replication(bp, name)), "")
        if cdo:
            value = safe(lambda: cdo.get_editor_property(stext(name)), None)
            var["default"] = jsonable(value)
        result.append(var)
    return result


def dump_blueprint(asset):
    out = {}
    gc = safe(lambda: asset.generated_class())
    out["generated_class"] = safe(lambda: gc.get_path_name(), None)
    out["parent_class"] = safe(lambda: stext(gc.get_editor_property("SuperStruct")), None)
    out["variables"] = dump_variables(asset)
    out["functions"] = []
    for f in safe(lambda: list(unreal.BlueprintEditorLibrary.list_functions(asset)), []) or []:
        out["functions"].append({
            "name": safe(lambda: stext(f.name), ""),
            "description": safe(lambda: stext(f.description), ""),
            "implemented": safe(lambda: f.is_implemented, None),
        })
    out["events"] = []
    for f in safe(lambda: list(unreal.BlueprintEditorLibrary.list_events(asset)), []) or []:
        out["events"].append({
            "name": safe(lambda: stext(f.name), ""),
            "description": safe(lambda: stext(f.description), ""),
            "implemented": safe(lambda: f.is_implemented, None),
        })
    graphs = []
    graph_list = safe(lambda: list(unreal.BlueprintEditorLibrary.list_graphs(asset)), []) or []
    for graph in graph_list:
        try:
            graphs.append(dump_graph(graph))
        except Exception as e:
            graphs.append({"name": safe(lambda: graph.get_name(), ""), "error": repr(e)})
    out["graph_count"] = len(graphs)
    out["graphs"] = graphs
    return out


def expression_props(expr):
    props = {}
    for prop in PARAM_PROP_NAMES:
        value = safe(lambda p=prop: expr.get_editor_property(p), None)
        if value is not None:
            props[prop] = jsonable(value)
    text = safe(lambda: stext(expr.export_text()), None)
    if text:
        props["export_text"] = text
    return props


def dump_material_asset(asset, is_function=False):
    out = {}
    if not is_function:
        for prop in ("MaterialDomain", "BlendMode", "ShadingModel", "TwoSided",
                     "bUseMaterialAttributes", "UsedShadingModels", "OpacityMaskClipValue"):
            value = safe(lambda p=prop: asset.get_editor_property(p), None)
            if value is not None:
                out[prop] = jsonable(value)
    out["parameters"] = {}
    for key, fn in (
        ("scalar", "get_scalar_parameter_names"),
        ("vector", "get_vector_parameter_names"),
        ("texture", "get_texture_parameter_names"),
        ("static_switch", "get_static_switch_parameter_names"),
    ):
        names = safe(lambda f=fn, a=asset: list(getattr(unreal.MaterialEditingLibrary, f)(a)), []) or []
        out["parameters"][key] = [stext(n) for n in names]
    stats = safe(lambda: unreal.MaterialEditingLibrary.get_statistics(asset), None)
    if stats is not None:
        out["statistics"] = {}
        for stat in ("num_vertex_shader_instructions", "num_pixel_shader_instructions", "num_samplers",
                     "num_vertex_texture_samples", "num_pixel_texture_samples",
                     "num_virtual_texture_samples", "num_uv_scalars", "num_interpolator_scalars"):
            out["statistics"][stat] = safe(lambda s=stat: jsonable(stats.get_editor_property(s)), None)
    out["used_textures"] = []
    for t in safe(lambda: list(unreal.MaterialEditingLibrary.get_used_textures(asset)), []) or []:
        out["used_textures"].append(safe(lambda: t.get_path_name(), None))
    if is_function:
        exprs = safe(lambda: list(unreal.MaterialEditingLibrary.get_material_function_expressions(asset)), []) or []
    else:
        exprs = safe(lambda: list(unreal.MaterialEditingLibrary.get_material_expressions(asset)), []) or []
    out["expressions"] = []
    for expr in exprs:
        record = {
            "name": safe(lambda: expr.get_name(), ""),
            "class": safe(lambda: expr.get_class().get_name(), ""),
            "props": expression_props(expr),
        }
        x = safe(lambda: expr.get_editor_property("MaterialExpressionEditorX"), 0)
        y = safe(lambda: expr.get_editor_property("MaterialExpressionEditorY"), 0)
        record["pos"] = [x, y]
        inputs = safe(lambda: list(unreal.MaterialEditingLibrary.get_material_expression_input_names(expr)), []) or []
        outputs = safe(lambda: list(unreal.MaterialEditingLibrary.get_material_expression_output_names(expr)), []) or []
        if is_function:
            connected = safe(lambda: list(unreal.MaterialEditingLibrary.get_inputs_for_material_function_expression(asset, expr)), []) or []
        else:
            connected = safe(lambda: list(unreal.MaterialEditingLibrary.get_inputs_for_material_expression(asset, expr)), []) or []
        conn_names = [safe(lambda c=c: c.get_name(), None) if c else None for c in connected]
        record["inputs"] = []
        for i, in_name in enumerate(inputs):
            record["inputs"].append({
                "name": stext(in_name),
                "connected": conn_names[i] if i < len(conn_names) else None,
            })
        record["outputs"] = [stext(o) for o in outputs]
        out["expressions"].append(record)
    return out


def dump_material_instance(asset):
    out = {}
    out["parent"] = safe(lambda: asset.get_editor_property("Parent").get_path_name(), None)
    overrides = []
    for kind, prop in (
        ("scalar", "ScalarParameterValues"),
        ("vector", "VectorParameterValues"),
        ("texture", "TextureParameterValues"),
    ):
        values = safe(lambda p=prop: list(asset.get_editor_property(p)), []) or []
        for item in values:
            info = safe(lambda i=item: i.get_editor_property("parameter_info"))
            name = safe(lambda i=info: i.get_editor_property("name"), "")
            value = safe(lambda i=item: i.get_editor_property("parameter_value"), None)
            if kind == "vector" and value is not None:
                value = {
                    "r": safe(lambda v=value: v.get_editor_property("r"), None),
                    "g": safe(lambda v=value: v.get_editor_property("g"), None),
                    "b": safe(lambda v=value: v.get_editor_property("b"), None),
                    "a": safe(lambda v=value: v.get_editor_property("a"), None),
                }
            else:
                value = jsonable(value)
            overrides.append({"kind": kind, "name": stext(name), "value": value})
    out["overrides"] = overrides
    return out


def dump_datatable(asset):
    out = {}
    out["row_struct"] = safe(lambda: asset.get_editor_property("RowStruct").get_path_name(), None)
    rows_json = safe(lambda: unreal.DataTableFunctionLibrary.export_data_table_to_json_string(asset))
    out["rows"] = []
    if rows_json:
        parsed = safe(lambda: json.loads(rows_json), None)
        if parsed is not None:
            out["rows"] = parsed
    out["row_count"] = len(out["rows"])
    return out


def asset_tags(asset_data):
    tags = {}
    raw = safe(lambda: asset_data.tags, None)
    if raw:
        try:
            for k in raw.keys():
                tags[stext(k)] = stext(raw[k])
        except Exception:
            pass
    if not tags:
        for key in ("ParentClass", "NativeParentClass", "GeneratedClass", "BlueprintType",
                    "BlueprintDescription", "MaterialDomain", "BlendMode", "ShadingModel",
                    "RowStructure", "NumRows"):
            value = safe(lambda k=key: asset_data.get_tag_value(k), None)
            if value:
                tags[key] = stext(value)
    return tags


def dependencies(asset_data):
    options = safe(lambda: unreal.AssetRegistryDependencyOptions(
        include_soft_package_references=True,
        include_hard_package_references=True,
        include_searchable_names=False,
        include_soft_management_references=False,
        include_hard_management_references=False,
    ))
    if options is None:
        return []
    deps = safe(lambda: unreal.AssetRegistryHelpers.get_asset_registry().get_dependencies(asset_data.package_name, options), [])
    return [stext(d) for d in (deps or [])]


def sanitize(path):
    name = path.replace("/Game/", "")
    name = re.sub(r"[^A-Za-z0-9_.-]+", "__", name)
    return name + ".json"


def main():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)
    log("config=%s" % CONFIG_PATH)
    output_dir = os.path.join(PROJECT_DIR, config.get("output_dir", "Docs/_data"))
    assets_dir = os.path.join(output_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    deep_classes = set(config.get("deep_classes", []))
    roots = config.get("roots", ["/Game/FluidNinjaLive"])
    limit = config.get("limit", 0)
    ar = unreal.AssetRegistryHelpers.get_asset_registry()
    all_assets = []
    for root in roots:
        all_assets.extend(list(ar.get_assets_by_path(root, recursive=True)))
    log("assets=%d roots=%s" % (len(all_assets), roots))
    index = []
    processed = 0
    for asset_data in all_assets:
        if limit and processed >= limit:
            break
        package = stext(asset_data.package_name)
        asset_name = stext(asset_data.asset_name)
        cls = stext(asset_data.asset_class_path.asset_name)
        entry = {
            "package": package,
            "name": asset_name,
            "class": cls,
            "tags": asset_tags(asset_data),
            "dependencies": dependencies(asset_data),
        }
        if cls in deep_classes:
            entry["deep_file"] = "assets/" + sanitize(package)
            try:
                asset = unreal.load_asset(package)
                if asset is None:
                    raise RuntimeError("load_asset returned None")
                deep = {"path": package, "name": asset_name, "class": cls,
                        "tags": entry["tags"], "dependencies": entry["dependencies"]}
                if cls in BLUEPRINT_CLASSES:
                    deep["blueprint"] = dump_blueprint(asset)
                elif cls == "Material":
                    deep["material"] = dump_material_asset(asset, is_function=False)
                elif cls == "MaterialFunction":
                    deep["material_function"] = dump_material_asset(asset, is_function=True)
                elif cls == "MaterialInstanceConstant":
                    deep["material_instance"] = dump_material_instance(asset)
                elif cls == "DataTable":
                    deep["datatable"] = dump_datatable(asset)
                with open(os.path.join(output_dir, entry["deep_file"]), "w", encoding="utf-8") as f:
                    json.dump(deep, f, ensure_ascii=False, indent=1, default=str)
            except Exception as e:
                entry["deep_error"] = repr(e)
                log("ERROR %s: %s\n%s" % (package, repr(e), traceback.format_exc()))
        index.append(entry)
        processed += 1
        if processed % 25 == 0:
            log("progress %d/%d" % (processed, len(all_assets)))
    with open(os.path.join(output_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1, default=str)
    log("DONE assets_indexed=%d" % len(index))


main()
