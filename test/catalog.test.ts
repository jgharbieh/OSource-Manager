import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertTool, addAlias } from '../dist/core/db.js';
import { searchCatalogs, skillDescription, ALL_CATALOG_SOURCES } from '../dist/core/catalog.js';

// Tests run against compiled output (tsc first). fetch AND exec are always
// injected, so nothing here touches the network or spawns docker.

const tmpDirs = [];
const openDbs = [];
function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'osm-cat-test-'));
  tmpDirs.push(dir);
  const db = openDb(join(dir, 'osm.db'));
  openDbs.push(db);
  return db;
}

after(() => {
  for (const db of openDbs) db.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/* ---------- stubs ---------- */

function fakeRes(status, body, headers = {}, text = null) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => map.get(String(k).toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (text === null ? JSON.stringify(body) : text),
  };
}

function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    return handler(String(url), init.headers ?? {});
  };
  fn.calls = calls;
  return fn;
}

const noFetch = stubFetch(url => {
  throw new Error(`fetch must not be called: ${url}`);
});

function execOk(stdout) {
  return { ok: true, stdout, stderr: '', error: null };
}
function execFail(error) {
  return { ok: false, stdout: '', stderr: error, error };
}

function stubExec(handler) {
  const calls = [];
  const fn = async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    return handler(bin, args);
  };
  fn.calls = calls;
  return fn;
}

const noExec = stubExec((_bin, args) => {
  throw new Error(`exec must not be called: ${args.join(' ')}`);
});

/* ---------- fixtures: the real CLI output captured from docker 29.5.3 ---------- */

const CATALOG_HELP = `Docker MCP Toolkit's CLI - Manage your MCP servers and clients.

Usage: docker mcp catalog

Available Commands:
  create      Create a new catalog from server references
  list        List catalogs
  server      Manage servers in catalogs
  show        Show a catalog
`;

const SERVER_LS_HELP = `Docker MCP Toolkit's CLI - Manage your MCP servers and clients.

Usage: docker mcp catalog server ls <oci-reference>

Flags:
  -f, --filter stringArray   Filter output (e.g., name=github)
      --format string        Supported: json, yaml, human. (default "human")
`;

const CATALOG_LIST_JSON = JSON.stringify([
  { ref: 'mcp/docker-mcp-catalog:latest', digest: 'abc', title: 'Docker MCP Catalog' },
]);

function catalogServersJson(servers) {
  return JSON.stringify({
    catalog: 'mcp/docker-mcp-catalog:latest',
    title: 'Docker MCP Catalog',
    servers: servers.map(s => ({ type: 'image', image: s.image, snapshot: { server: s } })),
  });
}

const SQLITE_SERVER = {
  name: 'SQLite',
  type: 'server',
  image: 'mcp/sqlite@sha256:efbc05',
  description: 'Database interaction and business intelligence capabilities.',
  title: 'SQLite (Archived)',
  readme: 'https://desktop.docker.com/mcp/catalog/v3/readme/SQLite.md',
  remote: {},
  metadata: { pulls: 48519, stars: 17, githubStars: 88031, owner: 'modelcontextprotocol' },
};

const GRAFANA_SERVER = {
  name: 'grafana',
  image: 'mcp/grafana@sha256:1234',
  description: 'Query dashboards and datasources.',
  remote: {},
  metadata: { stars: 4, owner: 'grafana' },
};

/** A docker exec stub that walks the real probe → list → ls sequence. */
function dockerStub(serversJson) {
  return stubExec((_bin, args) => {
    const line = args.join(' ');
    if (line === 'mcp catalog --help') return execOk(CATALOG_HELP);
    if (line === 'mcp catalog server ls --help') return execOk(SERVER_LS_HELP);
    if (line === 'mcp catalog list --format json') return execOk(CATALOG_LIST_JSON);
    if (line.startsWith('mcp catalog server ls mcp/docker-mcp-catalog:latest')) return execOk(serversJson);
    throw new Error(`unexpected docker argv: ${line}`);
  });
}

function only(sources) {
  return { sources };
}

