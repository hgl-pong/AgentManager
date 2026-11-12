---
name: cpp-windows-debug
description: >
  Build and debug C++ projects on Windows with CMake, Visual Studio/MSVC,
  MSBuild, and Incredibuild, then diagnose failures with cdb scripts or the
  Visual Studio debugger. Use when the user asks to configure CMake, generate
  or build a .sln, choose Debug/Release, set or filter breakpoints, step through
  source, inspect call stacks, locals, STL values, threads, handle C++ or
  access-violation exceptions, analyze crash dumps, attach to a running process,
  or run a build-fix-rebuild regression loop.
license: MIT
metadata:
  author: heguoling
  version: "1.0.0"
allowed-tools:
  - Bash(cmake:*)
  - Bash(msbuild:*)
  - Bash(BuildConsole:*)
  - Bash(cdb:*)
  - PowerShell
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# C++ Windows Build & Debug

Build and debug a Windows C++ project end to end. This skill is AI-first: use
cdb scripts for reproducible, text-based evidence; use Visual Studio for human
interaction when needed. Never invent debugger output — capture raw output.

## Inputs

- `$project` (optional): project root; defaults to the current directory.
- `$config` (optional): `Debug` (default), `Release`, or `RelWithDebInfo`.
- `$target` (optional): executable target; infer from CMake or the solution.
- `$task` (optional): `build`, `debug`, `dump`, or `attach`; default is build + debug.

## Goal

Produce a verified build with matching PDBs. For a bug: capture a reproducible
debugger session, apply a minimal fix, rebuild, and rerun the same session.
Success is evidence (program output, breakpoint hit, stack, locals, dump
analysis), not merely "it compiles".

## Hard Rules

- Match architecture: an x64 target needs x64 cdb and a 64-bit VS debugger.
- Prefer Incredibuild for large builds; prefer local builds for small ones.
  If IB is installed but its slot is busy: large project -> wait/report;
  small project -> fall back to local MSBuild. If IB is not installed -> local.
- Never stop another task's IB build. Run `BuildConsole /LIST` first; only stop
  your own build.
- MSVC plus non-ASCII sources: add `/utf-8` or save as UTF-8 with BOM.
  Otherwise code page 936 can emit C4819 and bizarre C2039/C1075 errors.
- Keep PDBs in Debug and Release (`/Zi`, `/DEBUG`); use Debug or RelWithDebInfo
  for source-level stepping.
- cdb: `p` is step, not print. Use `??` for expression values and `dx` for STL.
- cdb `j` is a CONTINUE condition: `j (expr) 'gc'` continues when expr is true.
- `.echo` text must not contain `;`; cdb treats it as a command separator.
- `.printf` variable arguments use `@@c++(var)`.
- `ba` is a hardware breakpoint: at most 4, no read-only mode, triggers after
  the access. Use `dv`/`??` for the post-access value.
- Use `!lmi`, not `lmi`. Use `.dump /ma /o` to overwrite an existing dump.
- `crash.cdb` and `throw.cdb` need `--crash` / `--throw` on the target command
  line; a `-cf` script cannot change the target's arguments.
- Verify breakpoint lines with `bl` and `ls`; line numbers drift after edits.
- Do not disturb a user's existing Visual Studio instance if it is building or
  debugging another solution. Prefer cdb or a separate VS instance.

## Steps

### 1. Discover the toolchain and project shape

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
  -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath
cmake --version
(Get-Command cmake, ninja, BuildConsole -ErrorAction SilentlyContinue).Source
& "C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe" -version
```

Identify:
- CMake project (`CMakeLists.txt`) or an existing `.sln`.
- Source count and existing build dirs; classify large vs small.
- Target architecture and whether IB is installed.

**Artifacts**: tool paths/versions, project kind, size class, architecture.
**Success criteria**: every required tool is resolved, and the build strategy is chosen.

### 2. Configure CMake or locate the solution

```powershell
cmake -S <project> -B <project>\build-vs -G "Visual Studio 17 2022" -A x64
```

For CMake, set a startup project if the generated solution lacks one:

```cmake
set_property(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
             PROPERTY VS_STARTUP_PROJECT <target>)
