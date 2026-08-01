import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb,
  selectTools,
  selectToolView,
  selectInstallations,
  selectComments,
  selectTags,
  insertTool,
  replaceInstallationsForScan,
  updateToolVerdict,
  addUserComment,
} from '../dist/core/db.js';
import {
  runDiscovery,
  parseImportedMarkdown,
  normalizeWingetId,
  parseWingetEntries,
  isSystemWingetEntry,
} from '../dist/core/discovery.js';
import { DEFAULT_SETTINGS, type Settings } from '../dist/core/types.js';

// Tests run against compiled output (tsc -p tsconfig.json first), same as db.test.ts.

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-disc-'));
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

/** Minimal fake git repo: .git/HEAD + .git/config with an optional origin remote. */
function makeRepo(dir: string, remoteUrl: string | null): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const remote = remoteUrl
    ? `[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    : '';
  writeFileSync(join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n${remote}`);
}

function settingsFor(scanDirs: string[], skillsDirs: string[]): Settings {
  return { ...DEFAULT_SETTINGS, scanDirs, skillsDirs };
}

/** Never touch the real machine's npm/winget/docker or IMPORTED.md in tests. */
const SKIP = { npm: true, winget: true, docker: true };
function noSeed(dir: string): string {
  return join(dir, 'IMPORTED.missing.md');
}

// Mirrors the real D:\dev\tools\IMPORTED.md structure (read for reference, never modified).
const IMPORTED_FIXTURE = `# Imported tools — origin trace

Not mine. Origin decides the bucket, not who edited last.

| Item | Upstream | Note |
|---|---|---|
| \`system-prompts/CL4R1T4S\` | https://github.com/elder-plinius/CL4R1T4S | **Deleted 2026-07-31**, link kept. Scraped system-prompt collection. Re-clone if needed. |
| \`openmontage\` | https://github.com/calesthio/OpenMontage | Adopted 2026-07-23. Built on top, still theirs. |
| \`openwhispr-src\` | https://github.com/OpenWhispr/openwhispr | Upstream source. |
| \`openwhispr\` | (sibling build of \`openwhispr-src\`) | No remote read. |
| \`mcp-server-trello\` | https://github.com/delorenj/mcp-server-trello | Used via MCP. |
| \`obscura\` | ? | Binaries only (\`obscura.exe\`, worker, zip). No source, origin unknown. |
`;

test('parseImportedMarkdown parses the real-file structure incl. deleted + url-less entries', () => {
  const entries = parseImportedMarkdown(IMPORTED_FIXTURE);
  assert.equal(entries.length, 6);

  const cl4 = entries.find(e => e.name === 'system-prompts/CL4R1T4S');
  assert.ok(cl4);
  assert.equal(cl4.url, 'https://github.com/elder-plinius/CL4R1T4S');
  assert.equal(cl4.deleted, true);
  assert.ok(cl4.note?.includes('Re-clone if needed'));
  assert.ok(!cl4.note?.includes('**')); // markdown emphasis stripped

  const montage = entries.find(e => e.name === 'openmontage');
  assert.ok(montage);
  assert.equal(montage.url, 'https://github.com/calesthio/OpenMontage');
  assert.equal(montage.deleted, false);

  const sibling = entries.find(e => e.name === 'openwhispr');
  assert.ok(sibling);
  assert.equal(sibling.url, null); // parenthesized note, no URL

  const obscura = entries.find(e => e.name === 'obscura');
  assert.ok(obscura);
  assert.equal(obscura.url, null); // '?' upstream
  assert.equal(obscura.deleted, false);
});

