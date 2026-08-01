import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  insertTool,
  selectObservations,
  replaceInstallationsForScan,
} from '../dist/core/db.js';
import {
  checkUpstream,
  refreshAllUpstream,
  changelogSince,
} from '../dist/core/github.js';

// Tests run against compiled output (tsc first); fetch is always injected so
// nothing here touches the network.

const tmpDirs = [];
const openDbs = [];
function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'osm-gh-test-'));
  tmpDirs.push(dir);
  const db = openDb(join(dir, 'osm.db'));
  openDbs.push(db);
  return db;
}

after(() => {
  for (const db of openDbs) db.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function fakeRes(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: k => map.get(String(k).toLowerCase()) ?? null },
    json: async () => body,
  };
}

function release(tag) {
  return {
    tag_name: tag,
    name: `Release ${tag}`,
    published_at: '2026-07-01T00:00:00Z',
    body: `notes for ${tag}`,
  };
}

/** fetchImpl stub: records calls, serves responses from a handler(url, headers). */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    return handler(String(url), init.headers ?? {});
  };
  fn.calls = calls;
  return fn;
}

function addRepoTool(db, key = 'github.com/owner/repo', localVersion = '2.1.220') {
  const name = key.split('/').pop() ?? key;
  const tool = insertTool(db, { canonical_key: key, name, kind: 'repo' });
  if (localVersion !== null) {
    replaceInstallationsForScan(db, tool.id, 'disk', [
      { where_: 'D:\\dev\\tools\\repo', version_local: localVersion },
    ]);
  }
  return tool;
}

test('paginates until the local tag is found (page 3), newest-first entries', async () => {
  const db = tmpDb();
  const tool = addRepoTool(db, 'github.com/owner/repo', '2.1.220');
  const pages = {
    1: { releases: ['v2.1.223', 'v2.1.222'], next: true },
    2: { releases: ['v2.1.221'], next: true },
    3: { releases: ['v2.1.220', 'v2.1.219'], next: true },
  };
  const fetchImpl = stubFetch(url => {
    const page = Number(new URL(url).searchParams.get('page'));
    const p = pages[page];
    return fakeRes(200, p.releases.map(release), {
      'x-ratelimit-remaining': '4999',
      ...(p.next ? { link: `<https://api.github.com/x?page=${page + 1}>; rel="next"` } : {}),
    });
  });

  const res = await checkUpstream(db, tool.id, { fetchImpl });
  assert.equal(res.ok, true, res.message);
  assert.equal(fetchImpl.calls.length, 3);
  assert.match(fetchImpl.calls[0].url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/releases\?per_page=100&page=1$/);
  assert.equal(res.data.version_upstream, 'v2.1.223');
  assert.equal(res.data.update_available, true);
  assert.equal(res.data.history_complete, true);
  assert.deepEqual(res.data.releases.map(r => r.tag), ['v2.1.223', 'v2.1.222', 'v2.1.221']);
  assert.equal(res.data.rate_limit_remaining, 4999);

  const obs = selectObservations(db, tool.id);
  assert.equal(obs.version_upstream, 'v2.1.223');
  assert.equal(obs.update_available, 1);
  assert.ok(obs.upstream_checked_at);
});

test('local tag absent from all pages → history_complete false, no silent partial changelog', async () => {
  const db = tmpDb();
  const tool = addRepoTool(db, 'github.com/owner/repo', '9.9.9');
  const fetchImpl = stubFetch(() =>
    fakeRes(200, ['v2.1.223', 'v2.1.222'].map(release)),
  );
  const res = await checkUpstream(db, tool.id, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.data.history_complete, false);
  assert.equal(res.data.update_available, false);
  assert.deepEqual(res.data.releases, []);
  assert.equal(res.data.version_upstream, 'v2.1.223');
});

test("'v'-prefix tolerance works in both directions", async () => {
  const db = tmpDb();
  // local has the 'v', the tag does not
  const tool = addRepoTool(db, 'github.com/owner/repo', 'v2.1.220');
  const fetchImpl = stubFetch(() =>
    fakeRes(200, ['2.1.221', '2.1.220'].map(release)),
  );
  const res = await checkUpstream(db, tool.id, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.data.history_complete, true);
  assert.equal(res.data.update_available, true);
  assert.deepEqual(res.data.releases.map(r => r.tag), ['2.1.221']);
});

test('ETag stored, If-None-Match sent on recheck, 304 keeps previous result', async () => {
  const db = tmpDb();
  const tool = addRepoTool(db, 'github.com/owner/repo', '2.1.220');

  const first = stubFetch(() =>
    fakeRes(200, ['v2.1.221', 'v2.1.220'].map(release), { etag: 'W/"abc123"' }),
  );
  const res1 = await checkUpstream(db, tool.id, { fetchImpl: first });
  assert.equal(res1.ok, true);
  assert.equal(selectObservations(db, tool.id).feed_etag, 'W/"abc123"');

  const second = stubFetch((_url, headers) => {
    assert.equal(headers['If-None-Match'], 'W/"abc123"');
    return fakeRes(304, null, { etag: 'W/"abc123"' });
  });
  const res2 = await checkUpstream(db, tool.id, { fetchImpl: second });
  assert.equal(res2.ok, true);
  assert.match(res2.message, /not modified/);
  assert.equal(res2.data.version_upstream, 'v2.1.221');
  assert.equal(res2.data.update_available, true);
  const obs = selectObservations(db, tool.id);
  assert.equal(obs.feed_etag, 'W/"abc123"');
  assert.ok(obs.upstream_checked_at);
});

