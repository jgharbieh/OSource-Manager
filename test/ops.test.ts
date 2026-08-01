import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Db,
  type DbStatement,
  openDb,
  selectComments,
  selectTool,
  replaceInstallationsForScan,
  upsertObservations,
} from '../dist/core/db.js';
import {
  searchTools,
  listTools,
  getTool,
  trackTool,
  commentOnTool,
  retireTool,
  setFavorite,
  setAutoUpdate,
  addToolTag,
  removeToolTag,
} from '../dist/core/ops.js';

// Tests run against compiled output: `npm run test:core` compiles first.

const tmpDirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-ops-test-'));
  tmpDirs.push(dir);
  return join(dir, 'osm.db');
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test('ops round-trip: track → search → comment → retire, journal interleaved', () => {
  const db = openDb(tmpDbPath());

  const tracked = trackTool(db, {
    url: 'https://github.com/BurntSushi/ripgrep',
    why: 'fast search for large trees',
  });
  assert.ok(tracked.ok, tracked.message);
  const tool = tracked.data!;
  assert.ok(tool.id > 0);
  assert.equal(tool.verdict, 'wanted');
  assert.equal(tool.kind, 'repo');
  assert.equal(tool.why_i_want_it, 'fast search for large trees');

  // search by text across name/canonical_key/aliases, case-insensitive
  const byText = searchTools(db, { text: 'RIPGREP' });
  assert.ok(byText.ok);
  assert.equal(byText.data!.length, 1);
  const byVerdict = searchTools(db, { verdict: 'wanted' });
  assert.equal(byVerdict.data!.length, 1);
  const byMiss = searchTools(db, { text: 'nonexistent-xyz' });
  assert.equal(byMiss.data!.length, 0);

  // comment
  const empty = commentOnTool(db, tool.id, '   ');
  assert.equal(empty.ok, false);
  const c = commentOnTool(db, tool.id, 'tried it on the monorepo, instant');
  assert.ok(c.ok, c.message);
  assert.equal(c.data!.kind, 'user');

  // favorite + auto_update + tags
  const fav = setFavorite(db, tool.id, true);
  assert.ok(fav.ok);
  assert.equal(fav.data!.favorite, 1);
  const au = setAutoUpdate(db, tool.id, true);
  assert.ok(au.ok);
  assert.equal(au.data!.auto_update, 1);
  const tagged = addToolTag(db, tool.id, 'search');
  assert.ok(tagged.ok);
  assert.deepEqual(
    tagged.data!.tags.find(t => t.tag === 'search'),
    { tool_id: tool.id, tag: 'search', detected: 0 }, // user-added
  );
  const byTag = searchTools(db, { tag: 'SEARCH' });
  assert.equal(byTag.data!.length, 1);
  const untagged = removeToolTag(db, tool.id, 'search');
  assert.ok(untagged.ok);
  assert.equal(untagged.data!.tags.length, 0);

  // retire
  const retired = retireTool(db, tool.id, 'superseded by built-in grep -P');
  assert.ok(retired.ok, retired.message);
  assert.equal(retired.data!.verdict, 'retired');
  assert.equal(retired.data!.retire_reason, 'superseded by built-in grep -P');

  // journal: user comment from why, event 'tracked', user comment, event
  // 'favorited', event 'retired: ...' — ordered newest first.
  const full = getTool(db, tool.id);
  assert.ok(full.ok);
  const bodies = full.data!.comments.map(cm => `${cm.kind}:${cm.body}`);
  assert.deepEqual(bodies, [
    'event:retired: superseded by built-in grep -P',
    'event:favorited',
    'user:tried it on the monorepo, instant',
    'event:tracked',
    'user:fast search for large trees',
  ]);
  // no journal noise for tags / auto_update
  assert.equal(full.data!.comments.filter(cm => cm.body.includes('tag')).length, 0);
  assert.equal(full.data!.comments.filter(cm => cm.body.includes('auto_update')).length, 0);

  // row still exists after retire — never deleted
  assert.ok(selectTool(db, tool.id));
  assert.equal(listTools(db).data!.length, 1);
  assert.equal(searchTools(db, { verdict: 'retired' }).data!.length, 1);
  assert.equal(searchTools(db, { verdict: 'wanted' }).data!.length, 0);

  db.close();
});

test('trackTool merges same repo via SSH then HTTPS — one row, aliases unioned', () => {
  const db = openDb(tmpDbPath());

  const first = trackTool(db, { url: 'git@github.com:BurntSushi/ripgrep.git', why: 'v1' });
  assert.ok(first.ok, first.message);
  const second = trackTool(db, { url: 'https://github.com/BurntSushi/ripgrep', why: 'v2' });
  assert.ok(second.ok, second.message);

  assert.equal(second.data!.id, first.data!.id); // merged, not duplicated
  assert.match(second.message, /merged/);
  assert.equal(listTools(db).data!.length, 1);

  const view = getTool(db, first.data!.id).data!.tool;
  assert.equal(view.why_i_want_it, 'v2'); // merge updates owned field (user action)
  const events = selectComments(db, view.id).filter(c => c.kind === 'event').map(c => c.body);
  assert.deepEqual(events, ['tracked (merged)', 'tracked']); // newest first

  db.close();
});

