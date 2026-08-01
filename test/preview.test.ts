import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertTool, now } from '../dist/core/db.js';
import { previewUpdate, planTrial } from '../dist/core/preview.js';

// Tests run against compiled output (tsc -p tsconfig.json first), same as db.test.ts.
// Fixtures are REAL git repos (git is on PATH); preview.ts must never mutate them —
// every previewUpdate call is wrapped in an assertion that `git status --porcelain`
// is byte-identical before and after.

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-prev-'));
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
  return { origin, clone };
}

function addCommit(dir: string, name: string, content: string, message: string): void {
  writeFileSync(join(dir, name), content);
  commitAll(dir, message);
}

/** Tool row + present disk installation pointing at dir. */
function toolAt(db: ReturnType<typeof openDb>, dir: string): number {
  const tool = insertTool(db, {
    canonical_key: `local/${dir.length}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'fixture',
    kind: 'repo',
  });
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, NULL, 1, ?)',
  ).run(tool.id, dir, now());
  return tool.id;
}

function statusOf(dir: string): string {
  return git(['status', '--porcelain'], dir);
}

/** Call previewUpdate and assert the worktree was not touched. */
function previewReadOnly(db: ReturnType<typeof openDb>, toolId: number, dir: string) {
  const before = statusOf(dir);
  const result = previewUpdate(db, toolId);
  const after = statusOf(dir);
  assert.equal(after, before, 'git status changed — previewUpdate mutated the worktree');
  return result;
}

// --- preview_update ---

test('previewUpdate: clean repo, remote object fetched → can_update true, ahead 0 behind 1', () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2');
  git(['fetch'], clone); // the TEST may fetch to set up the fixture; previewUpdate never does

  const db = testDb();
  const id = toolAt(db, clone);
  const res = previewReadOnly(db, id, clone);

  assert.equal(res.ok, true);
  const p = res.data!;
  assert.equal(p.can_update, true);
  assert.match(p.reason, /fast-forward/);
  assert.equal(p.ahead_behind, 'ahead 0, behind 1');
  assert.ok(p.upstream_ref?.startsWith('origin/main@'));
  assert.ok(p.local_version);

  db.close();
});

test('previewUpdate: dirty worktree → refused, names uncommitted changes', () => {
  const root = tmpDir();
  const { clone } = makeOriginAndClone(root);
  writeFileSync(join(clone, 'dirty.txt'), 'uncommitted\n');

  const db = testDb();
  const id = toolAt(db, clone);
  const res = previewReadOnly(db, id, clone);

  assert.equal(res.ok, true); // the preview itself succeeds; the update is refused
  assert.equal(res.data!.can_update, false);
  assert.match(res.data!.reason, /uncommitted changes/);

  db.close();
});

test('previewUpdate: detached HEAD → refused', () => {
  const root = tmpDir();
  const { clone } = makeOriginAndClone(root);
  const sha = git(['rev-parse', 'HEAD'], clone).trim();
  git(['checkout', sha], clone);

  const db = testDb();
  const id = toolAt(db, clone);
  const res = previewReadOnly(db, id, clone);

  assert.equal(res.data!.can_update, false);
  assert.match(res.data!.reason, /detached HEAD/i);

  db.close();
});

test('previewUpdate: no upstream tracking branch → refused', () => {
  const root = tmpDir();
  const { origin } = makeOriginAndClone(root);
  // standalone repo with a remote but no tracking branch
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
  const res = previewReadOnly(db, id, repo);

  assert.equal(res.data!.can_update, false);
  assert.match(res.data!.reason, /no upstream tracking branch/i);

  db.close();
});

test('previewUpdate: remote sha object missing locally → cannot verify, never fetches', () => {
  const root = tmpDir();
  const { origin, clone } = makeOriginAndClone(root);
  addCommit(origin, 'g.txt', 'two\n', 'c2'); // NOT fetched into the clone

  const db = testDb();
  const id = toolAt(db, clone);
  const res = previewReadOnly(db, id, clone);

  assert.equal(res.data!.can_update, false);
  assert.match(res.data!.reason, /cannot verify fast-forward without fetching/);
  assert.ok(res.data!.upstream_ref?.startsWith('origin/main@')); // ls-remote still read it
  assert.equal(res.data!.ahead_behind, null);

  db.close();
});

test('previewUpdate: linked worktree → refused', () => {
  const root = tmpDir();
  const { clone } = makeOriginAndClone(root);
  const wt = join(root, 'linked-wt');
  git(['worktree', 'add', '-b', 'wt-branch', wt], clone);

  const db = testDb();
  const id = toolAt(db, wt);
  const res = previewReadOnly(db, id, wt);

  assert.equal(res.data!.can_update, false);
  assert.match(res.data!.reason, /linked worktree/i);

  db.close();
});

// --- plan_trial ---

test('planTrial: README with clean docker run → argv, explanations, loopback port rewrite', () => {
  const root = tmpDir();
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'README.md'),
    '# cool app\n\n## Run with Docker\n\n```bash\ndocker run -d --name myapp -p 8080:80 -e FOO=bar nginx:latest\n```\n',
  );

  const db = testDb();
  const id = toolAt(db, dir);
  const res = planTrial(db, id);

  assert.equal(res.ok, true);
  const plan = res.data!;
  assert.equal(plan.ok_to_run, true);
  assert.equal(plan.image, 'nginx:latest');
  assert.equal(plan.source, 'README.md');
  assert.deepEqual(plan.refusals, []);
  // port rewritten to atomic loopback allocation — never 8080:80, never all interfaces
  const pIdx = plan.argv.indexOf('-p');
  assert.ok(pIdx !== -1);
  assert.equal(plan.argv[pIdx + 1], '127.0.0.1::80');
  assert.ok(!plan.argv.includes('8080:80'));
  // argv starts after 'docker run'
  assert.deepEqual(plan.argv.slice(0, 2), ['-d', '--name']);
  assert.ok(plan.argv.includes('myapp'));
  const eIdx = plan.argv.indexOf('-e');
  assert.equal(plan.argv[eIdx + 1], 'FOO=bar');
  // explanations: one per argv flag, plain English, rewrite noted
  assert.ok(plan.flag_explanations.length >= 5);
  assert.ok(plan.flag_explanations.some(x => x.flag === '-d' && /detached/i.test(x.meaning)));
  assert.ok(plan.flag_explanations.some(x => x.flag.startsWith('-e') && /FOO/.test(x.meaning)));
  assert.ok(plan.flag_explanations.some(x => x.flag.startsWith('-p') && /rewritten from/.test(x.meaning)));

  db.close();
});

test('planTrial: compose with privileged: true → refusal naming --privileged', () => {
  const root = tmpDir();
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'docker-compose.yml'),
    'services:\n  web:\n    image: nginx\n    privileged: true\n',
  );

  const db = testDb();
  const id = toolAt(db, dir);
  const res = planTrial(db, id);

  assert.equal(res.ok, true);
  assert.equal(res.data!.ok_to_run, false);
  assert.ok(res.data!.refusals.some(r => r.includes('--privileged')));

  db.close();
});

test('planTrial: compose mounting /var/run/docker.sock → refusal naming docker.sock', () => {
  const root = tmpDir();
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'docker-compose.yml'),
    'services:\n  web:\n    image: nginx\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
  );

  const db = testDb();
  const id = toolAt(db, dir);
  const res = planTrial(db, id);

  assert.equal(res.data!.ok_to_run, false);
  assert.ok(res.data!.refusals.some(r => r.includes('docker.sock')));

  db.close();
});

test('planTrial: compose with network_mode: host → refusal naming --network=host', () => {
  const root = tmpDir();
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'docker-compose.yml'),
    'services:\n  web:\n    image: nginx\n    network_mode: host\n',
  );

  const db = testDb();
  const id = toolAt(db, dir);
  const res = planTrial(db, id);

  assert.equal(res.data!.ok_to_run, false);
  assert.ok(res.data!.refusals.some(r => r.includes('--network=host')));

  db.close();
});

test('planTrial: compose with build: → refusal, only prebuilt images supported', () => {
  const root = tmpDir();
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  web:\n    build: .\n');

  const db = testDb();
  const id = toolAt(db, dir);
  const res = planTrial(db, id);

  assert.equal(res.data!.ok_to_run, false);
  assert.ok(res.data!.refusals.some(r => /build:/.test(r)));

  db.close();
});

test('planTrial: compose bind mount → refusal, named volumes only', () => {
  const root = tmpDir();
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'docker-compose.yml'),
    'services:\n  web:\n    image: nginx\n    volumes:\n      - ./config:/etc/nginx\n',
  );

  const db = testDb();
  const id = toolAt(db, dir);
  const res = planTrial(db, id);

  assert.equal(res.data!.ok_to_run, false);
  assert.ok(res.data!.refusals.some(r => /bind mounts refused; named volumes only/.test(r)));

  db.close();
});

test('planTrial: no docker instructions anywhere → ok:false', () => {
  const root = tmpDir();
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# just a readme, no docker\n');

  const db = testDb();
  const id = toolAt(db, dir);
  const res = planTrial(db, id);

  assert.equal(res.ok, false);
  assert.match(res.message, /no docker run instructions found/);

  db.close();
});