test('403 with exhausted rate limit → ok:false with quota/reset message, never throws', async () => {
  const db = tmpDb();
  const tool = addRepoTool(db);
  const fetchImpl = stubFetch(() =>
    fakeRes(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1893456000',
    }),
  );
  const res = await checkUpstream(db, tool.id, { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.message, /rate limit/i);
  assert.match(res.message, /remaining 0/);
  assert.match(res.message, /resets 2030-01-01T00:00:00\.000Z/);
});

test('GITHUB_TOKEN is sent as Bearer and never persisted to the DB', async () => {
  const db = tmpDb();
  const tool = addRepoTool(db);
  const token = 'ghp_test-token-should-not-persist';
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = token;
  try {
    let seenAuth = null;
    const fetchImpl = stubFetch((_url, headers) => {
      seenAuth = headers.Authorization ?? null;
      return fakeRes(200, [release('v2.1.221'), release('v2.1.220')], { etag: 'W/"t"' });
    });
    const res = await checkUpstream(db, tool.id, { fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(seenAuth, `Bearer ${token}`);

    const obs = selectObservations(db, tool.id);
    assert.ok(!JSON.stringify(obs).includes(token), 'token leaked into observations');
    const comments = db.prepare('SELECT body FROM comments').all();
    assert.ok(!JSON.stringify(comments).includes(token), 'token leaked into comments');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

test('no local version → history incomplete, no update, but latest upstream still reported', async () => {
  const db = tmpDb();
  const tool = addRepoTool(db, 'github.com/owner/repo', null);
  const fetchImpl = stubFetch(() =>
    fakeRes(200, ['v3.0.0', 'v2.9.0'].map(release), {
      link: '<https://api.github.com/x?page=2>; rel="next"',
    }),
  );
  const res = await checkUpstream(db, tool.id, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(fetchImpl.calls.length, 1, 'no pagination without a local version');
  assert.equal(res.data.version_upstream, 'v3.0.0');
  assert.equal(res.data.history_complete, false);
  assert.equal(res.data.update_available, false);
});

test('unhostable keys → ok:false unsupported host; npm keys go to the registry', async () => {
  const db = tmpDb();
  const gitlab = insertTool(db, { canonical_key: 'gitlab.com/owner/repo', name: 'gl', kind: 'repo' });
  const local = insertTool(db, { canonical_key: 'local:abc123', name: 'thing', kind: 'binary' });
  const never = stubFetch(() => { throw new Error('must not be called'); });

  for (const id of [gitlab.id, local.id]) {
    const r = await checkUpstream(db, id, { fetchImpl: never });
    assert.equal(r.ok, false);
    assert.match(r.message, /unsupported host/);
  }
  assert.equal(never.calls.length, 0);

  // npm:<pkg> IS supported now: the registry is the authority on "am I current"
  // for a globally-installed CLI, not GitHub Releases.
  const npm = insertTool(db, { canonical_key: 'npm:some-cli', name: 'some-cli', kind: 'global-cli' });
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, ?, 1, ?)',
  ).run(npm.id, 'npm-g', '1.0.0', new Date().toISOString());
  const registry = stubFetch(url => {
    assert.match(url, /registry\.npmjs\.org\/some-cli/);
    return fakeRes(200, { 'dist-tags': { latest: '2.5.0' }, time: { '2.5.0': '2026-01-01T00:00:00Z' } });
  });
  const res = await checkUpstream(db, npm.id, { fetchImpl: registry });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data.version_upstream, '2.5.0');
  assert.equal(res.data.update_available, true);
  assert.equal(selectObservations(db, npm.id).version_upstream, '2.5.0');
});

test('changelogSince: pure-function cases', () => {
  const rels = ['v3', 'v2', 'v1'].map(t => ({ tag: t, name: t, published_at: '', body_excerpt: '' }));
  assert.deepEqual(changelogSince(rels, 'v1'), { entries: rels.slice(0, 2), history_complete: true });
  assert.deepEqual(changelogSince(rels, '3'), { entries: [], history_complete: true }); // v-tolerant, newest
  assert.deepEqual(changelogSince(rels, 'v9'), { entries: [], history_complete: false });
  assert.deepEqual(changelogSince(rels, ''), { entries: [], history_complete: false });
  assert.deepEqual(changelogSince([], 'v1'), { entries: [], history_complete: false });
});

test('refreshAllUpstream checks github repos + npm packages, collects errors, honors limit', async () => {
  const db = tmpDb();
  const t1 = addRepoTool(db, 'github.com/a/one', '1.0.0');
  const t2 = addRepoTool(db, 'github.com/b/two', '1.0.0');
  addRepoTool(db, 'gitlab.com/c/three', '1.0.0'); // skipped: no host adapter

  const fetchImpl = stubFetch(url => {
    if (url.includes('/repos/a/one/')) return fakeRes(200, [release('v1.1.0'), release('v1.0.0')]);
    if (url.includes('/repos/b/two/')) return fakeRes(404, { message: 'Not Found' });
    throw new Error(`unexpected url ${url}`);
  });

  const res = await refreshAllUpstream(db, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.data.checked, 1);
  assert.equal(res.data.errors.length, 1);
  assert.match(res.data.errors[0], /two/);
  assert.equal(selectObservations(db, t1.id).version_upstream, 'v1.1.0');
  assert.equal(selectObservations(db, t2.id), null); // failure wrote nothing

  const limited = await refreshAllUpstream(db, { fetchImpl, limit: 1 });
  assert.equal(limited.ok, true);
  assert.equal(limited.data.checked + limited.data.errors.length, 1);
});
