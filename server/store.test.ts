import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  clearStoreCache,
  extractZipEntries,
  getMcpStoreReport,
  getStoreReport,
  getStoreSkillDetail,
  installStoreMcp,
  installStoreSkill,
  listInstalledSkills,
  mcpStoreBaseUrl,
  normalizeMcpServers,
  normalizeStoreSkills,
  rankStoreSkills,
  readManifest,
  storeBaseUrl,
  stripCommonDirectory,
} from './store.ts';
import { createAppConfig } from './app.ts';
import { listMcpSourceNames } from './mcp.ts';
import { restoreSnapshot } from './snapshot.ts';
import { unzip } from './zip.ts';
import { AppError } from '../shared/types.ts';

// ---- fixtures ----

/** Writes a ZIP in memory: `store` unless `deflate` is set, UTF-8 names, no data descriptors. */
function buildZip(files: { name: string; data: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const content = Buffer.from(file.data, 'utf8');
    const stored = file.deflate ? deflateRawSync(content) : content;
    const method = file.deflate ? 8 : 0;
    const name = Buffer.from(file.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const SKILL_ZIP = buildZip([
  { name: 'pdf-tools/SKILL.md', data: '# PDF Tools\n\nUse this to fill forms.\n', deflate: true },
  { name: 'pdf-tools/scripts/fill.py', data: 'print("fill")\n' },
]);
const SKILL_SHA256 = createHash('sha256').update(SKILL_ZIP).digest('hex');

const CATALOG = {
  data: [
    {
      slug: 'acme-pdf-tools',
      displayName: 'pdf-tools',
      description: 'Fill in PDF forms.',
      category: 'office',
      riskLevel: 'safe',
      license: 'MIT',
      repo: 'https://github.com/acme/pdf-tools',
      author: 'acme',
      githubUsername: 'acme',
      qualityScore: 79,
      hasScripts: true,
      needsNetwork: false,
      authorVersion: '1.2.0',
      updatedAt: '2026-10-25T11:56:50.970449+00:00',
      stats: { viewCount: 20, downloadCount: 1234, favoriteCount: 12, popularityScore: 3 },
    },
    { slug: 'no-name' },
    null,
  ],
  total: 42,
  pagination: { page: 1, limit: 12, total: 42, totalPages: 4 },
};

/** The shape `/api/skills/<slug>` adds on top of a catalog row. */
const SKILL_DETAIL = {
  slug: 'acme-pdf-tools',
  name: 'pdf-tools',
  description: 'Read and edit PDFs.',
  summary: 'Turns PDFs into text and back.',
  category: 'office',
  riskLevel: 'medium',
  riskFactors: ['external_commands'],
  license: 'MIT',
  repo: 'https://github.com/acme/pdf-tools',
  author: 'acme',
  authorVersion: '2.0.0',
  updatedAt: '2026-10-25T11:56:50.970449+00:00',
  aiContent: {
    user_title: 'Read and edit PDFs',
    value_statement: 'A careful workflow for PDFs.',
    actual_capabilities: ['Extract text', 'Fill forms'],
    limitations: ['No OCR'],
    use_cases: [{ title: 'Fill a form', description: 'Fill and save a form.' }],
  },
  fileStructure: [
    { path: 'SKILL.md', type: 'file', lines: 42 },
    { path: 'scripts/', type: 'directory' },
  ],
  securityAudit: { summary: 'No shell execution found.' },
  stats: { viewCount: 7, downloadCount: 1234, favoriteCount: 12 },
};

interface RegistryBehaviour {
  catalog?: unknown;
  catalogStatus?: number;
  detail?: unknown;
  detailStatus?: number;
  mcpCatalog?: unknown;
  mcpStatus?: number;
  manifestStatus?: number;
  downloadStatus?: number[];
  manifestBody?: unknown;
  downloadBody?: Buffer;
}

let behaviour: RegistryBehaviour = {};
let server: ReturnType<typeof createServer>;
let baseUrl = '';
let requests: string[] = [];

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);

    if (url.pathname.endsWith('/manifest')) {
      const status = behaviour.manifestStatus ?? 200;
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Server Error' }));
        return;
      }
      const payload =
        behaviour.manifestBody ??
        {
          kind: 'skill',
          skill: { slug: 'acme-pdf-tools', name: 'pdf-tools' },
          artifact: {
            type: 'skill-zip',
            sha256: SKILL_SHA256,
            url: `${baseUrl}/api/skills/acme-pdf-tools/download?ref=abc`,
          },
        };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
      return;
    }

    if (url.pathname.endsWith('/download')) {
      const queue = behaviour.downloadStatus ?? [200];
      const status = queue.length > 1 ? (queue.shift() as number) : (queue[0] ?? 200);
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Server Error' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/zip' });
      response.end(behaviour.downloadBody ?? SKILL_ZIP);
      return;
    }

    if (url.pathname === '/api/skills/acme-pdf-tools') {
      response.writeHead(behaviour.detailStatus ?? 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(behaviour.detail ?? SKILL_DETAIL));
      return;
    }

    if (url.pathname === '/v0/servers') {
      response.writeHead(behaviour.mcpStatus ?? 200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(behaviour.mcpCatalog ?? { servers: [], metadata: {} }),
      );
      return;
    }

    response.writeHead(behaviour.catalogStatus ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(behaviour.catalog ?? CATALOG));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  behaviour = {};
  requests = [];
  clearStoreCache();
});

