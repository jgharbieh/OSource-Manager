import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  insertTool,
  now,
  addUserComment,
  selectComments,
  selectTool,
  upsertTag,
} from '../dist/core/db.js';
import { planTrial } from '../dist/core/preview.js';
import { getReadme } from '../dist/core/readme.js';
import { mergeToolsOp } from '../dist/core/ops.js';
import { renderMarkdown, frontmatterHtml, splitFrontmatter } from '../dist/core/markdown.js';

// Local markdown rendering, row-merge (one repo that ships a CLI *and* a skill),
// and plan_trial refusals that explain themselves.

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-id-'));
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

function toolAt(db: ReturnType<typeof openDb>, dir: string, key = `local:${Math.random().toString(36).slice(2, 10)}`): number {
  const tool = insertTool(db, { canonical_key: key, name: 'fixture', kind: 'repo' });
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, NULL, 1, ?)',
  ).run(tool.id, dir, now());
  return tool.id;
}

/* ---------------- markdown ---------------- */

test('splitFrontmatter: quoted values keep their colons, quotes are syntax', () => {
  const { frontmatter, body } = splitFrontmatter(
    '---\nname: agent-browser\ndescription: "Browser automation CLI. DEFAULT MODE: connects"\n---\n\n# Title\n',
  );
  assert.deepEqual(frontmatter, [
    ['name', 'agent-browser'],
    ['description', 'Browser automation CLI. DEFAULT MODE: connects'],
  ]);
  assert.match(body, /^\s*# Title/);
  assert.match(frontmatterHtml(frontmatter), /<dt>name<\/dt><dd>agent-browser<\/dd>/);
});

test('renderMarkdown: headings, lists, tables, code, inline spans, task boxes', () => {
  const md = [
    '## Install',
    '',
    '- one **bold**',
    '- two `code`',
    '',
    '1. first',
    '2. second',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```bash',
    'npm i -g thing',
    '```',
    '',
    '> quoted',
    '',
    '***',
    '',
    'See [docs](https://example.com/d) and ~~old~~ text.',
    '',
    '- [ ] todo',
    '- [x] done',
  ].join('\n');
  const { html } = renderMarkdown(md);

  assert.match(html, /<h2>Install<\/h2>/);
  assert.match(html, /<li>one <strong>bold<\/strong><\/li>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
  assert.match(html, /<pre data-lang="bash"><code>npm i -g thing<\/code><\/pre>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<a href="https:\/\/example\.com\/d"[^>]*>docs<\/a>/);
  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /<input type="checkbox" disabled> todo/);
  assert.match(html, /<input type="checkbox" disabled checked> done/);
});

test('renderMarkdown: source HTML is escaped, never passed through', () => {
  const { html } = renderMarkdown('Hi <script>steal()</script> and <img src=x onerror=y>\n');
  // The bytes may still say "onerror" — what matters is that no TAG survives, so
  // the browser renders it as the text it is.
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=y&gt;/);
});

test('renderMarkdown: fenced code is never parsed as markup', () => {
  const { html } = renderMarkdown('```\n# not a heading\n- not a list\n**not bold**\n```\n');
  assert.match(html, /<pre><code># not a heading/);
  assert.doesNotMatch(html, /<h1>/);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<li>/);
});

test('renderMarkdown: only http/mailto/anchor links survive', () => {
  const { html } = renderMarkdown('[a](javascript:alert(1)) then [b](https://ok.example)\n');
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<a href="https:\/\/ok\.example"/);
});

test('getReadme: a local SKILL.md comes back as rendered HTML with its frontmatter', async () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: thing\ndescription: does things\n---\n\n# Thing\n\n- a\n- b\n');
  const db = testDb();
  const id = toolAt(db, dir, 'skill:thing');

  const res = await getReadme(db, id);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data!.format, 'html');
  assert.match(res.data!.source, /SKILL\.md$/);
  assert.match(res.data!.body, /md-fm/);
  assert.match(res.data!.body, /<h1>Thing<\/h1>/);
  assert.match(res.data!.body, /<li>a<\/li>/);
  db.close();
});

