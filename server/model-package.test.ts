import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parse as parseToml } from 'smol-toml';

import { createSettingsRegistry } from './settings.ts';
import { applyModelPackage, modelTargets } from './model-package.ts';
import { clearModelCache } from './models.ts';
import { getProviderModels, saveProvider } from './providers.ts';
import type { AgentSpec, ModelApplyResponse, SettingsFileDescriptor } from '../shared/types.ts';

let root: string;
let home: string;
let providerSource: string;
let piModelsPath: string;
let snapshotRoot: string;
let files: SettingsFileDescriptor[];
let agents: AgentSpec[];
let onlyProvider: string;

const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8'));

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'agent-manager-model-package-'));
  home = join(root, 'home');
  providerSource = join(home, '.agents', 'providers.json');
  piModelsPath = join(home, '.pi', 'agent', 'models.json');
  snapshotRoot = join(root, 'snapshots');
  files = createSettingsRegistry({ home });
  agents = [
    { key: 'claude', label: 'Claude Code', root: join(home, '.claude', 'skills') },
    { key: 'codex', label: 'Codex', root: join(home, '.codex', 'skills') },
    { key: 'pi', label: 'pi', root: join(home, '.pi', 'agent', 'skills') },
  ];

  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify(
      { permissions: { defaultMode: 'plan' }, env: { KEEP_ME: 'yes', ANTHROPIC_MODEL: 'old' } },
      null,
      2,
    ),
  );
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    [
      'model = "old-model"',
      'model_provider = "old"',
      'model_catalog_json = "C:\\\\cache\\\\old.json"',
      'model_reasoning_effort = "high"',
      '',
      '[model_providers.old]',
      'name = "Old"',
      'base_url = "https://old.example.com/v1"',
      'wire_api = "responses"',
      '',
    ].join('\n'),
  );
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(home, '.pi', 'agent', 'settings.json'),
    JSON.stringify({ shellPath: '/bin/bash', defaultProvider: 'old', defaultModel: 'old' }, null, 2),
  );
  writeFileSync(
    piModelsPath,
    JSON.stringify(
      {
        providers: {
          old: { name: 'Old', baseUrl: 'https://old.example.com/v1', api: 'openai-completions', models: [] },
        },
      },
      null,
      2,
    ),
  );

  const saved = saveProvider(providerSource, snapshotRoot, {
    baseUrl: 'https://models.example.com/v1',
    apiKey: 'sk-package',
  });
  onlyProvider = saved.report.providers[0]!.id;
  clearModelCache();
  // Prime the provider/model cache with a stubbed endpoint so apply does not need the network.
  await getProviderModels(providerSource, true, async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: 'alpha-large',
            display_name: 'Alpha Large',
            context_length: 400000,
            max_tokens: 128000,
            reasoning: { supportsReasoning: true },
            supported_efforts: ['low', 'medium', 'high'],
            supportsImages: true,
          },
          {
            id: 'plain-beta',
            context_length: 64000,
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
});

after(() => {
  clearModelCache();
  rmSync(root, { recursive: true, force: true });
});

test('modelTargets lists the files each agent package touches', () => {
  const report = modelTargets({ files, piModelsPath, agents });
  assert.deepEqual(report.agents.map((agent) => agent.key), ['claude', 'codex', 'pi']);
  assert.equal(report.agents[0]?.files[0]?.path, join(home, '.claude', 'settings.json'));
  assert.equal(report.agents[1]?.files[0]?.path, join(home, '.codex', 'config.toml'));
  assert.deepEqual(
    report.agents[2]?.files.map((file) => file.path),
    [piModelsPath, join(home, '.pi', 'agent', 'settings.json')],
  );
});