/* ---------- docker source ---------- */

test('docker: probes --help FIRST, then adapts to the real `server ls <oci-reference>` shape', async () => {
  const db = tmpDb();
  const execImpl = dockerStub(catalogServersJson([SQLITE_SERVER, GRAFANA_SERVER]));
  const res = await searchCatalogs(db, only(['docker']), { execImpl, fetchImpl: noFetch });

  assert.equal(res.ok, true, res.message);
  // The very first thing that runs is the probe — nothing is assumed.
  assert.deepEqual(execImpl.calls[0].args, ['mcp', 'catalog', '--help']);
  assert.deepEqual(execImpl.calls[1].args, ['mcp', 'catalog', 'server', 'ls', '--help']);
  assert.deepEqual(execImpl.calls[2].args, ['mcp', 'catalog', 'list', '--format', 'json']);
  // Positional OCI reference + json format, learned from the help text.
  assert.deepEqual(execImpl.calls[3].args, [
    'mcp', 'catalog', 'server', 'ls', 'mcp/docker-mcp-catalog:latest', '--format', 'json',
  ]);
  // Every call is an argv ARRAY, never a shell string.
  for (const c of execImpl.calls) assert.ok(Array.isArray(c.args), 'argv must be an array');

  assert.equal(res.data.items.length, 2);
  const sqlite = res.data.items[0];
  assert.equal(sqlite.source, 'docker');
  assert.equal(sqlite.name, 'SQLite');
  assert.match(sqlite.description, /Database interaction/);
  assert.equal(sqlite.url, 'https://hub.docker.com/r/mcp/sqlite');
  assert.equal(sqlite.stars, 88031);
  assert.match(sqlite.provenance, /mcp\/docker-mcp-catalog:latest/);
  assert.match(sqlite.provenance, /modelcontextprotocol/);
  assert.equal(res.data.sources[0].ok, true);
  assert.equal(res.data.sources[0].count, 2);
});

test('docker: a catalog server has no canonical key — Track is withheld with a stated reason', async () => {
  const db = tmpDb();
  const execImpl = dockerStub(catalogServersJson([SQLITE_SERVER]));
  const res = await searchCatalogs(db, only(['docker']), { execImpl, fetchImpl: noFetch });
  const item = res.data.items[0];
  assert.equal(item.track, null);
  assert.equal(item.already_tracked, false);
  assert.match(item.track_hint, /identified by its image/i);
});

test('docker absent → that source degrades, the others still answer', async () => {
  const db = tmpDb();
  const execImpl = stubExec(() => execFail('spawn docker ENOENT'));
  const fetchImpl = stubFetch(() => fakeRes(200, [], { 'x-ratelimit-remaining': '58' }));

  const res = await searchCatalogs(db, only(['docker', 'anthropic']), { execImpl, fetchImpl });
  assert.equal(res.ok, true, 'a dead source is data, not a failure');
  const docker = res.data.sources.find(s => s.id === 'docker');
  assert.equal(docker.ok, false);
  assert.match(docker.message, /not available/);
  assert.match(docker.message, /ENOENT/);
  assert.equal(execImpl.calls.length, 1, 'stops after the failed probe');
  assert.equal(res.data.sources.find(s => s.id === 'anthropic').ok, true);
  assert.match(res.message, /unavailable: docker/);
});

test('docker: a build without a `server` subcommand is refused, not guessed at', async () => {
  const db = tmpDb();
  const execImpl = stubExec(() => execOk('Usage: docker mcp catalog\n\nAvailable Commands:\n  list  List catalogs\n'));
  const res = await searchCatalogs(db, only(['docker']), { execImpl, fetchImpl: noFetch });
  const docker = res.data.sources[0];
  assert.equal(docker.ok, false);
  assert.match(docker.message, /no `server` command/);
  assert.equal(execImpl.calls.length, 1);
});

