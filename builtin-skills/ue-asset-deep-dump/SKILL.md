---
name: ue-asset-deep-dump
description: >
  Deep-dump Unreal Engine content-pack assets with a read-only Python commandlet:
  Blueprint graphs, nodes, pins and links; material expressions; MaterialInstance
  overrides; DataTables; dependencies and tags. Produces JSON indexes, validation
  summaries, node-graph SVGs, and Markdown/HTML documentation. Use when asked to
  inspect or dump UE assets, reverse-engineer a content-only plugin with no C++
  source, generate graph SVGs, or troubleshoot UnrealEditor-Cmd pythonscript.
license: MIT
metadata:
  author: heguoling
  version: "1.0.0"
allowed-tools:
  - Bash(python:*)
  - Bash(python3:*)
  - Bash(UnrealEditor-Cmd:*)
  - Bash(node:*)
  - PowerShell
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# UE 资产深度解析（ue-asset-deep-dump）

把 Unreal Engine 内容包（尤其是没有 C++/`.uplugin` 源码的纯资产插件）解析成可查询的 JSON，再基于证据写模块文档、节点图 SVG 与离线 HTML。核心原则：**只读资产、节点级取证、推断必须标注**。

## Inputs

- `$uproject`：可选，`.uproject` 路径；缺省从当前目录向上查找。
- `$root`：可选，内容根路径，默认 `/Game`；内容包通常设为 `/Game/<PackName>`。
- `$out`：可选，输出目录，默认 `<project>/Docs/_data`。
- `$ue`：可选，`UnrealEditor-Cmd.exe` 路径；缺省按 `EngineAssociation` 自动探测。
- `$docs`：可选，文档输出目录，默认 `<project>/Docs/<PackName>`。

## Goal

产出一套可复核的资产证据链：

- `<out>/index.json`：全部资产的路径、类、tags、依赖。
- `<out>/assets/*.json`：蓝图图/节点/pin/连线、材质表达式、MI 覆写、DataTable 行。
- `<out>/validation.json`：结构校验结果，硬错误为 0。
- 可选的模块 Markdown、`assets/graphs/*.svg`、`assets/materials/*.svg` 与单文件 HTML。
- 文档中的每条结论都能追到“资产路径 + 图/节点/表达式/参数”。

## Quick start

```powershell
# 1) 把 references/dump_assets.py 与 dump_config.json 放到 <project>/Docs/_tools/
# 2) 改 roots 为内容包目录，limit 先设 20 做 smoke test
& "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" `
  "E:/Proj/MyProject.uproject" `
  -run=pythonscript `
  -script="E:/Proj/Docs/_tools/dump_assets.py" `
  -EnablePlugins=PythonScriptPlugin -unattended -nopause -nosplash -NullRHI `
  -stdout -FullStdOutLogOutput
```

看到 `[NINJA_DUMP] DONE assets_indexed=N` 后再把 `limit` 改回 `0` 全量跑。

## Steps

### 1. 定位工程、引擎与内容根

1. 从当前目录向上找 `*.uproject`；若找到多个，让用户选。
2. 读 `.uproject` 的 `EngineAssociation`（如 `5.8`、自定义 Launcher 构建）。
3. 定位引擎：
   - `where.exe UnrealEditor-Cmd.exe`
   - `Get-ChildItem "C:\Program Files\Epic Games\UE_*\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"`
   - 注册表：`Get-ItemProperty 'HKLM:\SOFTWARE\EpicGames\Unreal Engine\*' InstalledDirectory`
4. 确认内容根：优先内容包的顶层目录（如 `/Game/FluidNinjaLive`），不要默认全 `/Game`。

**Success criteria**：`uproject`、`UnrealEditor-Cmd.exe`、内容根、输出目录四项都是绝对路径且存在；引擎主版本与 `EngineAssociation` 一致。
**Rules**：不要猜引擎版本。版本不匹配时 Python API 可能缺方法，表现为大量 `deep_error`。

### 2. 配置导出脚本

1. 复制 `references/dump_assets.py` 到 `<project>/Docs/_tools/dump_assets.py`（也可从 skill 目录直接运行）。
2. 复制 `references/dump_config.json` 到 `<project>/Docs/_tools/dump_config.json`。
3. 修改：
   - `roots`：内容包目录。
   - `output_dir`：默认 `Docs/_data`，相对工程根。
   - `deep_classes`：默认 Blueprint / WidgetBlueprint / AnimBlueprint / Material / MaterialFunction / MaterialInstanceConstant / DataTable。
   - `limit`：首次 smoke test 设 20，确认后设 0。
4. 配置解析顺序（脚本已实现）：`UE_DUMP_CONFIG` → `<project>/Docs/_tools/dump_config.json` → 脚本同目录 `dump_config.json`。

**Success criteria**：配置是合法 JSON；`python -c "import json;json.load(...)"` 通过；`roots` 与工程内实际目录一致。
**Artifacts**：`dump_assets.py`、`dump_config.json`。

### 3. 运行 commandlet 导出

```powershell
& $ue $uproject `
  -run=pythonscript `
  -script="$script" `
  -EnablePlugins=PythonScriptPlugin `
  -unattended -nopause -nosplash -NullRHI `
  -stdout -FullStdOutLogOutput | Tee-Object -FilePath $log
```