// ---- catalog mapping ----

test('normalizeStoreSkills maps the catalog row and drops rows without a slug', () => {
  const items = normalizeStoreSkills(CATALOG);
  assert.equal(items.length, 2);
  const [skill, bare] = items;
  assert.equal(skill?.id, 'acme-pdf-tools');
  assert.equal(skill?.slug, 'acme-pdf-tools');
  assert.equal(skill?.name, 'pdf-tools');
  assert.equal(skill?.owner, 'acme');
  assert.equal(skill?.summary, 'Fill in PDF forms.');
  assert.equal(skill?.category, 'office');
  assert.equal(skill?.risk, 'safe');
  assert.equal(skill?.license, 'MIT');
  assert.equal(skill?.repository, 'https://github.com/acme/pdf-tools');
  assert.equal(skill?.quality, 79);
  assert.equal(skill?.hasScripts, true);
  assert.equal(skill?.needsNetwork, false);
  assert.equal(skill?.downloads, 1234);
  assert.equal(skill?.favorites, 12);
  assert.equal(skill?.version, '1.2.0');
  assert.equal(skill?.updatedAt, '2026-10-25T11:56:50.970Z');
  assert.equal(skill?.inSource, false);
  // A row with only a slug still renders: the slug doubles as the name and publisher.
  assert.equal(bare?.name, 'no-name');
  assert.equal(bare?.owner, 'unknown');
});

test('rankStoreSkills puts rows whose name matches the query first', () => {
  const items = normalizeStoreSkills({
    data: [
      { slug: 'a', displayName: 'unrelated', description: 'react helper' },
      { slug: 'b', displayName: 'how-to-use-react' },
      { slug: 'c', displayName: 'react' },
    ],
    total: 3,
  });
  assert.deepEqual(
    rankStoreSkills(items, 'react').map((skill) => skill.name),
    ['react', 'how-to-use-react', 'unrelated'],
  );
  assert.deepEqual(
    rankStoreSkills(items, '').map((skill) => skill.name),
    ['unrelated', 'how-to-use-react', 'react'],
  );
});

test('storeBaseUrl accepts http(s) only and trims trailing slashes', () => {
  assert.equal(storeBaseUrl('https://mirror.test/'), 'https://mirror.test');
  assert.throws(() => storeBaseUrl('ftp://mirror.test'), /http/);
});

test('readManifest keeps the skill name, the artifact url and its checksum', () => {
  const artifact = readManifest(
    { skill: { name: 'pdf-tools' }, artifact: { url: 'https://cdn.test/pack.zip', sha256: 'AB' } },
    'https://registry.test',
    'acme-pdf-tools',
  );
  assert.deepEqual(artifact, { name: 'pdf-tools', url: 'https://cdn.test/pack.zip', sha256: 'ab' });

  const fallback = readManifest({}, 'https://registry.test', 'acme-pdf-tools');
  assert.equal(fallback.name, 'acme-pdf-tools');
  assert.equal(fallback.url, 'https://registry.test/api/skills/acme-pdf-tools/download');
  assert.equal(fallback.sha256, undefined);

  assert.throws(() => readManifest({ artifact: { url: 'file:///tmp/x.zip' } }, 'https://registry.test', 'x'), /下载地址/);
});

