import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/core/db.js';
import { DEFAULT_SETTINGS } from '../dist/core/types.js';
import { createOsmServer, type ServerHandle } from '../dist/web/server.js';

// Tests run against compiled output: `npm run test:core` compiles first.
// Note: PUT /api/settings is deliberately NOT exercised here — it writes the
// real ~/.osource/settings.json via saveSettings, and tests must not touch it.

interface Started {
  handle: ServerHandle;
  base: string;
  token: string;
  close: () => Promise<void>;
}

const started: Started[] = [];

async function startServer(): Promise<Started> {
  const dir = mkdtempSync(join(tmpdir(), 'osm-srv-test-'));
  const db = openDb(join(dir, 'osm.db'));
  const handle = await createOsmServer(db, structuredClone(DEFAULT_SETTINGS), {
    port: 0,
    uiDir: join(dir, 'no-such-ui'), // isolate from a real dist/ui build
  });
  const s: Started = {
    handle,
    base: `http://127.0.0.1:${handle.port}`,
    token: handle.token,
    close: async () => {
      await handle.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  started.push(s);
  return s;
}

after(async () => {
  for (const s of started) await s.close();
});

interface ApiResponse {
  status: number;
  body: any;
}

async function api(base: string, path: string, init?: RequestInit): Promise<ApiResponse> {
  const res = await fetch(base + path, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function postJson(token: string | null, payload: unknown): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['x-osm-token'] = token;
  return { method: 'POST', headers, body: JSON.stringify(payload) };
}

/** node:http request with full control over the Host header (fetch forbids it). */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/tools returns an empty list on a fresh db', async () => {
  const { base } = await startServer();
  const { status, body } = await api(base, '/api/tools');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, []);
});

test('GET /api/health needs no token, reports ok/version/uptime/db, still enforces Host check', async () => {
  const { base, handle } = await startServer();
  const { status, body } = await api(base, '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.db, 'ok');
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.uptime_s, 'number');
  assert.ok(body.uptime_s >= 0);

  const evil = await rawRequest(handle.port, '/api/health', { host: 'evil.com' });
  assert.equal(evil.status, 403);
});

test('GET /api/config exposes the per-run token, version, and settings summary', async () => {
  const { base, token } = await startServer();
  const { status, body } = await api(base, '/api/config');
  assert.equal(status, 200);
  assert.equal(body.token, token);
  assert.equal(typeof body.version, 'string');
  assert.equal(body.settingsSummary.port, DEFAULT_SETTINGS.port);
  assert.deepEqual(body.settingsSummary.scanDirs, DEFAULT_SETTINGS.scanDirs);
});

test('mutation without X-OSM-Token → 403; with token → ok', async () => {
  const { base, token } = await startServer();

  const noToken = await api(base, '/api/tools/track', postJson(null, { url: 'https://github.com/owner/demo' }));
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.ok, false);

  const badToken = await api(base, '/api/tools/track', postJson('wrong-token', { url: 'https://github.com/owner/demo' }));
  assert.equal(badToken.status, 403);

  const withToken = await api(base, '/api/tools/track', postJson(token, {
    url: 'https://github.com/owner/demo',
    why: 'looks useful',
  }));
  assert.equal(withToken.status, 200);
  assert.equal(withToken.body.ok, true);
  assert.equal(withToken.body.data.canonical_key, 'github.com/owner/demo');
});

test('Host header other than 127.0.0.1/localhost on the bound port → 403 (DNS-rebinding guard)', async () => {
  const { handle, base } = await startServer();

  const evil = await rawRequest(handle.port, '/api/tools', { host: 'evil.com' });
  assert.equal(evil.status, 403);

  const wrongPort = await rawRequest(handle.port, '/api/tools', { host: '127.0.0.1:1' });
  assert.equal(wrongPort.status, 403);

  const localhost = await rawRequest(handle.port, '/api/tools', { host: `localhost:${handle.port}` });
  assert.equal(localhost.status, 200);

  // sanity: normal fetch (Host = 127.0.0.1:port) still works
  const okRes = await api(base, '/api/tools');
  assert.equal(okRes.status, 200);
});