- `-script` 与 `-uproject` 使用**正斜杠**。反斜杠 + 中文/特殊路径在部分版本会被错误解码成 `E:å.8`。
- 不要加 `-game`；资产 API 需要编辑器环境。
- 不要省略 `-unattended -nopause -nosplash -NullRHI`，否则可能弹窗挂死。
- 退出码 0 不代表每个资产都成功；以日志 `DONE` 与 `ERROR` 行为准。

**Success criteria**：日志出现 `[NINJA_DUMP] DONE assets_indexed=N`；`index.json` 存在；`assets/` 下深度文件数与 `deep_classes` 命中数一致（允许记录在案的 `deep_error`）。
**Artifacts**：`index.json`、`assets/*.json`、运行日志。
**Rules**：失败时保留原始 stderr/日志尾部；不要用“重跑一次”掩盖路径/版本错误。

### 4. 校验与汇总

```powershell
python -I "<skill>/references/validate_dump.py" --data "<out>" --summary "<out>/validation.json"
```

校验项：

- `index.json` 是列表，条目含 `package/name/class`。
- 每个 `deep_file` 存在、可解析、`path` 与索引一致。
- 蓝图图：`node_count == len(nodes)`、节点 id 连续、边的两端是合法索引、链接 pin 指向存在的节点。
- 材质/函数：`expressions` 是列表。
- MI：`overrides` 是列表（为空合法）。
- DataTable：`row_count == len(rows)`。

再做汇总：类计数、目录计数、图规模 Top N、材质表达式数、MI 覆写数、DataTable 行数、`deep_error` 清单。

**Success criteria**：`VALIDATION OK: 0 error(s)`；警告逐条解释或修复；汇总数字与 `index.json` 可复算。
**Artifacts**：`validation.json`、汇总表/摘要。

### 5. 模块分析与文档

1. 按目录/类把资产分成模块（Core、Input、Output、Volumetrics、Presets、Examples…）。
2. 对每个模块读深度 JSON：
   - 蓝图：变量分类、图列表、入口事件、Exec 链、关键节点 pin 值/连线、注释。
   - 材质：表达式链、常量、参数名、`export_text()`、函数调用。
   - MI：只读 `ScalarParameterValues` / `VectorParameterValues` / `TextureParameterValues` 三个覆写数组。
   - DataTable：行 schema 与实际值。
   - 依赖/tags：跨模块引用。
3. 写作时给每条结论附证据：资产路径 + 图名 + 节点标题/序号/表达式名。
4. 不能从资产确认的内容标 **（推断）**，并把未确认项集中到章节末尾。
5. 资产多时可分派 worker，每个 worker 只拥有一篇文档；给统一模板：范围、证据、公式、图表、未确认项。

**Success criteria**：每篇模块文档都有证据表/图；关键数字（节点数、变量数、表达式数、实例数）能从 JSON 复算；推断与事实分开。
**Rules**：不要用官方教程替代资产证据；不要凭类名猜行为。

### 6. 生成 SVG、Markdown 与 HTML

