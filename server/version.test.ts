import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { VERSION } from './version.ts';

test('VERSION matches package.json so a built exe reports the right version', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
});
