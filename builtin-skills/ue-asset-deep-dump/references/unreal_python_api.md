# Unreal Python 资产解析配方

本文件是 `dump_assets.py` 的 API 备注。API 名称在 UE 5.3–5.8 基本稳定；不同版本缺方法时用 `hasattr`/`safe()` 降级并记录错误。

## 1. 资产注册表与加载

```python
ar = unreal.AssetRegistryHelpers.get_asset_registry()
assets = ar.get_assets_by_path("/Game/YourContent", recursive=True)
for a in assets:
    print(a.package_name, a.asset_name, a.asset_class_path.asset_name)
```

- `get_assets_by_path` 只返回已加载/可发现的资产；未挂载的插件内容不会出现。
- 读 tags 用 `asset_data.tags`，不要假设一定有 `ParentClass`。
- 依赖：

```python
opts = unreal.AssetRegistryDependencyOptions(
    include_soft_package_references=True,
    include_hard_package_references=True,
)
deps = ar.get_dependencies(asset_data.package_name, opts)
```

## 2. 蓝图：图、节点、pin、连线

`EdGraph.Nodes` 是 protected，Python 不能直接读。用编辑器 API：

```python
editor = unreal.BlueprintGraphEditor.get_graph_editor(graph)
nodes = editor.list_all_nodes()
for node in nodes:
    title = unreal.BlueprintEditorLibrary.get_node_title(node)
    pos = unreal.BlueprintEditorLibrary.get_node_pos(node)
    pins = unreal.BlueprintEditorLibrary.list_all_pins(node)
    for pin in pins:
        name = unreal.BlueprintGraphPinLibrary.get_pin_name(pin)
        value = unreal.BlueprintGraphPinLibrary.get_pin_value(pin)
        linked = unreal.BlueprintGraphPinLibrary.list_connected_pins(pin)
        for other in linked:
            owner = unreal.BlueprintGraphPinLibrary.get_owning_node(other)
```

- `get_pin_value` 是字符串；未连接 pin 的默认值也在这里。
- 连线是双向的：从 A 的 output pin 能找到 B 的 input pin；建边时用“节点名 -> index”映射，避免重复边。
- 注释节点：`editor.list_comment_nodes()` + `BlueprintEditorLibrary.get_nodes_in_comment(c)` + `get_comment_text(c)`。
- 变量默认值：`bp.generated_class()` → `unreal.get_default_object(...)` → `cdo.get_editor_property(name)`。
- 图入口：`editor.find_graph_entry_pin()`；事件图通常没有单一入口，需要从 Event 节点/Exec 链自行追踪。

## 3. 材质与材质函数

```python
exprs = unreal.MaterialEditingLibrary.get_material_expressions(material)
# MaterialFunction 用：
exprs = unreal.MaterialEditingLibrary.get_material_function_expressions(mf)
```

每个表达式：

```python
expr.get_name()
expr.get_class().get_name()
expr.get_editor_property("MaterialExpressionEditorX")
expr.export_text()                       # 常量/参数名/函数名的最佳来源
MaterialEditingLibrary.get_material_expression_input_names(expr)
MaterialEditingLibrary.get_material_expression_output_names(expr)
MaterialEditingLibrary.get_inputs_for_material_expression(material, expr)
# MaterialFunction：
MaterialEditingLibrary.get_inputs_for_material_function_expression(mf, expr)
```

- 不要遍历表达式对象的私有属性；按类名读取已知 editor property，并用 `export_text()` 兜底。
- 参数列表：`get_scalar_parameter_names` / `get_vector_parameter_names` / `get_texture_parameter_names` / `get_static_switch_parameter_names`。
- 统计：`get_statistics(material)`；不同版本字段可能缺失，用 `safe()`。
- 材质函数表达式的“输入连接”依赖函数输入节点，`get_inputs_for_material_function_expression` 更可靠。

## 4. 材质实例：只信覆写数组

`get_scalar_parameter_value()` 往往返回父材质默认值，不是实例覆写值。要拿真实覆写：

```python
for item in mi.get_editor_property("ScalarParameterValues"):
    info = item.get_editor_property("parameter_info")
    name = info.get_editor_property("name")
    value = item.get_editor_property("parameter_value")

for item in mi.get_editor_property("VectorParameterValues"):
    info = item.get_editor_property("parameter_info")
    value = item.get_editor_property("parameter_value")  # LinearColor

for item in mi.get_editor_property("TextureParameterValues"):
    info = item.get_editor_property("parameter_info")
    value = item.get_editor_property("parameter_value")  # Texture
```

- 三个数组为空是合法的（实例可能只改父级/静态开关）。
- `ScalarParameterValues` 的 `parameter_value` 是 float；Vector 是 `LinearColor`（r/g/b/a）。
- 静态开关覆写不在上述数组里；需要父材质参数名 + 实例的 `get_static_switch_parameter_value`（若版本支持），否则标注未确认。

## 5. DataTable

```python
row_struct = dt.get_editor_property("RowStruct").get_path_name()
raw = unreal.DataTableFunctionLibrary.export_data_table_to_json_string(dt)
rows = json.loads(raw)
```

- `export_data_table_to_json_string` 返回的是 JSON 字符串；不要逐行读 RowMap。
- 行结构里的 `Name`/`String`/`Struct` 会以 JSON 对象/字符串出现；保留原样。
- 行数用 `len(rows)`，不要用 `get_row_names()` 的数量代替（可能包含空行）。

## 6. 路径与编码

- commandlet 的 `-script` 用正斜杠：`-script="E:/Proj/Docs/_tools/dump_assets.py"`。反斜杠 + 中文/特殊路径在部分 UE 版本会被错误解码成 `E:å.8`。
- `.uproject` 也建议正斜杠；整体加引号。
- 控制台中文可能乱码，但写出的 JSON 用 `encoding="utf-8"` 是正确的；以文件为准。
- 文件名清洗：`package.replace("/Game/", "")`，非 `[A-Za-z0-9_.-]` 替换为 `__`，加 `.json`。

## 7. commandlet 参数

```text
UnrealEditor-Cmd.exe <project>.uproject
  -run=pythonscript
  -script="<absolute/forward/slash/dump_assets.py>"
  -EnablePlugins=PythonScriptPlugin
  -unattended -nopause -nosplash -NullRHI
  -stdout -FullStdOutLogOutput
```

- 不要加 `-game`；需要编辑器资产 API。
- `-NullRHI` 避免无显卡/远程会话弹窗；资产读取不需要渲染。
- 退出码 0 不代表每个资产都成功；检查日志里的 `[NINJA_DUMP] DONE` 与 `ERROR` 行。
- 首次 smoke test 把 `limit` 设为 20，确认 Python 插件、路径、输出目录都正确后再全量。
