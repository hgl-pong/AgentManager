/**
 * Claude Code accepts only low/medium/high/xhigh in the persisted `effortLevel` key: its settings
 * schema drops anything else, so a hand-written `"effortLevel": "max"` is silently ignored and the
 * session falls back to the model default. `max` is honoured only through the CLI (`--effort max`,
 * `/effort max`) or the `CLAUDE_CODE_EFFORT_LEVEL` environment variable, and the `env` block of
 * settings.json is the one way to keep it across sessions.
 *
 * This module keeps the settings editor's effort control honest and single-sourced: a `max` env var
 * is presented as `effortLevel: "max"`, and a chosen `max` is written back as that env var. Every
 * other level stays a plain `effortLevel` value.
 */

export const CLAUDE_SETTINGS_FILE_ID = 'claude-settings';
/** Every level Claude Code understands at run time. */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** The subset the persisted `effortLevel` key accepts. */
export const CLAUDE_PERSISTED_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const CLAUDE_EFFORT_ENV_KEY = 'CLAUDE_CODE_EFFORT_LEVEL';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envObject(root: JsonObject): JsonObject | undefined {
  return isRecord(root.env) ? root.env : undefined;
}

function deleteEnvLevel(root: JsonObject): boolean {
  const env = envObject(root);
  if (!env || env[CLAUDE_EFFORT_ENV_KEY] !== 'max') return false;
  delete env[CLAUDE_EFFORT_ENV_KEY];
  if (Object.keys(env).length === 0) delete root.env;
  return true;
}

function setEnvLevel(root: JsonObject, level: string): void {
  const env = envObject(root);
  if (env) env[CLAUDE_EFFORT_ENV_KEY] = level;
  else root.env = { [CLAUDE_EFFORT_ENV_KEY]: level };
}

/**
 * Turns the stored shape into what the settings editor shows: an env-var `max` becomes
 * `effortLevel: "max"`, so the effort select has a single source of truth. Mutates `root`.
 */
export function presentClaudeEffort(root: JsonObject): void {
  if (envObject(root)?.[CLAUDE_EFFORT_ENV_KEY] !== 'max') return;
  root.effortLevel = 'max';
  deleteEnvLevel(root);
}

/**
 * Turns an edited draft back into the stored shape, where `max` lives in the env var. Returns
 * whether anything changed, so a raw-text save can keep the author's formatting when it is a no-op.
 */
export function applyClaudeEffort(root: JsonObject): boolean {
  const level = root.effortLevel;
  if (level === 'max') {
    delete root.effortLevel;
    setEnvLevel(root, 'max');
    return true;
  }
  // Any other selection (including "unset") means the env-var max no longer applies.
  return deleteEnvLevel(root);
}