test('POST with a non-JSON content-type → 415; malformed JSON → 400', async () => {
  const { base, token } = await startServer();

  const plain = await api(base, '/api/tools/track', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-osm-token': token },
    body: 'url=https://github.com/owner/demo',
  });
  assert.equal(plain.status, 415);
  assert.equal(plain.body.ok, false);

  const badJson = await api(base, '/api/tools/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-osm-token': token },
    body: '{nope',
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.ok, false);
});

test('cross-origin Origin header on a mutation → 403', async () => {
  const { base, token, handle } = await startServer();

  const cross = await api(base, '/api/tools/track', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-osm-token': token,
      origin: 'http://evil.example.com',
    },
    body: JSON.stringify({ url: 'https://github.com/owner/demo' }),
  });
  assert.equal(cross.status, 403);

  const sameOrigin = await api(base, '/api/tools/track', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-osm-token': token,
      origin: `http://127.0.0.1:${handle.port}`,
    },
    body: JSON.stringify({ url: 'https://github.com/owner/demo' }),
  });
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.body.ok, true);
});

test('track → comment → retire flow over HTTP end-to-end', async () => {
  const { base, token } = await startServer();

  // track
  const tracked = await api(base, '/api/tools/track', postJson(token, {
    url: 'https://github.com/owner/widget',
    why: 'want to try it',
  }));
  assert.equal(tracked.body.ok, true);
  const id = tracked.body.data.id as number;
  assert.equal(tracked.body.data.verdict, 'wanted');
  assert.equal(tracked.body.data.why_i_want_it, 'want to try it');

  // shows up in the list
  const list = await api(base, '/api/tools');
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, id);

  // comment
  const commented = await api(base, `/api/tools/${id}/comment`, postJson(token, { body: 'first note' }));
  assert.equal(commented.body.ok, true);

  // detail carries the comment stream (user + tracking event)
  const detail = await api(base, `/api/tools/${id}`);
  assert.equal(detail.body.ok, true);
  const bodies = (detail.body.data.comments as any[]).map(c => c.body);
  assert.ok(bodies.includes('first note'), 'user comment present');
  assert.ok(
    (detail.body.data.comments as any[]).some(c => c.kind === 'event'),
    'tracking event journaled',
  );

  // comment without a body → 400
  const emptyComment = await api(base, `/api/tools/${id}/comment`, postJson(token, {}));
  assert.equal(emptyComment.status, 400);

  // retire requires a reason
  const noReason = await api(base, `/api/tools/${id}/retire`, postJson(token, {}));
  assert.equal(noReason.status, 400);

  // retire
  const retired = await api(base, `/api/tools/${id}/retire`, postJson(token, { reason: 'not needed after all' }));
  assert.equal(retired.body.ok, true);

  const afterRetire = await api(base, `/api/tools/${id}`);
  assert.equal(afterRetire.body.data.tool.verdict, 'retired');
  assert.equal(afterRetire.body.data.tool.retire_reason, 'not needed after all');
});