test('getStoreReport lists the catalog when the query is empty and searches otherwise', async () => {
  const featured = await getStoreReport({ baseUrl, sourcePath: '/skills', sourceSkills: [] });
  assert.equal(featured.provider, 'skillstore.io');
  assert.equal(featured.listing, 'featured');
  assert.equal(featured.total, 42);
  assert.equal(featured.items.length, 2);
  assert.equal(featured.page, 1);
  assert.equal(featured.limit, 12);
  assert.equal(featured.totalPages, 4, 'the registry pagination is passed through');
  assert.match(requests[0] ?? '', /^\/api\/skills\?limit=12&page=1$/);

  const search = await getStoreReport({ baseUrl, query: 'pdf', sourcePath: '/skills', sourceSkills: ['pdf-tools'] });
  assert.equal(search.listing, 'search');
  assert.equal(search.query, 'pdf');
  assert.equal(search.items[0]?.inSource, true, 'marked by the directory name the install would use');
  assert.match(requests[1] ?? '', /^\/api\/skills\?limit=12&page=1&q=pdf$/);

  const bySlug = await getStoreReport({ baseUrl, query: 'pdf', sourceSkills: ['acme-pdf-tools'] });
  assert.equal(bySlug.items[0]?.inSource, true, 'a slug match also counts');

  const second = await getStoreReport({ baseUrl, page: 3, limit: 24, sourceSkills: [] });
  assert.equal(second.page, 3);
  assert.equal(second.limit, 24);
  assert.match(requests.at(-1) ?? '', /^\/api\/skills\?limit=24&page=3$/);
});

test('getStoreSkillDetail maps the full skill record for the preview', async () => {
  behaviour = { detail: SKILL_DETAIL };
  const detail = await getStoreSkillDetail({
    slug: 'acme-pdf-tools',
    baseUrl,
    sourceSkills: ['pdf-tools'],
  });

  assert.equal(detail.name, 'pdf-tools', 'the record name beats the slug');
  assert.equal(detail.aiTitle, 'Read and edit PDFs');
  assert.equal(detail.aiSummary, 'Turns PDFs into text and back.');
  assert.equal(detail.valueStatement, 'A careful workflow for PDFs.');
  assert.deepEqual(detail.capabilities, ['Extract text', 'Fill forms']);
  assert.deepEqual(detail.limitations, ['No OCR']);
  assert.deepEqual(detail.useCases, [{ title: 'Fill a form', description: 'Fill and save a form.' }]);
  assert.deepEqual(detail.files, [
    { path: 'SKILL.md', type: 'file', lines: 42 },
    { path: 'scripts/', type: 'directory' },
  ]);
  assert.equal(detail.securitySummary, 'No shell execution found.');
  assert.deepEqual(detail.riskFactors, ['external_commands']);
  assert.equal(detail.viewCount, 7);
  assert.equal(detail.inSource, true);
  assert.ok(requests.includes('/api/skills/acme-pdf-tools'));

  await assert.rejects(
    () => getStoreSkillDetail({ slug: '../escape', baseUrl }),
    /slug/,
  );
  behaviour = {};
});

test('getStoreReport marks cache hits and falls back to the last answer when the registry fails', async () => {
  const first = await getStoreReport({ baseUrl, query: 'pdf' });
  assert.equal(first.cached, false);

  const second = await getStoreReport({ baseUrl, query: 'pdf' });
  assert.equal(second.cached, true);
  assert.equal(requests.length, 1, 'a fresh cache entry skips the network');

  // Same query, forced refresh, registry down: the cached answer comes back marked stale.
  behaviour = { catalogStatus: 500 };
  const stale = await getStoreReport({ baseUrl, query: 'pdf', refresh: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.items.length, 2);
  assert.match(stale.error ?? '', /HTTP 500/);

  // A query with nothing cached reports the failure and no rows.
  const empty = await getStoreReport({ baseUrl, query: 'unheard-of', refresh: true });
  assert.equal(empty.items.length, 0);
  assert.match(empty.error ?? '', /HTTP 500/);
});

// ---- zip ----

test('unzip reads stored and deflated entries through the central directory', () => {
  const entries = unzip(SKILL_ZIP);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['pdf-tools/SKILL.md', 'pdf-tools/scripts/fill.py'],
  );
  assert.match(entries[0]?.data.toString('utf8') ?? '', /PDF Tools/);
  assert.equal(entries[1]?.data.toString('utf8'), 'print("fill")\n');
});