**节点图 / 材质图**：

```powershell
python "<skill>/references/graph_to_svg.py" `
  --asset "<out>/assets/<AssetFile>.json" `
  --graph "<GraphName>" `
  --out "<docs>/assets/graphs/<Name>.svg"

python "<skill>/references/graph_to_svg.py" `
  --asset "<out>/assets/<MaterialFile>.json" `
  --material `
  --out "<docs>/assets/materials/<Name>.svg"
```

**Markdown**：图片用相对路径；每张图配一句“这张图证明了什么”。

**HTML**（可选，但推荐）：

- 若环境有 `design-doc-html` skill，按它的管线合并 Markdown、预渲染 Mermaid、内联 SVG、构建单文件 HTML。
- 必须校验：Mermaid 全部渲染、SVG 引用无缺失、`dupIds=[]`、`brokenAnchors=[]`、控制台无错误、390px 下 `scrollWidth==innerWidth`。
- 统计数字（行数、图数、表数、代码块数）由脚本生成，不要手写。

**Success criteria**：所有 `assets/**.svg` 存在且 XML 合法；HTML 离线可打开；校验硬门全过；README/目录统计与实际一致。

## Hard rules

- **只读**：只 `load_asset`/读属性；绝不 `save_asset`、`delete_asset`、`set_editor_property`。
- **不要读 `EdGraph.Nodes`**：它是 protected；用 `BlueprintGraphEditor.get_graph_editor(graph).list_all_nodes()` 与 `BlueprintGraphPinLibrary`。
- **MI 覆写只信数组**：`get_scalar_parameter_value()` 常返回父级默认值；用 `ScalarParameterValues` / `VectorParameterValues` / `TextureParameterValues`。
- **DataTable 用导出**：`DataTableFunctionLibrary.export_data_table_to_json_string(asset)`，不要逐行猜属性。
- **路径正斜杠**：`-script="E:/.../dump_assets.py"`；避免 `E:\...` 在 commandlet 中被错误解码。
- **失败分级**：引擎/工程/配置失败立即停；单资产失败记 `deep_error` 并继续，最后汇总。
- **证据优先**：无法确认的常量、Niagara 内部、RVT 更新策略、static switch 实际值，一律标推断。

## Troubleshooting

| 症状 | 原因 | 处理 |
|---|---|---|
| `EdGraph.Nodes` protected / 无法访问 | Python 暴露限制 | 改用 GraphEditor + PinLibrary API |
| 日志路径变成 `E:å.8` | 反斜杠 + 非 ASCII 路径被错误解码 | `-script` 改正斜杠并加引号 |
| `load_asset` 返回 None | 包路径错、插件未启用、资产类不匹配 | 先查 `index.json` 的 package；确认 `-EnablePlugins=PythonScriptPlugin` |
| MI 覆写全为空 | 用了 `get_*_parameter_value` | 改读三个 `*ParameterValues` 数组 |
| DataTable 行数不对 | 用 `get_row_names()` 代替导出 | 用 `export_data_table_to_json_string` |
| commandlet 挂住/弹窗 | 缺 `-unattended -nopause -nosplash -NullRHI` | 补齐参数；不要加 `-game` |
| 大量 `deep_error` | 引擎版本不匹配 / API 改名 | 核对 `EngineAssociation`；对缺失方法做 `safe()` 降级并记录 |
| 中文控制台乱码 | 终端编码 | 以 UTF-8 JSON 文件为准；日志只作定位 |
| HTML 图缺失 | SVG 路径大小写/相对路径错 | 用脚本校验所有 `assets/**.svg` 引用存在 |

## References

| 文件 | 用途 |
|---|---|
| `references/dump_assets.py` | 只读 commandlet：索引 + 蓝图/材质/MI/DataTable 深度导出 |
| `references/dump_config.json` | roots / deep_classes / output_dir / limit 配置模板 |
| `references/validate_dump.py` | JSON 结构、图节点/边、MI/DT 一致性校验 |
| `references/graph_to_svg.py` | 蓝图图与材质表达式图转独立 SVG |
| `references/unreal_python_api.md` | UE Python API 配方、坑位与版本差异 |