test('applyModelPackage writes the Claude env package without dropping existing settings', async () => {
  const result = await applyModelPackage({
    files,
    agents,
    providerSource,
    piModelsPath,
    snapshotRoot,
    request: { modelId: 'alpha-large', agents: ['claude'] },
  });
  assert.equal(result.agents.length, 1);
  const claude = readJson(join(home, '.claude', 'settings.json'));
  assert.equal(claude.model, 'alpha-large');
  assert.equal(claude.permissions.defaultMode, 'plan');
  assert.equal(claude.env.KEEP_ME, 'yes');
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://models.example.com');
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'sk-package');
  assert.equal(claude.env.ANTHROPIC_MODEL, 'alpha-large');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'alpha-large');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'alpha-large');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'alpha-large');
  assert.equal(claude.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'alpha-large');
  assert.equal(claude.env.CLAUDE_CODE_SUBAGENT_MODEL, 'alpha-large');
  assert.equal(claude.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  assert.equal(claude.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, '1');
  assert.equal(claude.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '400000');
  assert.ok(result.snapshotIds.length > 0);
  assert.equal(JSON.stringify(result).includes('sk-package'), false);
});

test('applyModelPackage writes Codex provider/model/context and keeps the catalog and other providers', async () => {
  const result = await applyModelPackage({
    files,
    agents,
    providerSource,
    piModelsPath,
    snapshotRoot,
    request: { modelId: 'alpha-large', agents: ['codex'] },
  });
  assert.equal(result.agents.length, 1);
  const config = parseToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>;
  assert.equal(config.model, 'alpha-large');
  assert.equal(config.model_provider, 'agentmanager');
  assert.equal(config.model_context_window, 400000);
  assert.equal(config.model_reasoning_effort, 'high');
  assert.equal(config.model_catalog_json, 'C:\\cache\\old.json');
  assert.ok(config.model_providers.old);
  assert.equal(config.model_providers.agentmanager.name, 'models.example.com');
  assert.equal(config.model_providers.agentmanager.base_url, 'https://models.example.com/v1');
  assert.equal(config.model_providers.agentmanager.wire_api, 'responses');
  assert.equal(config.model_providers.agentmanager.requires_openai_auth, true);
  assert.equal(config.model_providers.agentmanager.experimental_bearer_token, 'sk-package');
});

test('applyModelPackage writes pi models.json for the whole list and sets the defaults', async () => {
  const result = await applyModelPackage({
    files,
    agents,
    providerSource,
    piModelsPath,
    snapshotRoot,
    request: { modelId: 'alpha-large', agents: ['pi'] },
  });
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]?.snapshotIds.length, 2);

  const models = readJson(piModelsPath);
  assert.ok(models.providers.old);
  const provider = models.providers.agentmanager;
  assert.equal(provider.baseUrl, 'https://models.example.com/v1');
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.apiKey, 'sk-package');
  assert.equal(provider.authHeader, true);
  assert.equal(provider.models.length, 2);
  const alpha = provider.models.find((model: any) => model.id === 'alpha-large');
  assert.equal(alpha.contextWindow, 400000);
  assert.equal(alpha.maxTokens, 128000);
  assert.equal(alpha.reasoning, true);
  assert.deepEqual(alpha.input, ['text', 'image']);
  assert.deepEqual(alpha.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
  });

  const settings = readJson(join(home, '.pi', 'agent', 'settings.json'));
  assert.equal(settings.shellPath, '/bin/bash');
  assert.equal(settings.defaultProvider, 'agentmanager');
  assert.equal(settings.defaultModel, 'alpha-large');
});

test('applyModelPackage rejects unknown agents and models without writing', async () => {
  await assert.rejects(
    () =>
      applyModelPackage({
        files,
        agents,
        providerSource,
        piModelsPath,
        snapshotRoot,
        request: { modelId: 'alpha-large', agents: ['nope'] },
      }),
    /未知的 agent/,
  );
  await assert.rejects(
    () =>
      applyModelPackage({
        files,
        agents,
        providerSource,
        piModelsPath,
        snapshotRoot,
        request: { modelId: 'missing-model', agents: ['claude'] },
      }),
    /没有 missing-model/,
  );
  assert.ok(onlyProvider.length > 0);
});
