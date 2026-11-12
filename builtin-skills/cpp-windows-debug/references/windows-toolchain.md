# Windows C++ Toolchain Reference

## 1. Discovery

```powershell
# Visual Studio with the C++ workload
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
  -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath

# Core tools
cmake --version
(Get-Command cmake, ninja -ErrorAction SilentlyContinue).Source

# Debugger (x64 example)
& "C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe" -version

# Incredibuild
(Get-Command BuildConsole -ErrorAction SilentlyContinue).Source
BuildConsole /? | Select-Object -First 20
```

Typical layout:

- MSVC: `<VS>\VC\Tools\MSVC\<version>\bin\Hostx64\x64\cl.exe`
- MSBuild: `<VS>\MSBuild\Current\Bin\MSBuild.exe`
- cdb: `C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe`
- IB: `BuildConsole.exe` in the Incredibuild install directory

Rules:

- Match the debugger to the target: x64 target -> x64 cdb and x64 VS debugger.
- Prefer the CMake Visual Studio generator so CMake locates MSVC and the SDK
  without a separate `vcvars64.bat`.
- If using Ninja, open a Developer PowerShell or call `vcvars64.bat` first.

## 2. CMake Configuration

```powershell
cmake -S <project> -B <project>\build-vs -G "Visual Studio 17 2022" -A x64
```

Multi-config generators ignore `CMAKE_BUILD_TYPE`; choose a configuration at
build/run time: `Debug`, `Release`, `MinSizeRel`, `RelWithDebInfo`.

Startup project:

```cmake
set_property(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
             PROPERTY VS_STARTUP_PROJECT <target>)
```

Without this, Visual Studio may default to `ALL_BUILD`; pressing F5 then tries to
debug `ALL_BUILD`.

Recommended MSVC options:

```cmake
if(MSVC)
  target_compile_options(<target> PRIVATE /W4 /permissive- /utf-8)
  target_compile_options(<target> PRIVATE
    $<$<CONFIG:Debug>:/Od /Zi /RTC1>
    $<$<CONFIG:Release>:/O2 /Zi>
  )
  target_link_options(<target> PRIVATE
    $<$<CONFIG:Debug>:/DEBUG>
    $<$<CONFIG:Release>:/DEBUG>
  )
endif()
```

- `/utf-8` is required for non-ASCII source on a 936 code-page system.
- Keep PDBs in Release (`/Zi` + `/DEBUG`) so production crashes remain
  debuggable.
- Debug output usually lands in `<build>\Debug\<target>.exe` and `.pdb`.

## 3. Incredibuild

Basic solution build:

```powershell
BuildConsole <solution.sln> /build "<config>|x64" /nologo /log=<build.log>
```

Inspect and control:

```powershell
BuildConsole /LIST          # running builds and IDs
BuildConsole /QUERYLICENSE  # concurrency/features
BuildConsole /WAIT          # default: queue if another build is running
BuildConsole /NOWAIT        # fail fast instead of waiting
BuildConsole /STOP=<build-id>  # only stop your own build
```

Decision matrix:

| Project size | IB installed? | IB slot free? | Action |
|---|---|---|---|
| Large | yes | yes | BuildConsole |
| Large | yes | no | report and wait; do not silently use local |
| Large | no | - | local fallback (slower) |
| Small | yes | yes | BuildConsole |
| Small | yes | no | local fallback |
| Small | no | - | local |

Heuristic:

- Large: engine/game/UE-scale, thousands of translation units, or a build
  taking more than a few minutes.
- Small: a demo or library with tens of translation units; local MSBuild is
  usually faster than acquiring an IB slot.

Build-tool interception (optional; verify locally):

```powershell
BuildConsole /COMMAND="cmake --build <build-dir> --config <config>" /nologo
```

The supported form is solution/project based; the `/COMMAND` form depends on the
installed IB edition and build tool. Keep the solution-based command as the
default.

## 4. Local MSBuild Fallback

```powershell
cmake --build <build-dir> --config <config> -- /m
```

or directly:

```powershell
& "<VS>\MSBuild\Current\Bin\MSBuild.exe" `
  <solution.sln> /p:Configuration=<config> /p:Platform=x64 /m /v:minimal
```

Check the exit code and confirm the exe/PDB timestamps changed.

## 5. Symbols and PDBs

- Keep the PDB next to the exe or in the symbol path.
- Verify the loaded module:

```text
lm m <module>
!lmi <module>
```

`!lmi` shows the PDB path, GUID, and Age. A mismatch means the exe and PDB are
not from the same build; rebuild rather than debugging a stale binary.

- System DLL symbols: `.symfix; .reload` (contacts the Microsoft symbol server).
- Use `cdb -y <symbol-path>` or `_NT_SYMBOL_PATH` for private symbol servers.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| C4819; C2039/C1075 at random lines | UTF-8 source read as code page 936; a trailing byte forms a line-continuation backslash | Add `/utf-8` or save as UTF-8 with BOM |
| Breakpoint unbound / no source line | PDB missing, mismatched, or source path moved | Rebuild; check `lm`/`!lmi`; set `.srcpath` |
| `Maximum number of concurrent builds reached` | IB license slot busy | `/LIST`; large project wait, small project local fallback |
| F5 debugs `ALL_BUILD` | No startup project | Set `VS_STARTUP_PROJECT`; or set it in Solution Explorer |
| cdb cannot attach | Elevation/UIPI mismatch | Run cdb at the target's integrity level; match x86/x64 |
| Release stepping jumps | Optimization/inlining | Use Debug or RelWithDebInfo |
| Source not shown in cdb | Source file not loaded | `.srcpath`, `lsf <file>`, `l+s`, `l+t` |
| Dump write fails | Existing file | `.dump /ma /o <file>` |
| Crash/throw script does nothing | Target args not passed | `cdb ... <exe> --crash` / `--throw` |
