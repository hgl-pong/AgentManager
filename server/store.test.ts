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
  getStoreReport,
  installStoreSkill,
  listInstalledSkills,
  normalizeStoreSkills,
  rankStoreSkills,
  readManifest,
  storeBaseUrl,
  stripCommonDirectory,
} from './store.ts';
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

interface RegistryBehaviour {
  catalog?: unknown;
  catalogStatus?: number;
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

function readdirLength(path: string): number {
  try {
    return statSync(path).isDirectory() ? readdirSync(path).length : 0;
  } catch {
    return 0;
  }
}
