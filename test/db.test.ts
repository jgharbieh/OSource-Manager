import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  withTransaction,
  insertTool,
  selectTool,
  selectToolByCanonicalKey,
  selectToolView,
  addEvent,
  addUserComment,
  selectComments,
  addAlias,
  findToolByAlias,
  upsertTag,
  deleteTag,
  selectTags,
  replaceInstallationsForScan,
  selectInstallations,
  upsertObservations,
  beginTrial,
  endTrial,
  latestTrial,
  touchUpdatedAt,
  updateToolVerdict,
} from '../dist/core/db.js';

// Tests run against compiled output: `npm run build` (or `npx tsc -p tsconfig.json`) first.
// Node 24 --experimental-strip-types cannot remap the `.js` import specifiers used in
// src/*.ts, so the .ts sources cannot be imported directly.

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-test-'));
  tmpDirs.push(dir);
  return join(dir, 'osm.db');
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test('openDb creates schema; insert + selectToolView round-trip', () => {
  const db = openDb(tmpDbPath());

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all().map(r => r.name as string);
  for (const t of ['tools', 'aliases', 'installations', 'observations', 'tags', 'comments', 'trials']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }

  const tool = insertTool(db, {
    canonical_key: 'gh-cli',
    name: 'GitHub CLI',
    kind: 'global-cli',
    verdict: 'trying',
    why_i_want_it: 'PR workflow',
    source: 'winget',
  });
  assert.ok(tool.id > 0);
  assert.equal(tool.favorite, 0);

  addAlias(db, tool.id, 'gh');
  addAlias(db, tool.id, 'gh'); // conflict ignored
  upsertTag(db, tool.id, 'cli', 1);
  upsertTag(db, tool.id, 'github', 0);
  replaceInstallationsForScan(db, tool.id, 'winget', [{ where_: 'winget', version_local: '2.62.0' }]);
  upsertObservations(db, tool.id, { version_upstream: '2.63.0', update_available: 1 });

  const view = selectToolView(db, tool.id);
  assert.ok(view);
  assert.equal(view.canonical_key, 'gh-cli');
  assert.equal(view.kind, 'global-cli');
  assert.equal(view.verdict, 'trying');
  assert.equal(view.why_i_want_it, 'PR workflow');
  assert.deepEqual(view.aliases, ['gh']);
  assert.equal(view.installations.length, 1);
  assert.equal(view.installations[0].where_, 'winget');
  assert.equal(view.installations[0].version_local, '2.62.0');
  assert.equal(view.installations[0].present, 1);
  assert.ok(view.observations);
  assert.equal(view.observations.version_upstream, '2.63.0');
  assert.equal(view.observations.update_available, 1);
  assert.equal(view.tags.length, 2);
  assert.equal(view.tags.find(t => t.tag === 'github')?.detected, 0);

  // direct selectors agree
  assert.equal(selectTool(db, tool.id)?.canonical_key, 'gh-cli');
  assert.equal(selectToolByCanonicalKey(db, 'gh-cli')?.id, tool.id);
  assert.equal(findToolByAlias(db, 'gh')?.id, tool.id);

  db.close();
});

test('withTransaction rolls back on throw (mutation + event both absent)', () => {
  const db = openDb(tmpDbPath());
  const tool = insertTool(db, { canonical_key: 'ripgrep', name: 'ripgrep', kind: 'binary' });

  assert.throws(() =>
    withTransaction(db, () => {
      upsertTag(db, tool.id, 'search', 1);
      addEvent(db, tool.id, 'tagged search');
      throw new Error('boom');
    }),
  );

  assert.equal(selectTags(db, tool.id).length, 0);
  assert.equal(selectComments(db, tool.id).length, 0);

  // and a committed transaction lands both
  withTransaction(db, () => {
    upsertTag(db, tool.id, 'search', 1);
    addEvent(db, tool.id, 'tagged search');
  });
  assert.equal(selectTags(db, tool.id).length, 1);
  const comments = selectComments(db, tool.id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].kind, 'event');

  db.close();
});