test('trackTool: name-based keys (npm vs local), url-or-name required', () => {
  const db = openDb(tmpDbPath());

  assert.equal(trackTool(db, {}).ok, false);

  const npmTool = trackTool(db, { name: 'typescript' });
  assert.ok(npmTool.ok, npmTool.message);
  assert.equal(npmTool.data!.canonical_key, 'npm:typescript');
  assert.equal(npmTool.data!.kind, 'global-cli');

  const scoped = trackTool(db, { name: '@modelcontextprotocol/sdk' });
  assert.ok(scoped.ok, scoped.message);
  assert.match(scoped.data!.canonical_key, /^npm:/);

  const local = trackTool(db, { name: 'D:\\dev\\tools\\fzf' });
  assert.ok(local.ok, local.message);
  assert.match(local.data!.canonical_key, /^local:/);
  assert.equal(local.data!.kind, 'binary');

  // tracking the same npm name again merges
  const again = trackTool(db, { name: 'typescript' });
  assert.ok(again.ok);
  assert.equal(again.data!.id, npmTool.data!.id);
  assert.equal(listTools(db).data!.length, 3);

  db.close();
});

test('retireTool: reason required; double-retire fails', () => {
  const db = openDb(tmpDbPath());
  const t = trackTool(db, { name: 'ripgrep' }).data!;

  const noReason = retireTool(db, t.id, '  ');
  assert.equal(noReason.ok, false);
  assert.match(noReason.message, /reason required/);
  assert.equal(selectTool(db, t.id)!.verdict, 'wanted');

  assert.ok(retireTool(db, t.id, 'done with it').ok);
  const again = retireTool(db, t.id, 'really done');
  assert.equal(again.ok, false);
  assert.match(again.message, /already retired/);
  // original reason survives the rejected second retire
  assert.equal(selectTool(db, t.id)!.retire_reason, 'done with it');

  db.close();
});

test('transaction atomicity: failure mid-retire leaves no partial state, no orphan event', () => {
  const real = openDb(tmpDbPath());
  const t = trackTool(real, { name: 'ripgrep' }).data!;
  selectComments(real, t.id); // warm-up not needed, but keep interface honest

  // Db wrapper that blows up on the journal INSERT (after the UPDATE ran).
  const saboteur: Db = {
    exec: sql => real.exec(sql),
    prepare(sql: string): DbStatement {
      if (sql.startsWith('INSERT INTO comments')) {
        return {
          get: () => undefined,
          all: () => [],
          run: () => {
            throw new Error('simulated journal failure');
          },
        };
      }
      return real.prepare(sql);
    },
  };

  const result = retireTool(saboteur, t.id, 'should not stick');
  assert.equal(result.ok, false);
  assert.match(result.message, /simulated journal failure/);

  // verdict unchanged AND no orphan event — both rolled back together
  assert.equal(selectTool(real, t.id)!.verdict, 'wanted');
  assert.equal(selectTool(real, t.id)!.retire_reason, null);
  assert.equal(
    selectComments(real, t.id).filter(c => c.body.startsWith('retired:')).length,
    0,
  );

  real.close();
});

test('searchTools: noEvidenceOfUse and hasUpdate filters', () => {
  const db = openDb(tmpDbPath());

  const a = trackTool(db, { name: 'tool-a' }).data!; // installed, silent → no evidence
  const b = trackTool(db, { name: 'tool-b' }).data!; // installed, has comment
  const c = trackTool(db, { name: 'tool-c' }).data!; // not installed

  replaceInstallationsForScan(db, a.id, 'npm-g', [{ where_: 'npm-g', version_local: '1.0.0' }]);
  replaceInstallationsForScan(db, b.id, 'npm-g', [{ where_: 'npm-g', version_local: '1.0.0' }]);
  commentOnTool(db, b.id, 'used it once');
  // tool-c: no installation at all

  const noEvidence = searchTools(db, { noEvidenceOfUse: true });
  assert.ok(noEvidence.ok);
  assert.deepEqual(noEvidence.data!.map(v => v.id), [a.id]);

  upsertObservations(db, a.id, { version_upstream: '2.0.0', update_available: 1 });
  const updates = searchTools(db, { hasUpdate: true });
  assert.deepEqual(updates.data!.map(v => v.id), [a.id]);

  // filters compose (AND)
  assert.equal(searchTools(db, { noEvidenceOfUse: true, hasUpdate: true }).data!.length, 1);
  assert.equal(
    searchTools(db, { noEvidenceOfUse: true, hasUpdate: true, verdict: 'retired' }).data!.length,
    0,
  );

  db.close();
});