test('reconciliation: SSH repo + HTTPS repo + skill clone of same remote → exactly ONE tool row', () => {
  const root = tmpDir();
  const scanDir = join(root, 'tools');
  const skillsDir = join(root, 'skills');
  makeRepo(join(scanDir, 'repo-ssh'), 'git@github.com:owner/repo.git');
  makeRepo(join(scanDir, 'repo-https'), 'https://github.com/owner/repo.git');
  const skillDir = join(skillsDir, 'my-skill');
  makeRepo(skillDir, 'https://github.com/owner/repo.git');
  writeFileSync(join(skillDir, 'SKILL.md'), '# my-skill\n');

  const db = testDb();
  const report = runDiscovery(db, settingsFor([scanDir], [skillsDir]), {
    skip: SKIP,
    importedPath: noSeed(root),
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.repos, 2);
  assert.equal(report.skills, 1);

  const tools = selectTools(db);
  assert.equal(tools.length, 1);
  const view = selectToolView(db, tools[0].id);
  assert.ok(view);
  // both disk clones + the skills-dir install land on the single row
  assert.equal(view.installations.length, 3);
  assert.ok(view.installations.some(i => i.where_.startsWith('skills-dir:')));
  assert.ok(view.installations.every(i => i.present === 1));
  // the skill identity survives as an alias on the repo row
  assert.ok(view.aliases.includes('skill:my-skill'));
  assert.ok(view.name.length > 0);

  db.close();
});

test('idempotency: 3 runs → same rows, owned fields untouched', () => {
  const root = tmpDir();
  const scanDir = join(root, 'tools');
  makeRepo(join(scanDir, 'cool-tool'), 'https://github.com/owner/cool-tool.git');

  const db = testDb();
  const opts = { skip: SKIP, importedPath: noSeed(root) };
  runDiscovery(db, settingsFor([scanDir], []), opts);
  assert.equal(selectTools(db).length, 1);
  const id = selectTools(db)[0].id;

  // user takes ownership: verdict, why, favorite, a comment
  updateToolVerdict(db, id, 'kept', null);
  db.prepare('UPDATE tools SET why_i_want_it = ?, favorite = 1 WHERE id = ?')
    .run('my reason', id);
  addUserComment(db, id, 'do not let discovery touch this');

  runDiscovery(db, settingsFor([scanDir], []), opts);
  runDiscovery(db, settingsFor([scanDir], []), opts);

  const tools = selectTools(db);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].verdict, 'kept');
  assert.equal(tools[0].why_i_want_it, 'my reason');
  assert.equal(tools[0].favorite, 1);
  const comments = selectComments(db, id);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].kind, 'user');
  const installs = selectInstallations(db, id);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].present, 1);

  db.close();
});

test('deleted-from-disk repo flips present=0 and keeps its row', () => {
  const root = tmpDir();
  const scanDir = join(root, 'tools');
  const repoDir = join(scanDir, 'goner');
  makeRepo(repoDir, 'https://github.com/owner/goner.git');

  const db = testDb();
  const opts = { skip: SKIP, importedPath: noSeed(root) };
  runDiscovery(db, settingsFor([scanDir], []), opts);
  const id = selectTools(db)[0].id;
  assert.equal(selectInstallations(db, id)[0].present, 1);

  rmSync(repoDir, { recursive: true, force: true });
  runDiscovery(db, settingsFor([scanDir], []), opts);

  const tools = selectTools(db);
  assert.equal(tools.length, 1); // row survives
  const installs = selectInstallations(db, id);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].present, 0); // flipped, not deleted

  runDiscovery(db, settingsFor([scanDir], []), opts); // stable on repeat
  assert.equal(selectTools(db).length, 1);
  assert.equal(selectInstallations(db, id)[0].present, 0);

  db.close();
});

test('IMPORTED.md seed: URL entries → rows; deleted entry tracked without installation; events once', () => {
  const root = tmpDir();
  const importedPath = join(root, 'IMPORTED.md');
  writeFileSync(importedPath, IMPORTED_FIXTURE);

  const db = testDb();
  const report = runDiscovery(db, settingsFor([], []), { skip: SKIP, importedPath });
  assert.deepEqual(report.errors, []);
  assert.equal(report.importedSeed, 4); // URL entries only; openwhispr sibling + obscura skipped

  const tools = selectTools(db);
  assert.equal(tools.length, 4);
  assert.ok(tools.every(t => t.kind === 'repo' && t.verdict === 'wanted' && t.source === 'IMPORTED.md'));

  const cl4 = tools.find(t => t.why_i_want_it?.includes('Re-clone if needed'));
  assert.ok(cl4);
  assert.equal(selectInstallations(db, cl4.id).length, 0); // deleted-but-tracked: no installation

  for (const t of tools) {
    const events = selectComments(db, t.id).filter(c => c.kind === 'event');
    assert.equal(events.length, 1);
    assert.ok(events[0].body.includes('seeded from IMPORTED.md'));
  }

  // repeat seed: no new rows, no duplicate events
  const report2 = runDiscovery(db, settingsFor([], []), { skip: SKIP, importedPath });
  assert.equal(report2.importedSeed, 4);
  assert.equal(selectTools(db).length, 4);
  for (const t of selectTools(db)) {
    assert.equal(selectComments(db, t.id).filter(c => c.kind === 'event').length, 1);
  }

  db.close();
});

test('missing IMPORTED.md is skipped silently', () => {
  const root = tmpDir();
  const db = testDb();
  const report = runDiscovery(db, settingsFor([], []), { skip: SKIP, importedPath: noSeed(root) });
  assert.equal(report.importedSeed, 0);
  assert.deepEqual(report.errors, []);
  assert.equal(selectTools(db).length, 0);
  db.close();
});

// --- winget: MSIX reconciliation + system classification ---