/* ---------------- merge ---------------- */

test('mergeToolsOp: one repo shipping a CLI and a skill collapses to one row', () => {
  const db = testDb();
  const repo = insertTool(db, {
    canonical_key: 'github.com/vercel-labs/agent-browser',
    name: 'agent-browser',
    kind: 'repo',
    why_i_want_it: 'browser control for agents',
  });
  const skill = insertTool(db, {
    canonical_key: 'skill:agent-browser',
    name: 'agent-browser',
    kind: 'skill',
    source: 'skills-dir',
  });
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, ?, 1, ?)',
  ).run(skill.id, 'skills-dir:D:\\dev\\personal\\claude-code\\skills\\agent-browser', 'local', now());
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, ?, 1, ?)',
  ).run(repo.id, 'npm-g', '0.4.0', now());
  upsertTag(db, skill.id, 'skill', 1);
  addUserComment(db, skill.id, 'the skill half is what Claude loads');
  db.prepare('UPDATE tools SET favorite = 1 WHERE id = ?').run(skill.id);

  const res = mergeToolsOp(db, skill.id, repo.id);
  assert.equal(res.ok, true, res.message);

  assert.equal(selectTool(db, skill.id), undefined, 'the duplicate row is gone');
  const merged = res.data!;
  assert.equal(merged.canonical_key, 'github.com/vercel-labs/agent-browser');
  assert.equal(merged.installations.length, 2, 'both installations under one row');
  assert.ok(merged.installations.some(i => i.where_ === 'npm-g'));
  assert.ok(merged.installations.some(i => i.where_.startsWith('skills-dir:')));
  assert.ok(merged.tags.some(t => t.tag === 'skill'), 'tags moved');
  assert.ok(merged.aliases.includes('skill:agent-browser'), 'old key stays findable');
  assert.equal(merged.favorite, 1, 'a favorite is never lost in a merge');
  assert.equal(merged.why_i_want_it, 'browser control for agents', 'target keeps its own why');

  const journal = selectComments(db, repo.id).map(c => c.body);
  assert.ok(journal.some(b => /the skill half is what Claude loads/.test(b)), 'comments moved');
  assert.ok(journal.some(b => /merged "agent-browser" \(#\d+, skill:agent-browser\)/.test(b)));
  db.close();
});

test('mergeToolsOp: refuses itself and unknown ids; adopts a why only when absent', () => {
  const db = testDb();
  const a = insertTool(db, { canonical_key: 'github.com/x/a', name: 'a', kind: 'repo' });
  const b = insertTool(db, {
    canonical_key: 'skill:a',
    name: 'a-skill',
    kind: 'skill',
    why_i_want_it: 'the only why on either row',
  });

  assert.equal(mergeToolsOp(db, a.id, a.id).ok, false);
  assert.equal(mergeToolsOp(db, 9999, a.id).ok, false);
  assert.equal(mergeToolsOp(db, a.id, 9999).ok, false);

  const res = mergeToolsOp(db, b.id, a.id);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.data!.why_i_want_it, 'the only why on either row');
  db.close();
});

/* ---------------- refusals that explain themselves ---------------- */

test('planTrial: an Electron app is told WHY docker is not how it runs', () => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'legion-warden', devDependencies: { 'electron-vite': '^2.0.0' } }),
  );
  const db = testDb();
  const id = toolAt(db, dir);

  const res = planTrial(db, id);
  assert.equal(res.ok, false);
  assert.match(res.message, /ships no container recipe/);
  assert.match(res.message, /Electron desktop app/);
  assert.match(res.message, /never invents a command/);
  db.close();
});

test('planTrial: nothing checked out points at Clone into container', () => {
  const db = testDb();
  const t = insertTool(db, { canonical_key: 'github.com/x/nothing', name: 'nothing', kind: 'repo' });
  const res = planTrial(db, t.id);
  assert.equal(res.ok, false);
  assert.match(res.message, /not checked out on this machine/);
  assert.match(res.message, /Clone into container/);
  db.close();
});