test('docker: unreadable JSON degrades to a named error instead of throwing', async () => {
  const db = tmpDb();
  const execImpl = stubExec((_bin, args) => {
    const line = args.join(' ');
    if (line === 'mcp catalog --help') return execOk(CATALOG_HELP);
    if (line === 'mcp catalog server ls --help') return execOk(SERVER_LS_HELP);
    if (line === 'mcp catalog list --format json') return execOk(CATALOG_LIST_JSON);
    return execOk('not json at all');
  });
  const res = await searchCatalogs(db, only(['docker']), { execImpl, fetchImpl: noFetch });
  assert.equal(res.ok, true);
  assert.equal(res.data.items.length, 0);
  assert.equal(res.data.sources[0].ok, false);
  assert.match(res.data.sources[0].message, /unreadable JSON/);
});

test('docker: the CLI filter is pushed down when the help text advertises one', async () => {
  const db = tmpDb();
  const execImpl = dockerStub(catalogServersJson([GRAFANA_SERVER]));
  await searchCatalogs(db, { sources: ['docker'], q: 'grafana' }, { execImpl, fetchImpl: noFetch });
  const ls = execImpl.calls.find(c => c.args.includes('ls') && !c.args.includes('--help'));
  assert.deepEqual(ls.args, [
    'mcp', 'catalog', 'server', 'ls', 'mcp/docker-mcp-catalog:latest',
    '--filter', 'name=grafana', '--format', 'json',
  ]);
});

/* ---------- github search source ---------- */

function ghRepo(fullName, stars, extra = {}) {
  return {
    full_name: fullName,
    name: fullName.split('/')[1],
    html_url: `https://github.com/${fullName}`,
    description: `desc for ${fullName}`,
    stargazers_count: stars,
    language: 'TypeScript',
    pushed_at: '2026-07-30T10:00:00Z',
    ...extra,
  };
}

test('github: search URL shape, mapping, and remaining quota surfaced in the response', async () => {
  const db = tmpDb();
  const fetchImpl = stubFetch(() =>
    fakeRes(200, { total_count: 412, items: [ghRepo('steel-dev/steel-browser', 4210)] }, {
      'x-ratelimit-remaining': '7',
      'x-ratelimit-limit': '10',
      'x-ratelimit-reset': '1893456000',
      'x-ratelimit-resource': 'search',
    }),
  );
  const res = await searchCatalogs(db, { sources: ['github'], q: 'browser agent', limit: 5 }, { fetchImpl, execImpl: noExec, env: {} });

  assert.equal(res.ok, true, res.message);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.github.com/search/repositories');
  assert.equal(url.searchParams.get('q'), 'browser agent');
  assert.equal(url.searchParams.get('sort'), 'stars');
  assert.equal(url.searchParams.get('per_page'), '5');

  const item = res.data.items[0];
  assert.equal(item.source, 'github');
  assert.equal(item.name, 'steel-dev/steel-browser');
  assert.equal(item.url, 'https://github.com/steel-dev/steel-browser');
  assert.equal(item.stars, 4210);
  assert.equal(item.already_tracked, false);
  assert.deepEqual(item.track, { url: 'https://github.com/steel-dev/steel-browser' });
  assert.match(item.provenance, /github search/);
  assert.match(item.provenance, /pushed 2026-07-30/);

  assert.equal(res.data.github_quota.remaining, 7);
  assert.equal(res.data.github_quota.limit, 10);
  assert.equal(res.data.github_quota.resource, 'search');
  assert.equal(res.data.github_quota.reset, '2030-01-01T00:00:00.000Z');
  assert.match(res.data.sources[0].message, /search quota 7\/10 left/);
});

test('github: 403 degrades with the quota + reset time, never throws', async () => {
  const db = tmpDb();
  const fetchImpl = stubFetch(() =>
    fakeRes(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1893456000',
      'x-ratelimit-resource': 'search',
    }),
  );
  const res = await searchCatalogs(db, { sources: ['github'], q: 'mcp' }, { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.ok, true, 'the page still renders');
  assert.equal(res.data.items.length, 0);
  const s = res.data.sources[0];
  assert.equal(s.ok, false);
  assert.match(s.message, /rate limit exhausted/i);
  assert.match(s.message, /remaining 0/);
  assert.match(s.message, /resets 2030-01-01T00:00:00\.000Z/);
  assert.match(s.message, /GITHUB_TOKEN/);
  assert.equal(res.data.github_quota.remaining, 0);
});