```

For an existing solution, locate the `.sln` and list its configurations
(`Debug|x64`, `Release|x64`, etc.).

**Artifacts**: solution path, build directory, config list.
**Success criteria**: the `.sln`/`.vcxproj` exists and the requested config is valid.

### 3. Build with Incredibuild or local MSBuild

Choose the engine by project size and license availability:

| Project size | IB installed? | IB slot free? | Action |
|---|---|---|---|
| Large | yes | yes | `BuildConsole` |
| Large | yes | no | report and wait; do not silently switch |
| Large | no | - | local fallback (slower) |
| Small | yes | yes | `BuildConsole` |
| Small | yes | no | local fallback |
| Small | no | - | local |

Treat engine/game/UE-scale or thousands of translation units as large; a demo
or library with tens of TUs as small.

```powershell
BuildConsole <solution.sln> /build "<config>|x64" /nologo /log=<build.log>
BuildConsole /LIST      # inspect running builds and the busy slot
cmake --build <build-dir> --config <config> -- /m
```

**Artifacts**: `<target>.exe` and `<target>.pdb`, build log, exit code.
**Success criteria**: build exits 0; exe and PDB exist; no new warnings/errors.

### 4. Prepare the debug context

- Locate `<exe>` and the matching PDB (usually the same directory).
- Record target arguments (`--crash`, `--throw`, `--wait`, config paths).
- Verify symbols and line info before debugging:

```text
.lines
.settings set Sources.SkipCrtCode = true
.srcpath <source-dir>
lsf <source-dir>\<file>.cpp
l+s
l+t
lm m <module>
!lmi <module>
```

- Breakpoint lines can shift; confirm with `bl` and `ls`.

**Artifacts**: exe path, PDB path, source path, target arguments.
**Success criteria**: cdb reports PDB symbols loaded and a source line resolves.

### 5. Run core cdb debugging

```powershell
& "C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe" `
  -o -cf <script.cdb> <exe> [args]
```

```text
bp `file.cpp:37`        $$ line breakpoint
bp module!function      $$ function breakpoint
bl                      $$ list breakpoints
g                       $$ continue
p / t / gu              $$ step over / into / out (source-level with l+t)
kb                      $$ stack with arguments and source lines
kn                      $$ frame numbers
.frame <n>              $$ switch frame
dv /t /v                $$ locals with types
?? expression           $$ C++ expression value
dx variable             $$ NatVis / STL expansion
q                       $$ quit
```

**Artifacts**: breakpoint hit, stack, locals, expression values.
**Success criteria**: the suspected path is hit and state is captured as text.

### 6. Use advanced breakpoints and inspect state

- Conditional: ``bp `file.cpp:70` "j (@@c++(i) != 3) 'gc'"`` stops when `i == 3`.
- Hit count: `r $t0 = 0` + ``bp `file.cpp:73` "r $t0=@$t0+1; j (@$t0<3) 'gc'"``.
- Tracepoint: ``bp `file.cpp:73` ".printf \"i=%d\\n\", @@c++(i); gc"``.
- Watchpoint: `ba w4 &variable` (write) / `ba r4 &variable` (read or write).
- Registers: `r`; disassembly: `u`, `uf module!function`.
- Memory: `db/dw/dd/dq/da <addr>`; types: `dt`, `dx`.
- Modules/PDB: `lm`, `lm v m <name>`, `!lmi <name>`.
- Symbols/bulk breakpoints: `x module!pattern`, `bm module!pattern`.
- Threads: `~*k`, `~<n>s`, `~*e <cmd>`.

**Success criteria**: the filter/watchpoint fires on the intended case and the
state is captured. Do not claim a conditional breakpoint filters if every hit
takes the same branch.

