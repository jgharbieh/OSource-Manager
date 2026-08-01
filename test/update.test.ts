import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertTool, now, selectComments, selectInstallations } from '../dist/core/db.js';
import { applyUpdate, detectBreaking } from '../dist/core/update.js';

// Tests run against compiled output (tsc -p tsconfig.json first), same as
// preview.test.ts. Fixtures are REAL throwaway git repos under os.tmpdir().
//
// The load-bearing assertions here are the REFUSALS: every refusal path is
// wrapped in refuseLeavesRepoUntouched(), which asserts `git status --porcelain`
// is byte-identical, HEAD is unchanged, the reflog is unchanged (proves no
// merge/reset happened), and NO journal event was written.
//
// No real agent config, no real HOME, no network (github probe is disabled via
// checkChangelog:false except in the one test that injects a fake fetch), and
// no docker.

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-upd-'));
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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitAll(dir: string, message: string): void {
  git(['add', '.'], dir);
  git(['commit', '-m', message], dir);
}

function addCommit(dir: string, name: string, content: string, message: string): void {
  writeFileSync(join(dir, name), content);
  commitAll(dir, message);
}

/** origin repo (1 commit) + a clone of it with origin/main upstream set. */
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
  git(['config', 'user.email', 'test@example.com'], clone);
  git(['config', 'user.name', 'Test'], clone);
  return { origin, clone };
}

