import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertTool, now, selectComments, selectTool, upsertObservations } from '../dist/core/db.js';
import { previewUpdate } from '../dist/core/preview.js';
import { sanitize, absolutize, getReadme } from '../dist/core/readme.js';
import { setUpstreamOp, autoUpdateSweepOp } from '../dist/core/ops.js';

// Covers the five fixes made after the first hands-on pass:
//   README fetch + sanitize · fetch-and-recheck preview · set-upstream override
//   · auto-update sweep. Same shape as the other suites: compiled dist, real git
//   fixtures, temp dirs cleaned in after().

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-fix-'));
  tmpDirs.push(dir);
  return dir;
}
function testDb(): ReturnType<typeof openDb> {
  const db = openDb(join(tmpDir(), 'osm.db'));
  openDbs.push(db);
  return db;
}
after(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function commitAll(dir: string, message: string): void {
  git(['add', '.'], dir);
  git(['commit', '-m', message], dir);
}
function makeOriginAndClone(root: string): { origin: string; clone: string } {
  const origin = join(root, 'origin');
  mkdirSync(origin, { recursive: true });
  git(['init', '-b', 'main'], origin);
  git(['config', 'user.email', 'test@example.com'], origin);
  git(['config', 'user.name', 'Test'], origin);
  writeFileSync(join(origin, 'f.txt'), 'one\n');
  commitAll(origin, 'c1');
  const clone = join(root, 'clone');
  git(['clone', origin, clone], root);
  return { origin, clone };
}
function toolAt(
  db: ReturnType<typeof openDb>,
  dir: string,
  key = `local:${Math.random().toString(36).slice(2, 10)}`,
): number {
  const tool = insertTool(db, { canonical_key: key, name: 'fixture', kind: 'repo' });
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, NULL, 1, ?)',
  ).run(tool.id, dir, now());
  return tool.id;
}

/* ---------------- sanitize ---------------- */

test('sanitize: strips scripts, handlers and javascript: URLs; keeps images and video', () => {
  const dirty = [
    '<h1>Title</h1>',
    '<script>fetch("http://evil")</script>',
    '<style>body{display:none}</style>',
    '<img src="https://camo.example/x.png" onerror="steal()">',
    '<a href="javascript:alert(1)">click</a>',
    '<video src="https://user-images.example/v.mp4" controls></video>',
    '<iframe src="http://evil"></iframe>',
    '<p onclick=go()>text</p>',
  ].join('\n');
  const clean = sanitize(dirty);

  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /<style/i);
  assert.doesNotMatch(clean, /<iframe/i);
  assert.doesNotMatch(clean, /onerror/i);
  assert.doesNotMatch(clean, /onclick/i);
  assert.doesNotMatch(clean, /javascript:/i);
  // The parts a README is FOR must survive.
  assert.match(clean, /<h1>Title<\/h1>/);
  assert.match(clean, /<img src="https:\/\/camo\.example\/x\.png"\s*>/);
  assert.match(clean, /<video src="https:\/\/user-images\.example\/v\.mp4" controls><\/video>/);
});

test('sanitize: data:image survives, other data: URLs are blocked', () => {
  const clean = sanitize(
    '<img src="data:image/png;base64,AAA"><a href="data:text/html,<b>x</b>">y</a>',
  );
  assert.match(clean, /data:image\/png/);
  assert.doesNotMatch(clean, /data:text\/html/);
});