test('unzip rejects payloads that are not zip and entries over the size limit', () => {
  assert.throws(() => unzip(Buffer.from('<html>nope</html>')), AppError);
  assert.throws(() => unzip(SKILL_ZIP, { maxTotalBytes: 10 }), /大小上限/);
});

test('stripCommonDirectory keeps a root layout and unwraps a wrapped one', () => {
  assert.deepEqual(stripCommonDirectory(['SKILL.md', 'scripts/run.py']), ['SKILL.md', 'scripts/run.py']);
  assert.deepEqual(stripCommonDirectory(['pdf/SKILL.md', 'pdf/scripts/run.py']), ['SKILL.md', 'scripts/run.py']);
});

test('extractZipEntries refuses absolute and parent-traversal names', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-zip-'));
  try {
    assert.throws(() => extractZipEntries([{ name: '/etc/passwd', data: Buffer.from('x') }], root), /绝对路径/);
    assert.throws(
      () => extractZipEntries([{ name: 'skill/../../escape.txt', data: Buffer.from('x') }], root),
      /越界路径/,
    );
    assert.equal(existsSync(join(root, 'escape.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- install ----

interface InstallFixture {
  root: string;
  source: string;
  snapshotRoot: string;
  tempRoot: string;
  agents: { key: string; label: string; root: string }[];
}

function makeFixture(): InstallFixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-store-'));
  return {
    root,
    source: join(root, 'source'),
    snapshotRoot: join(root, 'snapshots'),
    tempRoot: join(root, 'tmp'),
    agents: [
      { key: 'claude', label: 'Claude Code', root: join(root, 'agents', 'claude') },
      { key: 'codex', label: 'Codex', root: join(root, 'agents', 'codex') },
    ],
  };
}

test('installStoreSkill uses the manifest name, writes the source and links every agent', async () => {
  const fixture = makeFixture();
  try {
    const result = await installStoreSkill({
      source: fixture.source,
      snapshotRoot: fixture.snapshotRoot,
      tempRoot: fixture.tempRoot,
      agents: fixture.agents,
      baseUrl,
      request: { owner: 'acme', slug: 'acme-pdf-tools', agents: ['claude', 'codex'] },
    });

    const destination = join(fixture.source, 'pdf-tools');
    assert.equal(result.name, 'pdf-tools', 'the manifest name wins over the slug');
    assert.equal(result.path, destination);
    assert.equal(result.files, 2);
    assert.deepEqual(
      result.links.map((link) => link.state),
      ['linked', 'linked'],
    );
    assert.match(result.message, /已安装 pdf-tools/);
    assert.match(requests[0] ?? '', /^\/api\/skills\/acme-pdf-tools\/manifest$/);
    assert.match(requests[1] ?? '', /^\/api\/skills\/acme-pdf-tools\/download\?ref=abc$/);

    assert.equal(readFileSync(join(destination, 'scripts', 'fill.py'), 'utf8'), 'print("fill")\n');
    for (const agent of fixture.agents) {
      const link = join(agent.root, 'pdf-tools');
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(realpathSync(link), realpathSync(destination));
      assert.equal(statSync(join(link, 'SKILL.md')).isFile(), true);
    }
    assert.deepEqual(listInstalledSkills(fixture.source), ['pdf-tools']);
    assert.equal(readdirLength(fixture.tempRoot), 0, 'staging is cleaned up');

    // The snapshot restores the state before the install: no folder, no links.
    const restored = restoreSnapshot(fixture.snapshotRoot, result.snapshotId, [
      fixture.source,
      ...fixture.agents.map((agent) => agent.root),
    ]);
    assert.equal(existsSync(destination), false);
    assert.equal(existsSync(join(fixture.agents[0]!.root, 'pdf-tools')), false);
    assert.deepEqual(
      restored.removed.sort(),
      [destination, join(fixture.agents[0]!.root, 'pdf-tools'), join(fixture.agents[1]!.root, 'pdf-tools')].sort(),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installStoreSkill refuses a name the source already has, without downloading', async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.source, 'pdf-tools'), { recursive: true });
    writeFileSync(join(fixture.source, 'pdf-tools', 'SKILL.md'), 'local');

    await assert.rejects(
      installStoreSkill({
        source: fixture.source,
        snapshotRoot: fixture.snapshotRoot,
        tempRoot: fixture.tempRoot,
        agents: fixture.agents,
        baseUrl,
        request: { owner: 'acme', slug: 'acme-pdf-tools' },
      }),
      (error: unknown) => error instanceof AppError && error.status === 409,
    );
    assert.equal(requests.filter((url) => url.endsWith('/download')).length, 0);
    assert.equal(readFileSync(join(fixture.source, 'pdf-tools', 'SKILL.md'), 'utf8'), 'local');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installStoreSkill rejects an archive without SKILL.md and leaves no trace', async () => {
  const fixture = makeFixture();
  behaviour = {
    downloadBody: buildZip([{ name: 'readme.md', data: 'no skill here' }]),
    // No checksum, so the failure under test is the missing SKILL.md rather than the digest.
    manifestBody: {
      skill: { name: 'pdf-tools' },
      artifact: { url: `${baseUrl}/api/skills/acme-pdf-tools/download` },
    },
  };
  try {
    await assert.rejects(
      installStoreSkill({
        source: fixture.source,
        snapshotRoot: fixture.snapshotRoot,
        tempRoot: fixture.tempRoot,
        agents: fixture.agents,
        baseUrl,
        request: { owner: 'acme', slug: 'acme-pdf-tools', agents: ['claude'] },
      }),
      /SKILL\.md/,
    );
    assert.equal(existsSync(join(fixture.source, 'pdf-tools')), false);
    assert.equal(existsSync(join(fixture.agents[0]!.root, 'pdf-tools')), false);
    assert.equal(readdirLength(fixture.tempRoot), 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installStoreSkill refuses an archive whose checksum does not match the manifest', async () => {
  const fixture = makeFixture();
  behaviour = { downloadBody: buildZip([{ name: 'pdf-tools/SKILL.md', data: '# tampered\n' }]) };
  try {
    await assert.rejects(
      installStoreSkill({
        source: fixture.source,
        snapshotRoot: fixture.snapshotRoot,
        tempRoot: fixture.tempRoot,
        agents: fixture.agents,
        baseUrl,
        request: { owner: 'acme', slug: 'acme-pdf-tools' },
      }),
      /校验值不一致/,
    );
    assert.equal(existsSync(join(fixture.source, 'pdf-tools')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installStoreSkill retries a flaky registry and keeps the skill when the manifest is gone', async () => {
  const fixture = makeFixture();
  behaviour = { downloadStatus: [500, 502, 200] };
  try {
    const result = await installStoreSkill({
      source: fixture.source,
      snapshotRoot: fixture.snapshotRoot,
      tempRoot: fixture.tempRoot,
      agents: fixture.agents,
      baseUrl,
      request: { owner: 'acme', slug: 'acme-pdf-tools', agents: ['claude'] },
    });
    assert.equal(result.links[0]?.state, 'linked');
    assert.equal(existsSync(join(fixture.source, 'pdf-tools', 'SKILL.md')), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  const missing = makeFixture();
  behaviour = { manifestStatus: 404 };
  try {
    await assert.rejects(
      installStoreSkill({
        source: missing.source,
        snapshotRoot: missing.snapshotRoot,
        tempRoot: missing.tempRoot,
        agents: missing.agents,
        baseUrl,
        request: { owner: 'acme', slug: 'acme-pdf-tools' },
      }),
      /manifest/,
    );
    assert.equal(existsSync(join(missing.source, 'pdf-tools')), false);
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }
});

test('installStoreSkill skips an agent that already has an entry with the same name', async () => {
  const fixture = makeFixture();
  try {
    mkdirSync(join(fixture.agents[0]!.root, 'pdf-tools'), { recursive: true });
    writeFileSync(join(fixture.agents[0]!.root, 'pdf-tools', 'SKILL.md'), 'agent copy');

    const result = await installStoreSkill({
      source: fixture.source,
      snapshotRoot: fixture.snapshotRoot,
      tempRoot: fixture.tempRoot,
      agents: fixture.agents,
      baseUrl,
      request: { owner: 'acme', slug: 'acme-pdf-tools', agents: ['claude'] },
    });
    assert.equal(result.links[0]?.state, 'skipped');
    assert.equal(readFileSync(join(fixture.agents[0]!.root, 'pdf-tools', 'SKILL.md'), 'utf8'), 'agent copy');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installStoreSkill rolls the whole install back when a link cannot be created', async () => {
  const fixture = makeFixture();
  // The second agent's root is a regular file, so creating the link under it fails on every platform.
  mkdirSync(join(fixture.root, 'agents'), { recursive: true });
  writeFileSync(fixture.agents[1]!.root, 'not a directory');
  try {
    await assert.rejects(
      installStoreSkill({
        source: fixture.source,
        snapshotRoot: fixture.snapshotRoot,
        tempRoot: fixture.tempRoot,
        agents: fixture.agents,
        baseUrl,
        request: { owner: 'acme', slug: 'acme-pdf-tools', agents: ['claude', 'codex'] },
      }),
      (error: unknown) => error instanceof AppError && error.status === 500 && /已撤销本次安装/.test(error.message),
    );
    assert.deepEqual(listInstalledSkills(fixture.source), [], 'the source keeps no half-installed skill');
    assert.equal(existsSync(join(fixture.agents[0]!.root, 'pdf-tools')), false, 'earlier links are removed');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function readdirLength(path: string): number {
  try {
    return statSync(path).isDirectory() ? readdirSync(path).length : 0;
  } catch {
    return 0;
  }
}

// ---- MCP catalog ----

const MCP_CATALOG = {
  servers: [
    {
      server: {
        name: 'io.github.acme/files',
        title: 'Files',
        description: 'Read and write files.',
        version: '1.2.0',
        repository: { url: 'https://github.com/acme/files' },
        packages: [
          {
            registryType: 'npm',
            identifier: '@acme/files-mcp',
            version: '1.2.0',
            transport: { type: 'stdio' },
            runtimeArguments: [{ type: 'named', name: '--root', value: '/tmp' }],
            packageArguments: [{ type: 'positional', default: 'serve' }],
            environmentVariables: [
              { name: 'ACME_TOKEN', isRequired: true, isSecret: true, description: 'API token' },
              { name: 'ACME_REGION', default: 'eu', description: 'Region' },
              { name: 'ACME_OPTIONAL', description: 'only when needed' },
            ],
          },
          {
            registryType: 'mcpb',
            identifier: 'https://example.com/files.mcpb',
            transport: { type: 'stdio' },
          },
        ],
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://{region}.acme.dev/mcp',
            variables: { region: { default: 'eu' } },
            headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
          },
          {
            type: 'streamable-http',
            url: 'https://api.acme.dev/mcp',
            headers: [
              {
                name: 'Authorization',
                value: 'Bearer {gateway_token}',
                isRequired: true,
                isSecret: true,
                description: 'Gateway token',
              },
              { name: 'X-Optional', value: 'Bearer {optional_token}' },
              {
                name: 'X-Region',
                value: 'Bearer {region_token}',
                variables: { region_token: { default: 'eu' } },
              },
            ],
          },
          {
            type: 'streamable-http',
            url: 'https://{tenant}.acme.dev/mcp',
            variables: { tenant: { isRequired: true, description: 'Tenant slug' } },
          },
        ],
      },
      _meta: { status: 'active', updatedAt: '2026-10-01T00:00:00Z' },
    },
    { server: { name: 'io.github.acme/old' }, _meta: { status: 'deleted' } },
    {},
  ],
  metadata: { nextCursor: 'io.github.acme/files:1.2.0' },
};

test('normalizeMcpServers maps packages and remotes into install options', () => {
  const items = normalizeMcpServers(MCP_CATALOG);
  assert.equal(items.length, 1, 'deleted and nameless rows are dropped');
  const server = items[0]!;
  assert.equal(server.id, 'io.github.acme/files');
  assert.equal(server.name, 'Files');
  assert.equal(server.owner, 'io.github.acme');
  assert.equal(server.installName, 'files');
  assert.equal(server.updatedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(server.options.length, 4, 'mcpb has no supported runner');

  const pkg = server.options.find((option) => option.transport === 'stdio')!;
  assert.equal(pkg.server.command, 'npx');
  assert.deepEqual(pkg.server.args, ['-y', '@acme/files-mcp@1.2.0', '--root', '/tmp', 'serve']);
  assert.deepEqual(pkg.server.env, { ACME_REGION: 'eu' }, 'optional inputs without a default are omitted');
  assert.deepEqual(
    pkg.variables.map((variable) => `${variable.target}:${variable.name}`),
    ['env:ACME_TOKEN'],
  );

  const remotes = server.options.filter((option) => option.transport === 'http');
  assert.equal(remotes.length, 3);
  const filled = remotes.find((option) => option.server.url === 'https://eu.acme.dev/mcp')!;
  assert.ok(filled, 'a URL variable with a default is filled in');
  assert.deepEqual(
    filled.variables.map((variable) => `${variable.target}:${variable.name}`),
    ['header:Authorization'],
  );
  const templated = remotes.find((option) => option.server.url === 'https://api.acme.dev/mcp')!;
  assert.ok(templated, 'a header value keeps its placeholder for the dialog');
  assert.deepEqual(templated.server.headers, {
    Authorization: 'Bearer {gateway_token}',
    'X-Region': 'Bearer eu',
  });
  assert.deepEqual(
    templated.variables.map((variable) => `${variable.target}:${variable.name}`),
    ['template:gateway_token'],
    'an optional templated header is omitted; a declared default is filled in',
  );
  assert.equal(templated.variables[0]?.isSecret, true, 'secrecy follows the header');
  const pending = remotes.find((option) => option.server.url?.includes('{tenant}'))!;
  assert.ok(pending, 'a required URL variable stays for the dialog');
  assert.deepEqual(
    pending.variables.map((variable) => `${variable.target}:${variable.name}`),
    ['url:tenant'],
  );
});

test('getMcpStoreReport searches by cursor and marks servers already in the source', async () => {
  behaviour.mcpCatalog = MCP_CATALOG;
  const report = await getMcpStoreReport({
    baseUrl,
    query: 'files',
    cursor: 'next',
    sourceNames: ['files'],
    sourcePath: '/mcp/servers.json',
  });

  assert.equal(report.kind, 'mcp');
  assert.equal(report.provider, 'MCP Registry');
  assert.equal(report.listing, 'search');
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0]?.inSource, true);
  assert.equal(report.nextCursor, 'io.github.acme/files:1.2.0');
  assert.equal(report.sourcePath, '/mcp/servers.json');

  const request = requests.find((entry) => entry.startsWith('/v0/servers?'));
  assert.ok(request, 'the registry route was called');
  assert.match(request, /search=files/);
  assert.match(request, /cursor=next/);
  assert.match(request, /version=latest/);
});

test('getMcpStoreReport refuses short searches and keeps the last page through an outage', async () => {
  behaviour.mcpCatalog = MCP_CATALOG;
  const first = await getMcpStoreReport({ baseUrl, query: 'files' });
  assert.equal(first.items.length, 1);

  behaviour.mcpStatus = 500;
  const stale = await getMcpStoreReport({ baseUrl, query: 'files', refresh: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.items.length, 1, 'the cached page is still shown');

  const short = await getMcpStoreReport({ baseUrl, query: 'fi' });
  assert.equal(short.items.length, 0);
  assert.match(short.error ?? '', /至少需要 3 个字符/);
});

test('mcpStoreBaseUrl accepts http(s) only and trims trailing slashes', () => {
  assert.equal(mcpStoreBaseUrl('https://mirror.example/mcp/'), 'https://mirror.example/mcp');
  assert.throws(() => mcpStoreBaseUrl('ftp://mirror'), /http\(s\)/);
});

test('installStoreMcp saves into the MCP source and syncs the selected agents', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-mcp-store-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const config = createAppConfig({ projectRoot: root, home, dataDir: join(root, 'data') });
    const input = {
      sourcePath: config.mcpSource,
      snapshotRoot: join(root, 'snapshots'),
      settingsFiles: config.settingsFiles,
    };
    const request = {
      name: 'files',
      agents: ['claude'],
      server: {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'files-mcp'],
        env: { TOKEN: 'secret' },
      },
    };

    const result = installStoreMcp({ ...input, request });
    assert.equal(result.name, 'files');
    assert.ok(result.snapshotIds.length >= 1);
    assert.match(result.message, /已保存 files/);
    assert.deepEqual(listMcpSourceNames(config.mcpSource), ['files']);

    const source = JSON.parse(readFileSync(config.mcpSource, 'utf8'));
    assert.equal(source.servers.files.command, 'npx');
    assert.equal(source.servers.files.env.TOKEN, 'secret');

    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.mcpServers.files.command, 'npx');

    assert.throws(
      () =>
        installStoreMcp({
          ...input,
          request: { name: 'files', server: { transport: 'stdio', command: 'npx' } },
        }),
      (error: unknown) => error instanceof AppError && error.status === 409,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
