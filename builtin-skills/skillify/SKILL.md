---
name: skillify
description: >
  Capture a session's repeatable process into a reusable SKILL.md file following the
  agentskills.io standard. Use when the user says "skillify this", "turn this into a skill",
  "capture this as a skill", "make this repeatable", "save this workflow", or
  "create a skill from this session". Works at end of any workflow worth repeating.
license: MIT
metadata:
  author: kk-r
  version: "1.0.0"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - Bash(mkdir:*)
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(ls:*)
  - Bash(cat:*)
---

# Skillify — Turn Any Session Into a Reusable Skill

You are capturing this session's repeatable process as a reusable SKILL.md file
that follows the [agentskills.io](https://agentskills.io) open standard — compatible
with Claude Code, Cursor, GitHub Copilot, Gemini CLI, VS Code, and 30+ other agent platforms.

## Phase 0: Gather Session Context

You don't have direct access to session memory, so reconstruct it now using
three complementary sources.

### Step A: Review Conversation History

Look back through the entire conversation. Extract:
- **Goal**: What did the user ask you to accomplish?
- **Steps taken**: Ordered list of actions (tools used, files touched, commands run)
- **Corrections**: Where did the user redirect your approach? These become Rules in the skill.
- **Tools & permissions**: Which tools were critical? Note permission patterns (e.g., `Bash(gh:*)` not just `Bash`)
- **Decision points**: Where did you or the user choose between alternatives?

### Step B: Check Git Artifacts

Gather recent changes to fill gaps in conversation context:

```
!git diff --stat 2>/dev/null | head -30
```

```
!git log --oneline -10 2>/dev/null
```

### Step C: Detect Project Context

Auto-detect the project's tooling so the generated skill uses the right commands:

```
!{ [ -f package.json ] && echo "NODE: $(cat package.json | grep -E '\"(name|test|build|lint)\"' | head -5)"; [ -f Makefile ] && echo "MAKE: $(head -20 Makefile | grep '^[a-z].*:')"; [ -f Cargo.toml ] && echo "RUST: $(head -5 Cargo.toml)"; [ -f go.mod ] && echo "GO: $(head -3 go.mod)"; [ -f Gemfile ] && echo "RUBY: $(head -5 Gemfile)"; [ -f pyproject.toml ] && echo "PYTHON: $(head -10 pyproject.toml)"; [ -f requirements.txt ] && echo "PYTHON: requirements.txt found"; } 2>/dev/null || echo "No standard project files detected"
```

## Phase 1: Interview the User

Use **AskUserQuestion** for ALL questions. Never ask questions via plain text.
Iterate each round until the user is satisfied.
The user always has a freeform "Other" option — do NOT add your own "Needs tweaking" option.

### Round 1: High-Level Confirmation

- Present your summary from Phase 0
- Suggest a **name** (lowercase, hyphens, max 64 chars per agentskills.io spec) and one-line **description**
- Suggest high-level goal(s) and success criteria
- Ask the user to confirm, rename, or adjust

### Round 2: Structure and Scope

- Present steps as a numbered list. Tell the user you'll dig into per-step detail next round.
- If the skill needs **arguments**, suggest them based on what you observed. Clarify what a future user would provide.
- Ask **execution context**:
  - `inline` (default) — runs in current conversation, user can steer mid-process
  - `fork` — runs as isolated sub-agent, better for self-contained tasks
- Ask **save location**:
  - **This repo** (`.claude/skills/<name>/SKILL.md`) — project-specific workflows
  - **Personal** (`~/.claude/skills/<name>/SKILL.md`) — follows user across all repos

### Round 3: Step-by-Step Detail

For each major step (skip if obvious), ask:
- What does this step **produce** that later steps need? (artifacts: PR URL, commit SHA, file path)
- What **proves** this step succeeded? (success criteria — required on every step)
- Should the user **confirm** before proceeding? (human checkpoint — for irreversible actions)
- Can any steps run in **parallel**? (concurrent steps use sub-numbers: 3a, 3b)
- What are **hard rules**? (constraints from user corrections, must/must-not)

Do multiple rounds if there are more than 3 steps or complex decision points.

### Round 4: Triggers and Edge Cases

- Confirm **when** this skill should be invoked — suggest trigger phrases
  - Example: "Use when the user says 'cherry-pick', 'hotfix', or 'CP this PR to release'"
- Ask about edge cases, gotchas, or failure modes to handle
- Ask if the skill should be **cross-platform** (if yes, note platform-specific commands)

Stop interviewing once you have enough. Don't over-ask for simple 2-3 step processes.

## Phase 2: Write the SKILL.md

Generate a SKILL.md following the **agentskills.io standard**.

### Frontmatter Template

```yaml
---
name: {{skill-name}}
description: >
  {{One-line description. Start with an action verb. Under 1024 chars.
  Include "Use when..." trigger context so agents know when to activate.}}
license: MIT
metadata:
  author: {{user or org name}}
  version: "1.0.0"
allowed-tools:
  {{Minimum permission patterns observed. Use Bash(gh:*) not Bash.}}
---
```

### Body Template

```markdown
# {{Skill Title}}

{{Brief description of what this skill does and its goal.}}

## Inputs

- `$arg_name`: Description of this input

## Goal

{{Clearly stated goal. Include concrete success artifacts
(e.g., "an open PR with CI passing" not just "code changes").}}

## Steps

### 1. {{Step Name}}

{{Specific, actionable instructions. Include commands where appropriate.}}

**Success criteria**: {{How to know this step is done.}}

### 2. {{Step Name}}

...
```

### Writing Rules

**Frontmatter:**
- `name`: lowercase, hyphens only, max 64 chars, must match directory name
- `description`: under 1024 chars, start with action verb, include "Use when..." triggers
- `allowed-tools`: minimum permissions needed — use patterns like `Bash(gh:*)` not `Bash`

**Body:**
- **Success criteria** on EVERY step — this is required, not optional
- Use per-step annotations where helpful:
  - **Execution**: `Direct` (default), `Task agent`, `Teammate` (parallel), `[human]`
  - **Artifacts**: Data this step produces for later steps
  - **Human checkpoint**: Pause for user confirmation (irreversible actions)
  - **Rules**: Hard constraints (especially from user corrections during original session)
- Concurrent steps use sub-numbers: 3a, 3b
- Steps requiring user action get `[human]` in the title
- Keep simple skills simple — a 2-step skill doesn't need every annotation
- Put large reference material in a `references/` subdirectory, not inline

**Cross-platform compatibility:**
- The agentskills.io standard works across 30+ tools
- Avoid Claude Code-specific frontmatter fields when possible
- Use standard fields: `name`, `description`, `license`, `metadata`, `allowed-tools`
- Tool-specific fields (like `when_to_use`, `context`, `arguments`) are fine — agents that don't understand them simply ignore them

## Phase 3: Review and Save

1. Output the complete SKILL.md as a **yaml code block** so the user can review with syntax highlighting
2. Ask for confirmation via AskUserQuestion: "Does this SKILL.md look good to save?"
3. On approval:
   - Create the skill directory
   - Write the SKILL.md file
   - If the skill has reference files, create a `references/` subdirectory
4. Confirm to the user:
   - Where the skill was saved
   - How to invoke: `/{{skill-name}} [arguments]`
   - That they can edit the SKILL.md directly to refine it
   - That the skill follows agentskills.io and works across compatible agent platforms
   - Remind them to restart Claude Code (skills are loaded at startup)