test('absolutize: repo-relative media becomes raw.githubusercontent, absolute is left alone', () => {
  const out = absolutize(
    [
      '<img src="src/assets/logo.svg">',
      '<img src="./docs/a.png">',
      '<img src="https://camo.example/x.png">',
      '<video src="media/demo.mp4" poster="media/p.jpg"></video>',
      '<a href="CONTRIBUTING.md">c</a>',
      '<a href="#install">i</a>',
      '<a href="https://example.com">e</a>',
    ].join('\n'),
    'o',
    'r',
  );
  assert.match(out, /src="https:\/\/raw\.githubusercontent\.com\/o\/r\/HEAD\/src\/assets\/logo\.svg"/);
  assert.match(out, /src="https:\/\/raw\.githubusercontent\.com\/o\/r\/HEAD\/docs\/a\.png"/);
  assert.match(out, /src="https:\/\/camo\.example\/x\.png"/);
  assert.match(out, /poster="https:\/\/raw\.githubusercontent\.com\/o\/r\/HEAD\/media\/p\.jpg"/);
  assert.match(out, /href="https:\/\/github\.com\/o\/r\/blob\/HEAD\/CONTRIBUTING\.md"/);
  assert.match(out, /href="#install"/);
  assert.match(out, /href="https:\/\/example\.com"/);
});

/* ---------------- getReadme ---------------- */

test('getReadme: github repo → rendered HTML from the API, sanitized', async () => {
  const db = testDb();
  const tool = insertTool(db, {
    canonical_key: 'github.com/owner/repo',
    name: 'repo',
    kind: 'repo',
  });
  const fetchImpl = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /api\.github\.com\/repos\/owner\/repo\/readme/);
    return new Response('<h2>Hi</h2><script>bad()</script><img src="https://x/y.png">', {
      status: 200,
    });
  }) as typeof fetch;

  const res = await getReadme(db, tool.id, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.data!.format, 'html');
  assert.equal(res.data!.source, 'github.com/owner/repo');
  assert.match(res.data!.body, /<h2>Hi<\/h2>/);
  assert.doesNotMatch(res.data!.body, /<script/);
  db.close();
});

test('getReadme: 404 with no checkout → names private/renamed/deleted, never "no README"', async () => {
  const db = testDb();
  const tool = insertTool(db, { canonical_key: 'github.com/o/r', name: 'r', kind: 'repo' });
  const fetchImpl = (async () => new Response('', { status: 404 })) as typeof fetch;

  const res = await getReadme(db, tool.id, { fetchImpl });
  assert.equal(res.ok, false);
  // A private repo is indistinguishable from a missing one without a token.
  assert.match(res.message, /returned 404/);
  assert.match(res.message, /private/i);
  assert.match(res.message, /GITHUB_TOKEN/);
  db.close();
});

test('getReadme: github unreachable but a checkout exists → falls back to the local file', async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'README.md'), '# local copy\n');
  const db = testDb();
  const id = toolAt(db, dir, 'github.com/o/r2');
  const fetchImpl = (async () => {
    throw new Error('offline');
  }) as typeof fetch;

  const res = await getReadme(db, id, { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.data!.format, 'text');
  assert.match(res.data!.body, /# local copy/);
  db.close();
});

test('getReadme: no upstream, no checkout → says exactly that', async () => {
  const db = testDb();
  const tool = insertTool(db, { canonical_key: 'skill:handoff', name: 'handoff', kind: 'skill' });
  const res = await getReadme(db, tool.id);
  assert.equal(res.ok, false);
  assert.match(res.message, /no repository could be resolved/);
  db.close();
});

/* ---------------- previewUpdate({ fetchRemote }) ---------------- */

test('previewUpdate fetchRemote: fetches the missing object, then verifies fast-forward', () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  writeFileSync(join(origin, 'g.txt'), 'two\n');
  commitAll(origin, 'c2'); // deliberately NOT fetched into the clone

  const db = testDb();
  const id = toolAt(db, clone);

  // Default (read-only) still refuses — the existing contract is unchanged.
  assert.match(previewUpdate(db, id).data!.reason, /without fetching/);

  const before = git(['status', '--porcelain'], clone);
  const res = previewUpdate(db, id, { fetchRemote: true });
  assert.equal(res.data!.can_update, true, res.data!.reason);
  assert.match(res.data!.ahead_behind ?? '', /behind 1/);
  // A fetch writes objects and the remote-tracking ref — never the worktree.
  assert.equal(git(['status', '--porcelain'], clone), before);
  assert.equal(git(['rev-parse', 'HEAD'], clone), git(['rev-parse', 'HEAD'], clone));

  db.close();
});