/** Tool row + present disk installation pointing at dir. */
function toolAt(
  db: ReturnType<typeof openDb>,
  dir: string,
  overrides: { canonical_key?: string; kind?: string; version_local?: string | null } = {},
): number {
  const tool = insertTool(db, {
    canonical_key: overrides.canonical_key ?? `local:${dir.length}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'fixture',
    kind: (overrides.kind ?? 'repo') as 'repo',
  });
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, ?, 1, ?)',
  ).run(tool.id, dir, overrides.version_local ?? null, now());
  return tool.id;
}

function statusOf(dir: string): string {
  return git(['status', '--porcelain'], dir);
}

function headOf(dir: string): string {
  return git(['rev-parse', 'HEAD'], dir).trim();
}

function reflogOf(dir: string): string {
  try {
    // gitDirOf, not dir/.git — a linked worktree's .git is a gitdir pointer file.
    return readFileSync(join(gitDirOf(dir), 'logs', 'HEAD'), 'utf8');
  } catch {
    return '<none>';
  }
}

function eventCount(db: ReturnType<typeof openDb>, toolId: number): number {
  return selectComments(db, toolId).length;
}

/** Real git dir of a checkout (a linked worktree's .git is a gitdir pointer file). */
function gitDirOf(dir: string): string {
  return git(['rev-parse', '--absolute-git-dir'], dir).trim();
}

/**
 * Run applyUpdate expecting a refusal, and prove nothing moved:
 *  - `git status --porcelain` byte-identical
 *  - HEAD unchanged, HEAD reflog byte-identical (no merge/reset/checkout)
 *  - FETCH_HEAD absent — `git fetch` always writes it, so its absence proves
 *    applyUpdate did not even reach out to the remote
 *  - no journal event appended
 */
async function refuseLeavesRepoUntouched(
  db: ReturnType<typeof openDb>,
  toolId: number,
  dir: string,
) {
  const statusBefore = statusOf(dir);
  const headBefore = headOf(dir);
  const reflogBefore = reflogOf(dir);
  const eventsBefore = eventCount(db, toolId);
  // Clear the setup fetch's marker so any fetch by applyUpdate is unmissable.
  const fetchHead = join(gitDirOf(dir), 'FETCH_HEAD');
  rmSync(fetchHead, { force: true });

  const res = await applyUpdate(db, toolId, { checkChangelog: false });

  assert.equal(res.ok, false, `expected refusal, got: ${res.message}`);
  assert.equal(statusOf(dir), statusBefore, 'git status changed — applyUpdate mutated the worktree');
  assert.equal(headOf(dir), headBefore, 'HEAD moved on a refused update');
  assert.equal(reflogOf(dir), reflogBefore, 'HEAD reflog changed — something rewrote refs on a refused update');
  assert.equal(existsSync(fetchHead), false, 'FETCH_HEAD reappeared — applyUpdate fetched on a refused update');
  assert.equal(eventCount(db, toolId), eventsBefore, 'a refused update journalled an event');
  return res;
}

// --- the happy path -----------------------------------------------------

test('applyUpdate: clean + fast-forwardable repo succeeds, journals "updated X -> Y"', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2');
  git(['fetch'], clone); // preview refuses to verify ff without the object present

  const db = testDb();
  const id = toolAt(db, clone);

  const headBefore = headOf(clone);
  const res = await applyUpdate(db, id, { checkChangelog: false });

  assert.equal(res.ok, true, res.message);
  const data = res.data!;
  assert.equal(data.method, 'git-ff-only');
  assert.equal(data.changed, true);
  assert.equal(data.target, clone);
  assert.notEqual(data.version_after, data.version_before);
  assert.deepEqual(data.breaking, []);
  assert.equal(data.preview?.can_update, true);

  // the checkout really fast-forwarded onto origin's tip
  assert.equal(headOf(clone), headOf(origin));
  assert.notEqual(headOf(clone), headBefore);
  assert.equal(statusOf(clone), '', 'worktree should be clean after a fast-forward');
  // ff-only means no merge commit was created
  assert.equal(git(['rev-list', '--count', 'HEAD'], clone).trim(), '2');

  // journal: exactly the canonical event line
  const events = selectComments(db, id);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'event');
  assert.match(events[0].body, /^updated .+ -> .+$/);
  assert.ok(events[0].body.includes(String(data.version_after)));

  // installations.version_local refreshed so the UI is not stale until next scan
  const inst = selectInstallations(db, id)[0];
  assert.equal(inst.version_local, data.version_after);

  db.close();
});

test('applyUpdate: repo already at origin tip → refused, nothing touched', async () => {
  const root = tmpDir();
  const { clone } = makeOriginAndClone(root);

  const db = testDb();
  const id = toolAt(db, clone);
  const res = await refuseLeavesRepoUntouched(db, id, clone);
  assert.match(res.message, /already up to date/i);

  db.close();
});

// --- the refusals (the important ones) ----------------------------------

test('applyUpdate: dirty worktree → refused, git status byte-identical', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2');
  git(['fetch'], clone);
  // dirty it AFTER the fetch: an update is genuinely available, only the
  // worktree state stands in the way
  writeFileSync(join(clone, 'dirty.txt'), 'uncommitted\n');
  writeFileSync(join(clone, 'f.txt'), 'locally edited\n');

  const db = testDb();
  const id = toolAt(db, clone);

  const res = await refuseLeavesRepoUntouched(db, id, clone);
  assert.match(res.message, /uncommitted changes/i);

  // the uncommitted work is still exactly as the user left it
  assert.equal(readFileSync(join(clone, 'f.txt'), 'utf8'), 'locally edited\n');
  assert.equal(readFileSync(join(clone, 'dirty.txt'), 'utf8'), 'uncommitted\n');
  assert.equal(statusOf(clone), ' M f.txt\n?? dirty.txt\n');

  db.close();
});

test('applyUpdate: detached HEAD → refused, nothing touched', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2');
  git(['fetch'], clone);
  const sha = headOf(clone);
  git(['checkout', sha], clone);

  const db = testDb();
  const id = toolAt(db, clone);

  const res = await refuseLeavesRepoUntouched(db, id, clone);
  assert.match(res.message, /detached HEAD/i);

  db.close();
});

test('applyUpdate: diverged branch → refused, local commit survives', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'upstream.txt', 'remote work\n', 'c2-remote');
  git(['fetch'], clone);
  addCommit(clone, 'local.txt', 'local work\n', 'c2-local'); // now diverged

  const db = testDb();
  const id = toolAt(db, clone);

  const res = await refuseLeavesRepoUntouched(db, id, clone);
  assert.match(res.message, /not fast-forwardable|diverged/i);

  // the local-only commit is still the tip and its file is still there
  assert.equal(git(['log', '-1', '--pretty=%s'], clone).trim(), 'c2-local');
  assert.equal(readFileSync(join(clone, 'local.txt'), 'utf8'), 'local work\n');
  assert.equal(git(['rev-list', '--count', 'HEAD'], clone).trim(), '2');

  db.close();
});

test('applyUpdate: linked worktree → refused, nothing touched', async () => {
  const root = tmpDir();
  const { clone } = makeOriginAndClone(root);
  const wt = join(root, 'linked-wt');
  git(['worktree', 'add', '-b', 'wt-branch', wt], clone);

  const db = testDb();
  const id = toolAt(db, wt);

  const res = await refuseLeavesRepoUntouched(db, id, wt);
  assert.match(res.message, /linked worktree/i);

  db.close();
});

test('applyUpdate: no upstream tracking branch → refused, nothing touched', async () => {
  const root = tmpDir();
  const { origin } = makeOriginAndClone(root);
  const repo = join(root, 'standalone');
  mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  commitAll(repo, 'c1');
  git(['remote', 'add', 'origin', origin], repo);

  const db = testDb();
  const id = toolAt(db, repo);

  const res = await refuseLeavesRepoUntouched(db, id, repo);
  assert.match(res.message, /no upstream tracking branch/i);

  db.close();
});

test('applyUpdate: mid-merge repo (MERGE_HEAD present) → refused before fetching', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2');
  git(['fetch'], clone);
  // simulate an interrupted merge: clean worktree, but git is mid-operation
  writeFileSync(join(clone, '.git', 'MERGE_HEAD'), `${headOf(origin)}\n`);

  const db = testDb();
  const id = toolAt(db, clone);

  const res = await refuseLeavesRepoUntouched(db, id, clone);
  assert.match(res.message, /already in progress/i);

  db.close();
});

test('applyUpdate: repo whose remote object was never fetched → refused (preview gate holds)', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2'); // deliberately NOT fetched

  const db = testDb();
  const id = toolAt(db, clone);

  const res = await refuseLeavesRepoUntouched(db, id, clone);
  assert.match(res.message, /cannot verify fast-forward without fetching/i);

  db.close();
});

test('applyUpdate: unknown tool id → fail, never throws', async () => {
  const db = testDb();
  const res = await applyUpdate(db, 4242, { checkChangelog: false });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  db.close();
});

test('applyUpdate: non-repo, non-global kind → fail', async () => {
  const root = tmpDir();
  const dir = join(root, 'skill');
  mkdirSync(dir, { recursive: true });

  const db = testDb();
  const id = toolAt(db, dir, { canonical_key: 'skill:demo', kind: 'skill' });
  const res = await applyUpdate(db, id, { checkChangelog: false });

  assert.equal(res.ok, false);
  assert.match(res.message, /not supported/);
  assert.equal(eventCount(db, id), 0);

  db.close();
});

// --- global CLI gate (Phase 5 scope) ------------------------------------

test('applyUpdate: global-cli npm-g without allowGlobal → gated fail, nothing run, nothing journalled', async () => {
  const db = testDb();
  const tool = insertTool(db, { canonical_key: 'npm:some-cli', name: 'some-cli', kind: 'global-cli' });
  db.prepare(
    "INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, 'npm-g', '1.0.0', 1, ?)",
  ).run(tool.id, now());

  const res = await applyUpdate(db, tool.id, { checkChangelog: false });

  assert.equal(res.ok, false);
  assert.match(res.message, /gated/i);
  assert.match(res.message, /allowGlobal/);
  assert.match(res.message, /npm install -g some-cli@latest/);
  assert.equal(eventCount(db, tool.id), 0);
  assert.equal(selectInstallations(db, tool.id)[0].version_local, '1.0.0');

  db.close();
});

test('applyUpdate: global-cli winget without allowGlobal → gated fail naming the winget command', async () => {
  const db = testDb();
  const tool = insertTool(db, { canonical_key: 'winget:Acme.Widget', name: 'Widget', kind: 'global-cli' });
  db.prepare(
    "INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, 'winget', '2.0', 1, ?)",
  ).run(tool.id, now());

  const res = await applyUpdate(db, tool.id, { checkChangelog: false });

  assert.equal(res.ok, false);
  assert.match(res.message, /gated/i);
  assert.match(res.message, /winget upgrade --id Acme\.Widget/);
  assert.equal(eventCount(db, tool.id), 0);

  db.close();
});

test('applyUpdate: global-cli with no present global installation → fail before the gate message', async () => {
  const db = testDb();
  const tool = insertTool(db, { canonical_key: 'npm:ghost-cli', name: 'ghost-cli', kind: 'global-cli' });

  const res = await applyUpdate(db, tool.id, { checkChangelog: false, allowGlobal: true });

  assert.equal(res.ok, false);
  assert.match(res.message, /no present npm-g or winget installation/);
  assert.equal(eventCount(db, tool.id), 0);

  db.close();
});

// --- changelog breaking-keyword surfacing -------------------------------

test('detectBreaking: labels each release once, ignores benign notes', () => {
  const hits = detectBreaking([
    { tag: 'v2.0.0', name: 'Release 2.0.0', published_at: '', body_excerpt: 'BREAKING CHANGE: dropped node 18' },
    { tag: 'v1.9.0', name: 'Release 1.9.0', published_at: '', body_excerpt: 'bug fixes and docs' },
    { tag: 'v1.8.0', name: 'Release 1.8.0', published_at: '', body_excerpt: 'see the migration guide for details' },
  ]);
  assert.deepEqual(hits, ['v2.0.0: breaking change', 'v1.8.0: migration required']);
});

test('applyUpdate: breaking keywords in the changelog are surfaced in the message and journalled', async () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2');
  git(['fetch'], clone);

  const db = testDb();
  const id = toolAt(db, clone, { canonical_key: 'github.com/acme/widget', version_local: 'v1.0.0' });

  // injected fetch — no network, ever
  const calls: string[] = [];
  const fetchImpl = async (url: unknown) => {
    calls.push(String(url));
    const body = [
      { tag_name: 'v1.1.0', name: 'Release 1.1.0', published_at: '2026-07-01T00:00:00Z', body: 'BREAKING CHANGE: config format moved to TOML' },
      { tag_name: 'v1.0.0', name: 'Release 1.0.0', published_at: '2026-06-01T00:00:00Z', body: 'first release' },
    ];
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => body,
    };
  };

  const res = await applyUpdate(db, id, { fetchImpl: fetchImpl as unknown as typeof fetch });

  assert.equal(res.ok, true, res.message);
  assert.ok(calls.length > 0, 'the changelog probe should have run');
  assert.deepEqual(res.data!.breaking, ['v1.1.0: breaking change']);
  assert.match(res.message, /breaking changes/i);
  assert.match(res.message, /v1\.1\.0/);

  // the update still applied
  assert.equal(headOf(clone), headOf(origin));

  // journal carries both the canonical line and the warning
  const bodies = selectComments(db, id).map(c => c.body);
  assert.ok(bodies.some(b => /^updated .+ -> .+$/.test(b)), bodies.join(' | '));
  assert.ok(bodies.some(b => /breaking changes/i.test(b)), bodies.join(' | '));

  db.close();
});

test('applyUpdate: a refused update never runs the changelog probe or fetches', async () => {
  const root = tmpDir();
  const { clone } = makeOriginAndClone(root);
  writeFileSync(join(clone, 'dirty.txt'), 'uncommitted\n');

  const db = testDb();
  const id = toolAt(db, clone, { canonical_key: 'github.com/acme/widget', version_local: 'v1.0.0' });

  let called = 0;
  const fetchImpl = async () => {
    called++;
    throw new Error('the network must not be touched on a refusal');
  };

  const statusBefore = statusOf(clone);
  const headBefore = headOf(clone);
  const res = await applyUpdate(db, id, { fetchImpl: fetchImpl as unknown as typeof fetch });

  assert.equal(res.ok, false);
  assert.equal(called, 0, 'changelog probe ran on a refused update');
  assert.equal(statusOf(clone), statusBefore);
  assert.equal(headOf(clone), headBefore);
  assert.equal(eventCount(db, id), 0);

  db.close();
});
