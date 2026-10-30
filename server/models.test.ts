import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearModelCache, getModelsReport, modelsUrl, normalizeModels } from './models.ts';

const originalUrl = process.env.AGENT_MANAGER_MODELS_URL;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.AGENT_MANAGER_MODELS_URL;
  else process.env.AGENT_MANAGER_MODELS_URL = originalUrl;
  clearModelCache();
});

test('modelsUrl appends /models to a base URL and accepts a full endpoint', () => {
  assert.equal(modelsUrl('http://127.0.0.1:15721/v1'), 'http://127.0.0.1:15721/v1/models');
  assert.equal(modelsUrl('http://127.0.0.1:15721/v1/'), 'http://127.0.0.1:15721/v1/models');
  assert.equal(modelsUrl('https://example.test/models'), 'https://example.test/models');
  assert.throws(() => modelsUrl('file:///c:/models.json'), /http/);
});

test('normalizeModels reads OpenAI and Codex payload shapes', () => {
  const openai = normalizeModels({
    data: [
      {
        id: 'claude-opus-5',
        display_name: 'Opus 5',
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: {
          thinking: { supported: true },
          effort: { supported: true },
          image_input: { supported: true },
        },
      },
      { id: 'plain', type: 'model' },
      { nope: true },
    ],
  });
  assert.deepEqual(
    openai.map((model) => model.id),
    ['claude-opus-5', 'plain'],
  );
  assert.equal(openai[0]?.name, 'Opus 5');
  assert.equal(openai[0]?.contextWindow, 1_000_000);
  assert.equal(openai[0]?.maxOutputTokens, 128_000);
  assert.equal(openai[0]?.thinking, true);
  assert.equal(openai[0]?.effort, true);
  assert.equal(openai[0]?.imageInput, true);
  assert.equal(openai[1]?.group, 'default');

  const codex = normalizeModels({
    models: [{ slug: 'anthropic/deepseek-flash', display_name: 'DeepSeek Flash', reasoning: true }],
  });
  assert.equal(codex[0]?.id, 'anthropic/deepseek-flash');
  assert.equal(codex[0]?.group, 'anthropic');
  assert.equal(codex[0]?.thinking, true);
});

test('normalizeModels reads the extended gateway shape (context_length, reasoning, supported_efforts)', () => {
  const models = normalizeModels({
    data: [
      {
        id: 'hy4-preview',
        name: 'Hy4 preview',
        context_length: 960_000,
        max_output_tokens: 64_000,
        reasoning: { supportsReasoning: true, supportedEfforts: ['high', 'low'] },
        supported_efforts: ['high', 'low', 'medium'],
        modality: 'text',
        supportsImages: false,
        input_modalities: ['text'],
      },
      {
        id: 'vision-model',
        name: 'Vision',
        modality: 'multimodal',
        vision: true,
        supportsImages: true,
        input_modalities: ['text', 'image'],
      },
    ],
  });

  assert.equal(models[0]?.name, 'Hy4 preview');
  assert.equal(models[0]?.contextWindow, 960_000);
  assert.equal(models[0]?.maxOutputTokens, 64_000);
  assert.equal(models[0]?.thinking, true);
  assert.equal(models[0]?.effort, true);
  assert.deepEqual(models[0]?.effortLevels, ['low', 'medium', 'high']);
  assert.equal(models[0]?.imageInput, false);

  assert.equal(models[1]?.imageInput, true);
  assert.equal(models[1]?.effort, false);
});

test('getModelsReport caches, refreshes and falls back to stale data', async () => {
  process.env.AGENT_MANAGER_MODELS_URL = 'http://models.test/v1';
  let calls = 0;
  let mode: 'ok' | 'fail' = 'ok';
  const fetchImpl = (async () => {
    calls += 1;
    if (mode === 'fail') return new Response('nope', { status: 503 });
    return new Response(JSON.stringify({ data: [{ id: 'm1', display_name: 'Model 1' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const first = await getModelsReport({ fetchImpl, now: () => 1_000 });
  assert.equal(first.cached, false);
  assert.equal(first.models[0]?.id, 'm1');
  assert.equal(calls, 1);

  const cached = await getModelsReport({ fetchImpl, now: () => 2_000 });
  assert.equal(cached.cached, true);
  assert.equal(calls, 1);

  const refreshed = await getModelsReport({ fetchImpl, now: () => 3_000, refresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(calls, 2);

  mode = 'fail';
  const stale = await getModelsReport({ fetchImpl, now: () => 4_000, refresh: true });
  assert.equal(stale.stale, true);
  assert.match(stale.error ?? '', /503/);
  assert.equal(stale.models[0]?.id, 'm1');
});

test('an invalid source URL is reported instead of thrown', async () => {
  process.env.AGENT_MANAGER_MODELS_URL = 'file:///tmp/models.json';
  const report = await getModelsReport({});
  assert.match(report.error ?? '', /http/);
  assert.deepEqual(report.models, []);
});
