import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyClaudeEffort,
  CLAUDE_EFFORT_ENV_KEY,
  presentClaudeEffort,
} from './claude-effort.ts';

test('an env-var max is presented as the effortLevel the editor edits', () => {
  const root: Record<string, unknown> = { env: { [CLAUDE_EFFORT_ENV_KEY]: 'max', KEEP: '1' } };
  presentClaudeEffort(root);
  assert.deepEqual(root, { effortLevel: 'max', env: { KEEP: '1' } });

  // The env map disappears when the level was its only entry.
  const only: Record<string, unknown> = { env: { [CLAUDE_EFFORT_ENV_KEY]: 'max' } };
  presentClaudeEffort(only);
  assert.deepEqual(only, { effortLevel: 'max' });

  // Other levels and unknown values stay untouched: they still work as an env override.
  const other: Record<string, unknown> = { env: { [CLAUDE_EFFORT_ENV_KEY]: 'high' } };
  presentClaudeEffort(other);
  assert.deepEqual(other, { env: { [CLAUDE_EFFORT_ENV_KEY]: 'high' } });
});

test('a chosen max is stored as the env var and any other choice clears it', () => {
  const max: Record<string, unknown> = { effortLevel: 'max', env: { KEEP: '1' } };
  assert.equal(applyClaudeEffort(max), true);
  assert.deepEqual(max, { env: { KEEP: '1', [CLAUDE_EFFORT_ENV_KEY]: 'max' } });

  const other: Record<string, unknown> = { effortLevel: 'xhigh', env: { [CLAUDE_EFFORT_ENV_KEY]: 'max' } };
  assert.equal(applyClaudeEffort(other), true);
  assert.deepEqual(other, { effortLevel: 'xhigh' });

  const cleared: Record<string, unknown> = { env: { [CLAUDE_EFFORT_ENV_KEY]: 'max', KEEP: '1' } };
  assert.equal(applyClaudeEffort(cleared), true);
  assert.deepEqual(cleared, { env: { KEEP: '1' } });

  // Nothing to rewrite: a plain level, an empty draft or an unrelated env map.
  assert.equal(applyClaudeEffort({ effortLevel: 'low' }), false);
  assert.equal(applyClaudeEffort({}), false);
  assert.equal(applyClaudeEffort({ env: { KEEP: '1' } }), false);
});

test('the round trip is stable for every level', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const draft: Record<string, unknown> = { effortLevel: level };
    applyClaudeEffort(draft);
    presentClaudeEffort(draft);
    assert.deepEqual(draft, { effortLevel: level });
  }
});
