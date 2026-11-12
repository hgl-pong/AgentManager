# cdb Script Templates

These templates are intentionally generic. Replace `<PLACEHOLDERS>` and verify
line numbers with `bl`/`ls` before relying on them. A `-cf` script cannot change
the target's command line; pass target arguments on the cdb command line.

## 1. Basic Breakpoint, Stack, Locals

```text
$$ Basic: breakpoint, source, locals, stack, expression, STL, step.
.lines
.settings set Sources.SkipCrtCode = true
.srcpath <SRC_DIR>
lsf <SRC_DIR>\<FILE>.cpp
l+s
l+t
.echo ===== set breakpoint =====
bp `<FILE>:<LINE>`
bl
.echo ===== run =====
g
.echo ===== locals =====
dv /t /v
.echo ===== stack =====
kb
.echo ===== expressions =====
?? <EXPR>
dx <VARIABLE>
.echo ===== step one source line =====
p
q
```

Usage:

```powershell
cdb -o -cf basic.cdb <EXE> [args]
```

## 2. Conditional, Hit Count, Tracepoint

Conditional: stop only when `i == 3` (skip earlier hits):

```text
.lines
.settings set Sources.SkipCrtCode = true
.srcpath <SRC_DIR>
lsf <SRC_DIR>\<FILE>.cpp
l+s
l+t
bp `<FILE>:<LOOP_LINE>` "j (@@c++(i) != 3) 'gc'"
bl
g
.echo --- stopped at i == 3 ---
?? i
?? <EXPR>
q
```

Hit count: stop on the 3rd hit. `j` is the continue condition.

```text
r $t0 = 0
bp `<FILE>:<LOOP_LINE>` "r $t0 = @$t0 + 1; j (@$t0 < 3) 'gc'; .echo third hit"
g
?? i
?? <EXPR>
q
```

Tracepoint: print and continue automatically. The line should be after the
state update you want to observe.

```text
bp `<FILE>:<AFTER_UPDATE_LINE>` ".printf \"i=%d v=%d best=%d\\n\", @@c++(i), @@c++(<VALUE_EXPR>), @@c++(<BEST_VAR>); gc"
bl
g
q
```

## 3. Hardware Watchpoint

```text
.lines
.settings set Sources.SkipCrtCode = true
.srcpath <SRC_DIR>
lsf <SRC_DIR>\<FILE>.cpp
l+s
l+t
.echo ===== stop before the loop =====
bp `<FILE>:<LOOP_LINE>`
g
dv /t
.echo ===== watch writes to <VAR> =====
ba w4 &<VAR>
bl
.echo ===== continue; stops after the next write =====
g
dv /t
kb
.echo ===== caller frame =====
kn
.frame 1
dv /t
dx <STRUCT>
dt <MODULE>!<TYPE>
.frame 0
bc *
q
```

If `&<VAR>` cannot be resolved, use `ba w4 @@c++(&<VAR>)`. A hardware watchpoint
fires at the instruction after the write; the source line may be a closing brace.

## 4. C++ Exception

```text
.lines
.settings set Sources.SkipCrtCode = true
.srcpath <SRC_DIR>
lsf <SRC_DIR>\<FILE>.cpp
l+s
l+t
.echo ===== first-chance C++ exception =====
sxe eh
g
.exr -1
kb
kn
.echo ===== throw site (frame number varies; inspect kn) =====
.frame <THROW_FRAME>
dv /t
.frame <CALLER_FRAME>
dv /t
.frame 0
.echo ===== break at the catch line and continue =====
bp `<FILE>:<CATCH_LINE>`
g
dv /t
.echo ===== continue to program exit =====
g
q
```

Usage:

```powershell
cdb -o -cf throw.cdb <EXE> --throw
```

Do not use `gh` and immediately `q`; the process may be terminated before the
catch block prints.

## 5. Crash and Full Dump

```text
.echo ===== first-chance access violation =====
sxe av
g
.exr -1
kb
~*k
.echo ===== write/overwrite a full dump =====
.dump /ma /o <DUMP_PATH>
q
```

Usage:

```powershell
cdb -o -cf crash.cdb <EXE> --crash
```

For a smaller dump, use `.dump /m /o <DUMP_PATH>` if full memory is not needed.

## 6. Dump Analysis

```text
.echo ===== restore the stored exception context =====
.ecxr
.echo ===== faulting stack =====
kb
.echo ===== module / PDB =====
lm m <MODULE>
!lmi <MODULE>
.echo ===== automated analysis =====
!analyze -v
q
```

Usage:

```powershell
cdb -z <DUMP_PATH> -cf dump.cdb
```

## 7. Attach to a Running Process

Start the target with a long wait or a deliberate pause, then:

```powershell
cdb -p <PID> -cf attach.cdb
```

```text
.echo ===== all threads =====
~*k
.echo ===== switch to thread 1 =====
~1s
k
~0s
.echo ===== module / PDB =====
lm m <MODULE>
!lmi <MODULE>
.echo ===== detach; target keeps running =====
qd
```

## Customization Notes

- Replace `<SRC_DIR>`, `<FILE>`, `<LINE>`, `<EXE>`, `<ARGS>`, `<MODULE>`,
  `<PID>`, `<DUMP_PATH>`, `<VAR>`, `<TYPE>`, and `<EXPR>`.
- Use `pwsh`/PowerShell quoting for paths containing spaces.
- Verify breakpoint lines with `bl`; a line breakpoint may resolve to the next
  executable line.
- Use `@@c++(...)` for expressions in `.printf`, `j`, `ba`, `db`, and `dd`.
- Avoid `;` inside `.echo` text.
- Keep scripts in the project so a fix can be re-verified with the same session.