test('github: no filter → no request at all, so no quota is spent', async () => {
  const db = tmpDb();
  const fetchImpl = stubFetch(() => {
    throw new Error('must not search without a query');
  });
  const res = await searchCatalogs(db, only(['github']), { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(res.data.sources[0].ok, true);
  assert.match(res.data.sources[0].message, /costs rate limit/);
});

test('github: a rejected fetch is a degraded source, not a thrown error', async () => {
  const db = tmpDb();
  const fetchImpl = stubFetch(() => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  });
  const res = await searchCatalogs(db, { sources: ['github'], q: 'x' }, { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.data.sources[0].ok, false);
  assert.match(res.data.sources[0].message, /ENOTFOUND/);
});

test('github: an already-tracked repo is matched through an SSH ALIAS and carries its row id', async () => {
  const db = tmpDb();
  const tool = insertTool(db, {
    canonical_key: 'local:deadbeef0000',
    name: 'steel-browser',
    kind: 'repo',
  });
  // The clone was discovered by path, with the SSH remote recorded as an alias.
  addAlias(db, tool.id, 'git@github.com:steel-dev/steel-browser.git');

  const fetchImpl = stubFetch(() =>
    fakeRes(200, { total_count: 1, items: [ghRepo('steel-dev/steel-browser', 4210)] }, {}),
  );
  const res = await searchCatalogs(db, { sources: ['github'], q: 'steel' }, { fetchImpl, execImpl: noExec, env: {} });
  const item = res.data.items[0];
  assert.equal(item.already_tracked, true);
  assert.equal(item.tool_id, tool.id);
});

test('github: canonical-key match wins for a plainly tracked repo', async () => {
  const db = tmpDb();
  const tool = insertTool(db, { canonical_key: 'github.com/steel-dev/steel-browser', name: 'steel-browser', kind: 'repo' });
  const fetchImpl = stubFetch(() => fakeRes(200, { total_count: 1, items: [ghRepo('steel-dev/steel-browser', 1)] }, {}));
  const res = await searchCatalogs(db, { sources: ['github'], q: 'steel' }, { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.data.items[0].already_tracked, true);
  assert.equal(res.data.items[0].tool_id, tool.id);
});

test('GITHUB_TOKEN is sent as Bearer and never appears in the response', async () => {
  const db = tmpDb();
  const token = 'ghp_browse-token-should-not-leak';
  let seenAuth = null;
  const fetchImpl = stubFetch((_url, headers) => {
    seenAuth = headers.Authorization ?? null;
    return fakeRes(200, { total_count: 1, items: [ghRepo('a/b', 3)] }, { 'x-ratelimit-remaining': '4999' });
  });
  const res = await searchCatalogs(
    db,
    { sources: ['github'], q: 'anything' },
    { fetchImpl, execImpl: noExec, env: { GITHUB_TOKEN: token } },
  );
  assert.equal(seenAuth, `Bearer ${token}`);
  assert.ok(!JSON.stringify(res).includes(token), 'token leaked into the catalog response');
});

/* ---------- anthropic skills source ---------- */

function skillsContents(names) {
  return names.map(n => ({
    name: n,
    path: `skills/${n}`,
    type: 'dir',
    html_url: `https://github.com/anthropics/skills/tree/main/skills/${n}`,
  }));
}

const PDF_SKILL_MD = `---
name: pdf
description: Comprehensive PDF manipulation toolkit for extracting text and tables.
license: Proprietary
---

# PDF processing
`;

test('anthropic: lists skill directories, reads each SKILL.md description off raw (no API quota)', async () => {
  const db = tmpDb();
  const fetchImpl = stubFetch(url => {
    if (url.startsWith('https://api.github.com/repos/anthropics/skills/contents/skills')) {
      return fakeRes(200, [
        ...skillsContents(['pdf', 'docx']),
        { name: 'README.md', type: 'file' },
        { name: '.hidden', type: 'dir' },
      ], { 'x-ratelimit-remaining': '55', 'x-ratelimit-limit': '60', 'x-ratelimit-resource': 'core' });
    }
    if (url.endsWith('/skills/pdf/SKILL.md')) return fakeRes(200, null, {}, PDF_SKILL_MD);
    return fakeRes(404, null, {}, '');
  });

  const res = await searchCatalogs(db, only(['anthropic']), { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data.items.length, 2, 'files and dotfolders are not skills');

  const pdf = res.data.items[0];
  assert.equal(pdf.source, 'anthropic');
  assert.equal(pdf.name, 'pdf');
  assert.match(pdf.description, /Comprehensive PDF manipulation toolkit/);
  assert.equal(pdf.url, 'https://github.com/anthropics/skills/tree/main/skills/pdf');
  assert.equal(pdf.provenance, 'anthropics/skills · skills/pdf');
  // No canonical key reachable from a URL — Track says so instead of lying.
  assert.equal(pdf.track, null);
  assert.match(pdf.track_hint, /skill:<name>/);

  // A skill whose SKILL.md 404s still gets a card, just a thinner one.
  assert.match(res.data.items[1].description, /open it to read SKILL\.md/);
  assert.equal(res.data.github_quota.remaining, 55);
  assert.equal(res.data.github_quota.resource, 'core');
});

test('anthropic: a skill already on the shelf is flagged with its row id', async () => {
  const db = tmpDb();
  const tool = insertTool(db, { canonical_key: 'skill:pdf', name: 'pdf', kind: 'skill' });
  const fetchImpl = stubFetch(url =>
    url.includes('/contents/skills')
      ? fakeRes(200, skillsContents(['pdf']), {})
      : fakeRes(404, null, {}, ''),
  );
  const res = await searchCatalogs(db, only(['anthropic']), { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.data.items[0].already_tracked, true);
  assert.equal(res.data.items[0].tool_id, tool.id);
});

test('anthropic: the filter narrows the listing before any SKILL.md is fetched', async () => {
  const db = tmpDb();
  const fetchImpl = stubFetch(url =>
    url.includes('/contents/skills')
      ? fakeRes(200, skillsContents(['pdf', 'docx', 'xlsx']), {})
      : fakeRes(404, null, {}, ''),
  );
  const res = await searchCatalogs(db, { sources: ['anthropic'], q: 'doc' }, { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.items[0].name, 'docx');
  assert.equal(fetchImpl.calls.length, 2, 'one listing + one SKILL.md, not one per skill in the repo');
});

test('anthropic: a 403 on the contents API degrades with the reset time', async () => {
  const db = tmpDb();
  const fetchImpl = stubFetch(() =>
    fakeRes(403, null, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1893456000', 'x-ratelimit-resource': 'core' }),
  );
  const res = await searchCatalogs(db, only(['anthropic']), { fetchImpl, execImpl: noExec, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.data.sources[0].ok, false);
  assert.match(res.data.sources[0].message, /rate limit exhausted/i);
});

test('skillDescription: plain, quoted, folded and absent frontmatter', () => {
  assert.equal(skillDescription(PDF_SKILL_MD), 'Comprehensive PDF manipulation toolkit for extracting text and tables.');
  assert.equal(skillDescription('---\ndescription: "quoted value"\n---\n'), 'quoted value');
  assert.equal(skillDescription('---\ndescription: >-\n  folded over\n  two lines\nname: x\n---\n'), 'folded over two lines');
  assert.equal(skillDescription('# no frontmatter\n'), '');
  assert.equal(skillDescription('---\nname: only\n---\n'), '');
});

/* ---------- cross-cutting guarantees ---------- */

test('limit is applied per source', async () => {
  const db = tmpDb();
  const execImpl = dockerStub(catalogServersJson([SQLITE_SERVER, GRAFANA_SERVER, { ...GRAFANA_SERVER, name: 'third' }]));
  const fetchImpl = stubFetch(url =>
    url.includes('/search/repositories')
      ? fakeRes(200, { total_count: 3, items: [ghRepo('a/one', 1), ghRepo('b/two', 2), ghRepo('c/three', 3)] }, {})
      : fakeRes(200, skillsContents(['pdf', 'docx', 'xlsx']), {}),
  );
  const res = await searchCatalogs(db, { sources: ['docker', 'github'], q: 'x', limit: 2 }, { execImpl, fetchImpl, env: {} });
  for (const s of res.data.sources) assert.ok(s.count <= 2, `${s.id} returned ${s.count}`);
  assert.ok(res.data.items.length <= 4);
});

test('an empty sources list queries nothing at all', async () => {
  const db = tmpDb();
  const res = await searchCatalogs(db, { sources: [] }, { fetchImpl: noFetch, execImpl: noExec });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.items, []);
  assert.deepEqual(res.data.sources, []);
});

test('an absent sources list queries every known source', async () => {
  const db = tmpDb();
  const execImpl = dockerStub(catalogServersJson([SQLITE_SERVER]));
  const fetchImpl = stubFetch(url =>
    url.includes('/contents/skills') ? fakeRes(200, skillsContents([]), {}) : fakeRes(200, { items: [] }, {}),
  );
  const res = await searchCatalogs(db, {}, { execImpl, fetchImpl, env: {} });
  assert.deepEqual(
    res.data.sources.map(s => s.id).sort(),
    [...ALL_CATALOG_SOURCES].sort(),
  );
});

test('catalogs are queried LIVE — a full browse writes nothing to the database', async () => {
  const db = tmpDb();
  insertTool(db, { canonical_key: 'skill:pdf', name: 'pdf', kind: 'skill' });
  const count = table => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const before = {
    tools: count('tools'),
    aliases: count('aliases'),
    comments: count('comments'),
    observations: count('observations'),
    installations: count('installations'),
    tags: count('tags'),
    trials: count('trials'),
  };

  const execImpl = dockerStub(catalogServersJson([SQLITE_SERVER, GRAFANA_SERVER]));
  const fetchImpl = stubFetch(url => {
    if (url.includes('/contents/skills')) return fakeRes(200, skillsContents(['pdf']), {});
    if (url.includes('/search/repositories')) {
      return fakeRes(200, { total_count: 1, items: [ghRepo('steel-dev/steel-browser', 9)] }, {});
    }
    return fakeRes(200, null, {}, PDF_SKILL_MD);
  });

  const res = await searchCatalogs(db, { q: 'pdf' }, { execImpl, fetchImpl, env: {} });
  assert.equal(res.ok, true);
  assert.ok(res.data.items.length > 0, 'the test needs real results to be meaningful');

  const after = {
    tools: count('tools'),
    aliases: count('aliases'),
    comments: count('comments'),
    observations: count('observations'),
    installations: count('installations'),
    tags: count('tags'),
    trials: count('trials'),
  };
  assert.deepEqual(after, before, 'browse mirrored catalog data into the DB');
});

test('one exploding source never takes the whole page down', async () => {
  const db = tmpDb();
  const execImpl = stubExec(() => {
    throw new Error('docker runner blew up');
  });
  const fetchImpl = stubFetch(url =>
    url.includes('/contents/skills') ? fakeRes(200, skillsContents(['pdf']), {}) : fakeRes(404, null, {}, ''),
  );
  const res = await searchCatalogs(db, only(['docker', 'anthropic']), { execImpl, fetchImpl, env: {} });
  assert.equal(res.ok, true);
  const docker = res.data.sources.find(s => s.id === 'docker');
  assert.equal(docker.ok, false);
  assert.match(docker.message, /blew up/);
  assert.equal(res.data.sources.find(s => s.id === 'anthropic').count, 1);
});

test('queried_at is stamped on every response', async () => {
  const db = tmpDb();
  const res = await searchCatalogs(db, { sources: [] }, { fetchImpl: noFetch, execImpl: noExec });
  assert.match(res.data.queried_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