test('PATCH favorite / auto_update, tags, search, and refresh-501', async () => {
  const { base, token } = await startServer();

  const tracked = await api(base, '/api/tools/track', postJson(token, { url: 'https://github.com/owner/patcher' }));
  const id = tracked.body.data.id as number;

  const patched = await api(base, `/api/tools/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-osm-token': token },
    body: JSON.stringify({ favorite: true, auto_update: true }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.ok, true);

  const detail = await api(base, `/api/tools/${id}`);
  assert.equal(detail.body.data.tool.favorite, 1);
  assert.equal(detail.body.data.tool.auto_update, 1);

  // tags
  const tagged = await api(base, `/api/tools/${id}/tags`, postJson(token, { tag: 'frontend' }));
  assert.equal(tagged.body.ok, true);
  let search = await api(base, '/api/search?tag=frontend');
  assert.equal(search.body.data.length, 1);

  const untagged = await api(base, `/api/tools/${id}/tags/frontend`, {
    method: 'DELETE',
    headers: { 'x-osm-token': token },
  });
  assert.equal(untagged.status, 200);
  assert.equal(untagged.body.ok, true);
  search = await api(base, '/api/search?tag=frontend');
  assert.equal(search.body.data.length, 0);

  // search filters
  search = await api(base, '/api/search?q=patcher&favorite=1&verdict=wanted');
  assert.equal(search.body.data.length, 1);
  search = await api(base, '/api/search?q=nomatch');
  assert.equal(search.body.data.length, 0);

  // refresh unwired → 501
  const refresh = await api(base, '/api/refresh', postJson(token, {}));
  assert.equal(refresh.status, 501);
  assert.equal(refresh.body.ok, false);
});

test('POST /api/refresh invokes the onRefresh callback and returns its report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osm-srv-test-'));
  const db = openDb(join(dir, 'osm.db'));
  let calls = 0;
  const handle = await createOsmServer(db, structuredClone(DEFAULT_SETTINGS), {
    port: 0,
    onRefresh: () => {
      calls++;
      return { ok: true, message: 'scan complete', data: { found: 3 } };
    },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/refresh`, postJson(handle.token, {}));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
    assert.equal(body.ok, true);
    assert.equal(body.data.found, 3);
  } finally {
    await handle.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Phase-2 read-only routes pass OpResult through without a token (non-github tool, no network)', async () => {
  const { base, token } = await startServer();

  // A local binary has no host adapter at all: checkUpstream refuses before any
  // fetch, and preview/plan-trial refuse tools with no present disk
  // installation. NOT an npm package — npm keys now resolve against the live
  // registry, and this test must never touch the network.
  const tracked = await api(base, '/api/tools/track', postJson(token, { name: 'C:\tools\thing.exe' }));
  assert.equal(tracked.body.ok, true);
  const id = tracked.body.data.id as number;

  const upstream = await api(base, `/api/tools/${id}/upstream`);
  assert.equal(upstream.status, 200);
  assert.equal(upstream.body.ok, false);
  assert.match(upstream.body.message, /unsupported host/);

  const preview = await api(base, `/api/tools/${id}/preview-update`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ok, false);
  assert.match(preview.body.message, /not checked out on this machine/);

  const plan = await api(base, `/api/tools/${id}/plan-trial`);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.ok, false);
  assert.match(plan.body.message, /not checked out on this machine/);

  const missing = await api(base, '/api/tools/999/upstream');
  assert.equal(missing.status, 200);
  assert.equal(missing.body.ok, false);
  assert.match(missing.body.message, /tool 999 not found/);
});

test('POST /api/upstream/refresh requires the token and reports checked/errors', async () => {
  const { base, token } = await startServer();
  // Local binary, not an npm package: nothing here has a live upstream to reach.
  await api(base, '/api/tools/track', postJson(token, { name: 'C:\tools\thing.exe' }));

  const denied = await api(base, '/api/upstream/refresh', postJson(null, {}));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.ok, false);

  const badLimit = await api(base, '/api/upstream/refresh', postJson(token, { limit: 0 }));
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.body.ok, false);

  // Only a hostless tool is tracked → zero live checks, zero network.
  const res = await api(base, '/api/upstream/refresh', postJson(token, { limit: 25 }));
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.checked, 0);
  assert.deepEqual(res.body.data.errors, []);
});

test('static files serve from uiDir with SPA fallback; traversal refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osm-srv-test-'));
  const uiDir = join(dir, 'ui');
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<h1>osm</h1>');
  writeFileSync(join(uiDir, 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'top secret'); // outside uiDir, must never be served

  const db = openDb(join(dir, 'osm.db'));
  const handle = await createOsmServer(db, structuredClone(DEFAULT_SETTINGS), { port: 0, uiDir });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await root.text(), '<h1>osm</h1>');

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);

    // SPA fallback: unknown non-api route serves index.html
    const spa = await fetch(`${base}/tools/42`);
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), '<h1>osm</h1>');

    // Encoded traversal survives URL parsing (only %2e%2e%2f does). It must never
    // escape uiDir: the resolver root-clamps/refuses it, so the response is the
    // SPA fallback or an error — never the file outside uiDir.
    const trav = await rawRequest(handle.port, '/%2e%2e%2fsecret.txt', {
      host: `127.0.0.1:${handle.port}`,
    });
    assert.ok(!trav.body.includes('top secret'), `traversal leaked a file outside uiDir (status ${trav.status})`);
  } finally {
    await handle.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