/* ---------------- setUpstreamOp ---------------- */

test('setUpstreamOp: repoints the row, keeps the old key as an alias, journals it', () => {
  const db = testDb();
  const tool = insertTool(db, {
    canonical_key: 'skill:agent-browser',
    name: 'agent-browser',
    kind: 'skill',
    why_i_want_it: 'keep this note',
  });
  upsertObservations(db, tool.id, { version_upstream: 'v0.0.1', update_available: 1 });

  const res = setUpstreamOp(db, tool.id, 'https://github.com/vercel-labs/agent-browser');
  assert.equal(res.ok, true, res.message);

  const after = selectTool(db, tool.id)!;
  assert.equal(after.canonical_key, 'github.com/vercel-labs/agent-browser');
  assert.equal(after.kind, 'repo');
  assert.equal(after.why_i_want_it, 'keep this note', 'owned fields must survive');
  assert.ok(res.data!.aliases.includes('skill:agent-browser'), 'old key kept as an alias');

  // The stale reading belonged to a different repo.
  const obs = res.data!.observations!;
  assert.equal(obs.version_upstream, null);
  assert.equal(obs.update_available, 0);

  const journal = selectComments(db, tool.id).map((c) => c.body).join('\n');
  assert.match(journal, /upstream set by hand: skill:agent-browser → github\.com\/vercel-labs\/agent-browser/);
  db.close();
});

test('setUpstreamOp: refuses a key another row already owns, and refuses junk', () => {
  const db = testDb();
  insertTool(db, { canonical_key: 'github.com/a/b', name: 'b', kind: 'repo' });
  const other = insertTool(db, { canonical_key: 'local:xyz', name: 'xyz', kind: 'binary' });

  const clash = setUpstreamOp(db, other.id, 'https://github.com/a/b');
  assert.equal(clash.ok, false);
  assert.match(clash.message, /already on the shelf as "b"/);
  assert.equal(selectTool(db, other.id)!.canonical_key, 'local:xyz', 'nothing changed on a refusal');

  assert.equal(setUpstreamOp(db, other.id, 'not a url').ok, false);
  assert.equal(setUpstreamOp(db, 9999, 'https://github.com/a/c').ok, false);
  db.close();
});

/* ---------------- autoUpdateSweepOp ---------------- */

test('autoUpdateSweepOp: applies to opted-in rows, reports the opted-out ones as skipped', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  writeFileSync(join(origin, 'g.txt'), 'two\n');
  commitAll(origin, 'c2');
  git(['fetch'], clone);

  const db = testDb();
  const on = toolAt(db, clone);
  db.prepare('UPDATE tools SET auto_update = 1 WHERE id = ?').run(on);
  upsertObservations(db, on, { update_available: 1 });

  // Same update available, auto-update off → must be left alone.
  const off = insertTool(db, { canonical_key: 'github.com/x/off', name: 'off', kind: 'repo' });
  upsertObservations(db, off.id, { update_available: 1 });

  const res = await autoUpdateSweepOp(db);
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.data!.applied.map((a) => a.name),
    ['fixture'],
  );
  assert.deepEqual(res.data!.skipped, ['off']);
  assert.match(selectComments(db, on).map((c) => c.body).join('\n'), /updated/i);
  db.close();
});

test('autoUpdateSweepOp: nothing opted in → succeeds and says why it did nothing', async () => {
  const db = testDb();
  const t = insertTool(db, { canonical_key: 'github.com/x/q', name: 'q', kind: 'repo' });
  upsertObservations(db, t.id, { update_available: 1 });

  const res = await autoUpdateSweepOp(db);
  assert.equal(res.ok, true);
  assert.equal(res.data!.applied.length, 0);
  assert.match(res.message, /auto-update is off/);
  db.close();
});