### 7. Handle exceptions, dumps, and attach

- C++ exception: `sxe eh` -> `g` -> `.exr -1` -> `kb` -> break at the catch
  line -> `g`.
- Access violation: `sxe av` -> `g` -> `.exr -1` -> `kb` -> `~*k`.
- Write/analyze a dump:

```text
.dump /ma /o <crash.dmp>
```

```powershell
cdb -z <crash.dmp> -c ".ecxr; kb; lm; !analyze -v; q"
```

- Attach: `cdb -p <pid>` -> `~*k` -> `~<n>s` -> `qd`.
- Prefer `/m` (minidump) when full memory is unnecessary.

**Artifacts**: exception record, faulting stack, dump file, analysis summary.
**Success criteria**: the exception is identified with a faulting address and
stack; the dump reopens and `.ecxr` restores the context; attach/detach leaves
the target running.

### 8. Fix, rebuild, and regress

- Make the smallest change that explains the evidence.
- Rebuild incrementally with the same engine.
- Rerun the normal program and the exact same cdb script.
- Compare before/after output and debugger state.

**Artifacts**: diff, rebuilt exe/PDB, before/after outputs.
**Success criteria**: the original symptom is gone; the same script still hits
the expected breakpoint; no new warnings; related output is unchanged.

### 9. Hand off to Visual Studio (optional)

Open the generated `.sln`; confirm the startup project is the executable.
Use:

| Action | Shortcut |
|---|---|
| Toggle breakpoint | `F9` |
| Start/continue | `F5` |
| Step over | `F10` |
| Step into | `F11` |
| Step out | `Shift+F11` |
| Call Stack | `Ctrl+Alt+C` |
| Locals | `Ctrl+Alt+V, L` |
| Watch 1 | `Ctrl+Alt+W, 1` |
| Breakpoints | `Ctrl+Alt+B` |
| Exception Settings | `Ctrl+Alt+E` |
| Run to cursor | `Ctrl+F10` |
| Set next statement | `Ctrl+Shift+F10` |

Note: `Ctrl+Alt+L` is Solution Explorer, not Locals. Edit and Continue requires
`/ZI`; CMake's default `/Zi` does not enable it.

**Success criteria**: VS hits the breakpoint and the Call Stack/Locals windows
show the expected state, or the skill explicitly reports that cdb was used
instead to avoid disturbing an existing VS session.

## Edge Cases

- **UTF-8 / code page 936**: non-ASCII comments can swallow the next line.
  Add `/utf-8` or a BOM.
- **PDB mismatch**: `!lmi` shows GUID/Age; rebuild instead of debugging a stale
  binary.
- **Line drift**: verify `bl` and `ls`; do not trust copied line numbers.
- **IB slot busy**: `/LIST`; for large projects wait/report, for small ones
  fall back locally. Never stop someone else's build.
- **Optimized Release**: stepping may jump; prefer Debug/RelWithDebInfo.
- **Attach fails**: elevation/UIPI; run the debugger at the target's integrity
  level. Match x86/x64.
- **Dump size**: use `/m` unless full memory is needed.
- **cdb pitfalls**: `p` vs `??`; `dx` for STL; `j` polarity; `.echo` semicolons;
  `.printf` `@@c++`; `ba` post-access; `!lmi`; `/o`; script args.
- **VS**: startup project, Locals `Ctrl+Alt+V, L`, `/ZI` for EnC.

## References

- `references/windows-toolchain.md`: vswhere/VS/CMake/cdb/IB discovery, build
  flags, PDBs, IB decision table, troubleshooting.
- `references/cdb-cheatsheet.md`: complete cdb command table, exceptions,
  dumps, attach, source display, gotchas, VS shortcuts.
- `references/cdb-script-templates.md`: copy-ready cdb scripts for basic,
  conditional/hitcount/tracepoint, watchpoint, C++ exception, crash/dump,
  dump analysis, and attach.