test('normalizeWingetId strips MSIX prefix + version/arch/publisher-hash suffix', () => {
  assert.equal(
    normalizeWingetId('MSIX\\ZedIndustries.Zed_1.0.0.0_x64__8wekyb3d8bbwe'),
    'ZedIndustries.Zed',
  );
  assert.equal(
    normalizeWingetId('MSIX\\Microsoft.MicrosoftEdge_44.17763.1.0_neutral__8wekyb3d8bbwe'),
    'Microsoft.MicrosoftEdge',
  );
  assert.equal(normalizeWingetId('MSIX\\Foo.Bar_x64__abc123'), 'Foo.Bar'); // arch-only suffix
  assert.equal(normalizeWingetId('MSIX\\Foo.Bar'), 'Foo.Bar'); // no suffix at all
  assert.equal(normalizeWingetId('ZedIndustries.Zed'), 'ZedIndustries.Zed'); // classic: untouched
});

test('isSystemWingetEntry: OS/vendor prefixes system, dev tools + consumer apps not', () => {
  assert.equal(isSystemWingetEntry('Microsoft.AV1VideoExtension', 'Microsoft.AV1VideoExtension'), true);
  assert.equal(isSystemWingetEntry('MSIX\\Microsoft.MicrosoftEdge_1.0_neutral__abc', 'Microsoft.MicrosoftEdge'), true);
  assert.equal(isSystemWingetEntry('Intel.Chipset', 'Intel.Chipset'), true);
  assert.equal(isSystemWingetEntry('NVIDIA.GeForceExperience', 'NVIDIA.GeForceExperience'), true);
  assert.equal(isSystemWingetEntry('Realtek.Audio', 'Realtek.Audio'), true);
  assert.equal(isSystemWingetEntry('Dolby.Atmos', 'Dolby.Atmos'), true);
  assert.equal(isSystemWingetEntry('Apple.iTunes', 'Apple.iTunes'), true);
  assert.equal(isSystemWingetEntry('Google.Chrome', 'Google.Chrome'), true);
  // dev-tool exceptions under Microsoft.* — checked before the vendor prefix
  assert.equal(isSystemWingetEntry('Microsoft.VisualStudioCode', 'Microsoft.VisualStudioCode'), false);
  assert.equal(isSystemWingetEntry('Microsoft.PowerToys', 'Microsoft.PowerToys'), false);
  assert.equal(isSystemWingetEntry('Microsoft.WindowsTerminal', 'Microsoft.WindowsTerminal'), false);
  assert.equal(isSystemWingetEntry('Microsoft.Git', 'Microsoft.Git'), false);
  assert.equal(isSystemWingetEntry('Microsoft.DotNet.SDK.8', 'Microsoft.DotNet.SDK.8'), false);
  // consumer apps stay untagged — plausibly acquired tools, not OS noise
  assert.equal(isSystemWingetEntry('Discord.Discord', 'Discord.Discord'), false);
  assert.equal(isSystemWingetEntry('Brave.Brave', 'Brave.Brave'), false);
  assert.equal(isSystemWingetEntry('ZedIndustries.Zed', 'ZedIndustries.Zed'), false);
});

// MSIX line deliberately BEFORE the classic line: proves collapse picks the
// classic entry's version/classification regardless of listing order.
const WINGET_FIXTURE = `Name                                        Id                                                   Version
------------------------------------------------------------------------------------------------------------------------------
Zed                                         MSIX\\ZedIndustries.Zed_1.0.0.0_x64__8wekyb3d8bbwe   1.0.0.0
Zed                                         ZedIndustries.Zed                                    1.0.0
AV1 Video Extension                         Microsoft.AV1VideoExtension                          1.1.0.0
Visual Studio Code                          Microsoft.VisualStudioCode                           1.95.0
Edge                                        MSIX\\Microsoft.MicrosoftEdge_44.1.0.0_neutral__8wekyb3d8bbwe   44.1
Discord                                     Discord.Discord                                      1.0.9000
`;

test('parseWingetEntries parses the table and normalizes MSIX ids', () => {
  const entries = parseWingetEntries(WINGET_FIXTURE);
  assert.equal(entries.length, 6);
  const msixZed = entries.find(e => e.rawId.startsWith('MSIX\\Zed'));
  assert.ok(msixZed);
  assert.equal(msixZed.id, 'ZedIndustries.Zed');
  assert.equal(msixZed.system, true); // raw per-entry: MSIX-derived → system...
  // ...but the scanner collapses onto the classic entry, whose classification
  // wins — see the collapse test below (Zed row ends up untagged).
  const edge = entries.find(e => e.rawId.startsWith('MSIX\\Microsoft.MicrosoftEdge'));
  assert.ok(edge);
  assert.equal(edge.id, 'Microsoft.MicrosoftEdge');
  assert.equal(edge.system, true); // MSIX-derived → OS component
});

