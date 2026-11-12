import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  activateProvider,
  getProviderModels,
  listProviders,
  removeProvider,
  saveProvider,
} from './providers.ts';
import { clearModelCache } from './models.ts';
import { restoreSnapshot } from './snapshot.ts';
import { AppError } from '../shared/types.ts';

let root: string;
let providerPath: string;
let snapshotRoot: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-provider-'));
  providerPath = join(root, '.agents', 'providers.json');
  snapshotRoot = join(root, 'snapshots');
  clearModelCache();
});

after(() => {
  clearModelCache();
  rmSync(root, { recursive: true, force: true });
});

const rawStore = () => JSON.parse(readFileSync(providerPath, 'utf8')) as {
  activeId: string | null;
  providers: Array<{ id: string; baseUrl: string; apiKey: string }>;
};

test('saveProvider stores the base URL and key, masks the key and activates the new provider', () => {
  const result = saveProvider(providerPath, snapshotRoot, {
    baseUrl: 'https://api.example.com/v1/',
    apiKey: '  sk-test  ',
  });
  const provider = result.report.providers[0];

  assert.ok(provider);
  assert.equal(provider.baseUrl, 'https://api.example.com/v1');
  assert.equal(provider.host, 'api.example.com');
  assert.equal(provider.hasApiKey, true);
  assert.equal(provider.active, true);
  assert.equal('apiKey' in provider, false);
  assert.equal(result.report.activeId, provider.id);

  const stored = rawStore();
  assert.equal(stored.providers[0]?.apiKey, 'sk-test');
  assert.equal(stored.activeId, provider.id);
  assert.ok(result.snapshotId.length > 0);

  const listed = listProviders(providerPath);
  assert.equal(JSON.stringify(listed).includes('sk-test'), false);
});

test('updating a provider keeps the saved key when the new key is blank', () => {
  const id = listProviders(providerPath).providers[0]?.id;
  assert.ok(id);
  const result = saveProvider(providerPath, snapshotRoot, {
    id,
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: '',
  });

  assert.equal(result.report.providers[0]?.baseUrl, 'https://gateway.example.com/v1');
  assert.equal(rawStore().providers[0]?.apiKey, 'sk-test');
});

test('a second provider can be activated and removed', () => {
  const second = saveProvider(providerPath, snapshotRoot, {
    baseUrl: 'https://second.example.com/v1',
    apiKey: 'sk-second',
  });
  const secondId = second.report.providers.find((entry) => entry.host === 'second.example.com')?.id;
  assert.ok(secondId);
  assert.equal(second.report.activeId, secondId);

  const first = second.report.providers.find((entry) => entry.id !== secondId);
  assert.ok(first);
  const activated = activateProvider(providerPath, snapshotRoot, first.id);
  assert.equal(activated.report.activeId, first.id);
  assert.equal(activated.report.providers.find((entry) => entry.id === first.id)?.active, true);

  const removed = removeProvider(providerPath, snapshotRoot, first.id);
  assert.equal(removed.report.providers.some((entry) => entry.id === first.id), false);
  assert.equal(removed.report.activeId, secondId);

  const noActive = removeProvider(providerPath, snapshotRoot, secondId);
  assert.equal(noActive.report.activeId, null);
  assert.equal(noActive.report.providers.length, 0);
});

test('getProviderModels sends the saved key as a bearer token and never returns it', async () => {
  clearModelCache();
  saveProvider(providerPath, snapshotRoot, {
    baseUrl: 'https://models.example.com/v1',
    apiKey: 'sk-models',
  });

  let seenUrl = '';
  let seenAuth = '';
  const report = await getProviderModels(providerPath, true, async (input, init) => {
    seenUrl = String(input);
    seenAuth = new Headers(init?.headers).get('authorization') ?? '';
    return new Response(
      JSON.stringify({
        data: [
          { id: 'alpha-large', context_length: 400000, reasoning: { supportsReasoning: true } },
          { id: 'alpha-mini', context_length: 128000, vision: true },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  assert.equal(seenUrl, 'https://models.example.com/v1/models');
  assert.equal(seenAuth, 'Bearer sk-models');
  assert.equal(report.provider?.host, 'models.example.com');
  assert.deepEqual(report.models.map((model) => model.id), ['alpha-large', 'alpha-mini']);
  assert.equal(JSON.stringify(report).includes('sk-models'), false);
  assert.equal(report.error, undefined);
});

test('no configured provider returns an honest empty report', async () => {
  const emptyPath = join(root, 'empty', 'providers.json');
  const report = await getProviderModels(emptyPath, true);
  assert.equal(report.provider, null);
  assert.deepEqual(report.models, []);
  assert.match(report.error ?? '', /还没有配置 provider/);
});

test('a malformed provider file fails loudly instead of discarding providers', () => {
  const badPath = join(root, 'bad', 'providers.json');
  mkdirSync(join(root, 'bad'), { recursive: true });
  writeFileSync(badPath, '{ not json', 'utf8');
  assert.throws(() => listProviders(badPath), /无法解析/);
  assert.throws(
    () => saveProvider(badPath, snapshotRoot, { baseUrl: 'https://x.example.com/v1', apiKey: 'k' }),
    (error: unknown) => error instanceof AppError && error.status === 500,
  );
});

test('the first save can be restored away through its snapshot', () => {
  const isolated = join(root, 'restorable', 'providers.json');
  const before = existsSync(isolated);
  const result = saveProvider(isolated, snapshotRoot, {
    baseUrl: 'https://restore.example.com/v1',
    apiKey: 'sk-restore',
  });
  assert.equal(before, false);
  assert.equal(existsSync(isolated), true);
  restoreSnapshot(snapshotRoot, result.snapshotId, [root]);
  assert.equal(existsSync(isolated), false);
});