test('two concurrent connections: interleaved writes, no SQLITE_BUSY', () => {
  const dbPath = tmpDbPath();
  const a = openDb(dbPath);
  const b = openDb(dbPath);

  const toolA = insertTool(a, { canonical_key: 'tool-a', name: 'A', kind: 'repo' });
  const toolB = insertTool(b, { canonical_key: 'tool-b', name: 'B', kind: 'repo' });

  for (let i = 0; i < 20; i++) {
    a.prepare('INSERT INTO comments (tool_id, kind, body, created_at) VALUES (?, ?, ?, ?)')
      .run(toolA.id, 'event', `a-${i}`, `2026-01-01 00:00:${String(i).padStart(2, '0')}`);
    b.prepare('INSERT INTO comments (tool_id, kind, body, created_at) VALUES (?, ?, ?, ?)')
      .run(toolB.id, 'event', `b-${i}`, `2026-01-01 00:01:${String(i).padStart(2, '0')}`);
  }

  assert.equal(selectComments(a, toolA.id).length, 20);
  assert.equal(selectComments(a, toolB.id).length, 20); // visible across connections (WAL)
  assert.equal(selectComments(b, toolA.id).length, 20);

  a.close();
  b.close();
});

test('replaceInstallationsForScan: un-seen row gets present=0, survives, last_seen_at preserved', () => {
  const db = openDb(tmpDbPath());
  const tool = insertTool(db, { canonical_key: 'fzf', name: 'fzf', kind: 'global-cli' });

  replaceInstallationsForScan(db, tool.id, 'disk', [
    { where_: 'D:\\dev\\tools\\fzf', version_local: '0.55.0' },
    { where_: 'D:\\dev\\personal\\fzf-fork', version_local: null },
  ]);
  const before = selectInstallations(db, tool.id);
  assert.equal(before.length, 2);
  const kept = before.find(i => i.where_ === 'D:\\dev\\personal\\fzf-fork');
  assert.ok(kept);
  assert.equal(kept.present, 1);
  const keptLastSeen = kept.last_seen_at;

  // second scan sees only the first path
  replaceInstallationsForScan(db, tool.id, 'disk', [
    { where_: 'D:\\dev\\tools\\fzf', version_local: '0.56.0' },
  ]);
  const afterRows = selectInstallations(db, tool.id);
  assert.equal(afterRows.length, 2); // un-seen row survives
  const missing = afterRows.find(i => i.where_ === 'D:\\dev\\personal\\fzf-fork');
  assert.ok(missing);
  assert.equal(missing.present, 0);
  assert.equal(missing.last_seen_at, keptLastSeen); // preserved
  const seen = afterRows.find(i => i.where_ === 'D:\\dev\\tools\\fzf');
  assert.ok(seen);
  assert.equal(seen.present, 1);
  assert.equal(seen.version_local, '0.56.0'); // upserted

  // disk scans do not clobber named-source rows
  replaceInstallationsForScan(db, tool.id, 'npm-g', [{ where_: 'npm-g', version_local: '0.56.0' }]);
  replaceInstallationsForScan(db, tool.id, 'disk', []);
  const rows = selectInstallations(db, tool.id);
  assert.equal(rows.find(i => i.where_ === 'npm-g')?.present, 1);
  assert.equal(rows.filter(i => i.present === 0).length, 2);

  db.close();
});

test('verdict update, comments, trials, touchUpdatedAt', () => {
  const db = openDb(tmpDbPath());
  const tool = insertTool(db, { canonical_key: 'ollama', name: 'Ollama', kind: 'global-cli' });

  const c = addUserComment(db, tool.id, 'worth keeping around');
  assert.equal(c.kind, 'user');
  assert.ok(c.id > 0);

  const trialId = beginTrial(db, tool.id, {
    trial_uid: 'trial-1',
    container: 'osm-ollama-1',
    image: 'ollama/ollama:latest',
    ports: '11434:11434',
    volumes_created_by_osm: ['osm-ollama-data'],
  });
  assert.ok(trialId > 0);
  let trial = latestTrial(db, tool.id);
  assert.ok(trial);
  assert.equal(trial.trial_uid, 'trial-1');
  assert.equal(trial.ended_at, null);
  assert.equal(JSON.parse(trial.volumes_created_by_osm)[0], 'osm-ollama-data');
  endTrial(db, trialId, 'kept');
  trial = latestTrial(db, tool.id);
  assert.equal(trial?.outcome, 'kept');
  assert.ok(trial?.ended_at);

  deleteTag(db, tool.id, 'nonexistent'); // no-op

  const before = selectTool(db, tool.id);
  updateToolVerdict(db, tool.id, 'retired', 'superseded by native tools');
  const after_ = selectTool(db, tool.id);
  assert.equal(after_?.verdict, 'retired');
  assert.equal(after_?.retire_reason, 'superseded by native tools');
  assert.ok(after_ && before && after_.updated_at >= before.updated_at);

  touchUpdatedAt(db, tool.id);

  db.close();
});