test('winget MSIX dupe + classic entry collapse to exactly ONE row (classic version wins)', () => {
  const root = tmpDir();
  const db = testDb();
  const opts = {
    skip: { npm: true, docker: true }, // winget runs on the fixture, not the machine
    wingetListFixture: WINGET_FIXTURE,
    importedPath: noSeed(root),
  };
  const report = runDiscovery(db, settingsFor([], []), opts);
  assert.deepEqual(report.errors, []);

  const tools = selectTools(db);
  assert.equal(tools.length, 5); // Zed(1) + AV1 + VSCode + Edge + Discord

  const zed = tools.find(t => t.canonical_key === 'winget:ZedIndustries.Zed');
  assert.ok(zed, 'collapsed row keyed by the classic id');
  const view = selectToolView(db, zed.id);
  assert.ok(view);
  assert.ok(view.aliases.includes('winget:MSIX\\ZedIndustries.Zed_1.0.0.0_x64__8wekyb3d8bbwe'));
  const wingetInstalls = view.installations.filter(i => i.where_ === 'winget');
  assert.equal(wingetInstalls.length, 1); // one installation, not two
  assert.equal(wingetInstalls[0].version_local, '1.0.0'); // classic version preferred over MSIX 1.0.0.0
  assert.equal(wingetInstalls[0].present, 1);

  // system tags: OS/vendor components tagged, dev tools + consumer apps not
  const hasSystem = (key: string): boolean => {
    const t = tools.find(x => x.canonical_key === key);
    assert.ok(t, `${key} exists`);
    return selectTags(db, t.id).some(tag => tag.tag === 'system' && tag.detected === 1);
  };
  assert.equal(hasSystem('winget:Microsoft.AV1VideoExtension'), true);
  assert.equal(hasSystem('winget:Microsoft.MicrosoftEdge'), true);
  assert.equal(hasSystem('winget:Microsoft.VisualStudioCode'), false);
  assert.equal(hasSystem('winget:Discord.Discord'), false);
  assert.equal(hasSystem('winget:ZedIndustries.Zed'), false);

  // idempotent: second run, same rows, no duplicate installs/tags
  const report2 = runDiscovery(db, settingsFor([], []), opts);
  assert.deepEqual(report2.errors, []);
  assert.equal(selectTools(db).length, 5);
  assert.equal(
    selectInstallations(db, zed.id).filter(i => i.where_ === 'winget').length,
    1,
  );

  db.close();
});

test('legacy MSIX-keyed dupe row merges into the existing classic row', () => {
  const root = tmpDir();
  const db = testDb();
  // Simulate the Phase-1 bug state: both rows already exist separately.
  const classic = insertTool(db, {
    canonical_key: 'winget:ZedIndustries.Zed',
    name: 'Zed',
    kind: 'global-cli',
    source: 'winget',
  });
  replaceInstallationsForScan(db, classic.id, 'winget', [{ where_: 'winget', version_local: '1.0.0' }]);
  const dupe = insertTool(db, {
    canonical_key: 'winget:MSIX\\ZedIndustries.Zed_1.0.0.0_x64__8wekyb3d8bbwe',
    name: 'Zed',
    kind: 'global-cli',
    source: 'winget',
  });
  replaceInstallationsForScan(db, dupe.id, 'winget', [{ where_: 'winget', version_local: '1.0.0.0' }]);
  assert.equal(selectTools(db).length, 2);

  const report = runDiscovery(db, settingsFor([], []), { skip: SKIP, importedPath: noSeed(root) });
  assert.deepEqual(report.errors, []);

  const tools = selectTools(db);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, classic.id);
  assert.equal(tools[0].canonical_key, 'winget:ZedIndustries.Zed');

  const view = selectToolView(db, classic.id);
  assert.ok(view);
  // dupe's clashing winget installation dropped; the classic version survives
  const wingetInstalls = view.installations.filter(i => i.where_ === 'winget');
  assert.equal(wingetInstalls.length, 1);
  assert.equal(wingetInstalls[0].version_local, '1.0.0');
  // raw MSIX key remains findable as an alias
  assert.ok(view.aliases.includes('winget:MSIX\\ZedIndustries.Zed_1.0.0.0_x64__8wekyb3d8bbwe'));
  // merge journaled on the survivor
  const events = selectComments(db, classic.id).filter(c => c.kind === 'event');
  assert.ok(events.some(c => c.body.includes('merged MSIX duplicate')));

  // stable on repeat: no second merge, no extra event
  const report2 = runDiscovery(db, settingsFor([], []), { skip: SKIP, importedPath: noSeed(root) });
  assert.deepEqual(report2.errors, []);
  assert.equal(selectTools(db).length, 1);
  assert.equal(
    selectComments(db, classic.id).filter(c => c.body.includes('merged MSIX duplicate')).length,
    1,
  );

  db.close();
});
