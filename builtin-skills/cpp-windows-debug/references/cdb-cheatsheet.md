# cdb Cheat Sheet

## Invocation

```powershell
& "C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe" `
  -o -cf <script.cdb> <exe> [args]

cdb -p <pid>          # attach to a running process
cdb -z <dump.dmp>     # open a crash dump
```

Use `q` to terminate the target, `qd` to detach and leave it running.

## Script Preamble

```text
.lines
.settings set Sources.SkipCrtCode = true
.srcpath <source-dir>
lsf <source-dir>\<file>.cpp
l+s
l+t
```

`l+s` displays source at the prompt; `l+t` enables source-level stepping.
`lsf` loads a source file; `ls` then lists it.

## Breakpoints

| Purpose | Command |
|---|---|
| Source line | ``bp `file.cpp:37` `` |
| Function | `bp module!function` |
| List | `bl` |
| Clear all | `bc *` |
| Disable / enable | `bd <id>` / `be <id>` |
| Conditional (stop when i == 3) | ``bp `file.cpp:70` "j (@@c++(i) != 3) 'gc'"`` |
| Hit count (stop on 3rd hit) | `r $t0 = 0` + ``bp `file.cpp:73` "r $t0=@$t0+1; j (@$t0<3) 'gc'"`` |
| Tracepoint / logpoint | ``bp `file.cpp:73` ".printf \"i=%d\\n\", @@c++(i); gc"`` |
| Hardware write watchpoint | `ba w4 &variable` |
| Hardware read/write watchpoint | `ba r4 &variable` |
| Breakpoint command list | ``bp `file.cpp:73` "kb; gc"`` |

Rules:

- `j (expr) 'gc'` is a **continue** condition. To stop when a predicate is true,
  pass its negation to `j`.
- `.echo` text must not contain `;`.
- `.printf` arguments that are variables need `@@c++(var)`.
- `ba` supports at most 4 breakpoints, has no read-only mode, and fires after
  the access; inspect the value with `dv`/`??`.

## Execution

| Purpose | Command |
|---|---|
| Continue | `g` |
| Step over (source line with `l+t`) | `p` |
| Step into | `t` |
| Step out | `gu` |
| Step to next call / return / branch | `pc` / `pt` / `tb` |
| Continue with exception handled / not handled | `gh` / `gn` |
| Quit / detach | `q` / `qd` |

## Stack, Frames, Threads

| Purpose | Command |
|---|---|
| Stack with arguments and source lines | `kb` / `kp` |
| Frame numbers | `kn` |
| Switch frame | `.frame <n>` |
| Locals at current frame | `dv /t /v` |
| All thread stacks | `~*k` |
| Switch thread | `~<n>s` |
| Execute on all threads | `~*e <command>` |

## Values, Types, Memory

| Purpose | Command |
|---|---|
| C++ expression | `?? expression` |
| Locals with types | `dv /t /v` |
| NatVis / STL | `dx variable`, `dx vector[i]` |
| Type layout | `dt module!Type` |
| Registers | `r`, `r rip` |
| Disassembly | `u`, `uf module!function` |
| Bytes / words / dwords / qwords | `db` / `dw` / `dd` / `dq <addr>` |
| Module list / details | `lm`, `lm v m <name>`, `!lmi <name>` |
| Symbols / bulk breakpoints | `x module!pattern`, `bm module!pattern` |

Note: `??` does not call overloaded `operator[]`; on a reference parameter use
`dx vector[i]` or the raw `_Mypair._Myval2._Myfirst[i]` layout.

## Exceptions, Dumps, Attach

| Purpose | Command |
|---|---|
| Break on first-chance access violation | `sxe av` |
| Break on first-chance C++ exception | `sxe eh` |
| Ignore / disable an exception | `sxi av` / `sxd av` |
| Exception record (live) | `.exr -1` |
| Restore exception context (dump) | `.ecxr` |
| Write a full dump, overwrite | `.dump /ma /o <file>` |
| Write a minidump | `.dump /m /o <file>` |
| Automated crash analysis | `!analyze -v` |
| Attach | `cdb -p <pid>` |
| Detach | `qd` |
| Analyze dump | `cdb -z <dump>` |

For C++ exceptions, stop on `e06d7363`, inspect `kb`, then set a breakpoint on
the catch line and `g`. Avoid `gh` immediately followed by `q`; the process may
be killed before the catch prints.

## Source Display

| Purpose | Command |
|---|---|
| Enable line information | `.lines` |
| Set source search path | `.srcpath <dir>` |
| Load a source file | `lsf <file>` |
| List source | `ls` |
| Show source at prompt | `l+s` |
| Source-level stepping | `l+t` |

`lsp` is not a reliable substitute for `ls` when the source file has not been
loaded.

## Visual Studio Shortcuts

| Action | Shortcut |
|---|---|
| Toggle breakpoint | `F9` |
| Start / continue | `F5` |
| Step over / into / out | `F10` / `F11` / `Shift+F11` |
| Call Stack | `Ctrl+Alt+C` |
| Locals | `Ctrl+Alt+V, L` |
| Watch 1 | `Ctrl+Alt+W, 1` |
| Autos | `Ctrl+Alt+V, A` |
| Breakpoints | `Ctrl+Alt+B` |
| Exception Settings | `Ctrl+Alt+E` |
| Attach to Process | `Ctrl+Alt+P` |
| Immediate Window | `Ctrl+Alt+I` |
| Run to cursor | `Ctrl+F10` |
| Set next statement | `Ctrl+Shift+F10` |

`Ctrl+Alt+L` is Solution Explorer, not Locals. Edit and Continue requires `/ZI`;
CMake's default `/Zi` does not enable it.

## Gotchas

- `p` is step, not print; use `??`.
- `data[3]` on a reference parameter is pointer arithmetic; use `dx data[3]`.
- Line numbers drift; verify with `bl` and `ls`.
- `!lmi <module>`; `lmi` alone is not a valid command.
- `.dump` needs `/o` to overwrite an existing file.
- `cdb -cf` cannot set target arguments; pass `--crash` / `--throw` on the
  command line.
- Breakpoint commands in `.cdb` files are embedded in double quotes; escape
  inner quotes with `\"`.
- A hardware watchpoint stops at the instruction after the access; the source
  line may be a closing brace.
