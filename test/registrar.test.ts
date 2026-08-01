import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertTool, selectComments } from '../dist/core/db.js';
import {
  ALL_TARGETS,
  deriveServerSpec,
  detectTargets,
  registerMcp,
  resolveCommand,
  serverNameFor,
  servingCount,
  servingDetail,
  unifiedDiff,
  unregisterMcp,
  type McpServerSpec,
  type RegisterOpts,
} from '../dist/core/registrar.js';

// Tests run against compiled output (`npx tsc -p tsconfig.json` first), same as
// the other suites here.
//
// SAFETY: every test that touches an agent runs against an ISOLATED temp HOME.
// opts.env overrides USERPROFILE / HOME / CODEX_HOME, which the registrar uses
// both for the spawned CLI and for resolving config + backup paths, so the real
// ~/.claude.json, ~/.codex/config.toml and ~/.osource are never opened for write.
// process.env is never mutated.

const WIN = process.platform === 'win32';
const CLAUDE = resolveCommand('claude');
const CODEX = resolveCommand('codex');
const noClaude = CLAUDE === null ? 'claude CLI not installed' : false;
const noCodex = CODEX === null ? 'codex CLI not installed' : false;
const T = { timeout: 180_000 };

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];

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

interface Sandbox {
  home: string;
  env: Record<string, string>;
  db: ReturnType<typeof openDb>;
  toolId: number;
  claudeConfig: string;
  codexConfig: string;
  backupsDir: string;
}

function sandbox(name: string): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'osm-reg-'));
  tmpDirs.push(home);
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  const db = openDb(join(home, 'osm.db'));
  openDbs.push(db);
  const tool = insertTool(db, {
    canonical_key: `github.com/osm-test/${name}`,
    name,
    kind: 'repo',
    verdict: 'kept',
  });
  return {
    home,
    env: { USERPROFILE: home, HOME: home, CODEX_HOME: codexHome },
    db,
    toolId: tool.id,
    claudeConfig: join(home, '.claude.json'),
    codexConfig: join(codexHome, 'config.toml'),
    backupsDir: join(home, '.osource', 'backups'),
  };
}

const SPEC: McpServerSpec = {
  type: 'stdio',
  command: 'node',
  args: ['osm-server.js', '--stdio'],
  env: { OSM_MODE: 'test' },
};

/** Seed a target with an unrelated server through its own CLI. That both proves
 *  OSM leaves neighbours alone and lets the CLI write its own bookkeeping
 *  fields first — without it a byte-identical round trip is unmeasurable,
 *  because `claude mcp add-json` back-fills machineID/migration keys on first
 *  touch of a config it did not create. */
async function seed(box: Sandbox, target: 'claude' | 'codex'): Promise<void> {
  const res = await registerMcp(box.db, box.toolId, [target], {
    env: box.env,
    serverName: 'pre-existing',
    server: { type: 'stdio', command: 'node', args: ['neighbour.js'], env: {} },
  });
  assert.equal(res.ok, true, `seeding ${target} failed: ${res.message}`);
}

function eventBodies(box: Sandbox): string[] {
  return selectComments(box.db, box.toolId)
    .filter(c => c.kind === 'event')
    .map(c => c.body);
}

function backupFiles(box: Sandbox): string[] {
  return existsSync(box.backupsDir) ? readdirSync(box.backupsDir) : [];
}

function opts(box: Sandbox, extra: Partial<RegisterOpts> = {}): RegisterOpts {
  return { env: box.env, server: SPEC, ...extra };
}

// ---------------------------------------------------------------------------
// Windows .cmd shim resolution
// ---------------------------------------------------------------------------

test('resolveCommand resolves the .cmd shim on win32, never the bare name', () => {
  assert.equal(resolveCommand('osm-definitely-not-a-real-command-xyz'), null);

  for (const [base, resolved] of [['claude', CLAUDE], ['codex', CODEX]] as const) {
    if (resolved === null) continue;
    assert.equal(existsSync(resolved), true, `${base} resolved to a path that does not exist`);
    if (WIN) {
      const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(e => e !== '');
      const hasExt = exts.some(e => resolved.toLowerCase().endsWith(e.toLowerCase()));
      assert.equal(hasExt, true, `${base} resolved to ${resolved}, which has no PATHEXT extension`);
      // The extensionless sibling exists on this machine and is blocked by the
      // PowerShell execution policy; resolution must not pick it.
      assert.notEqual(resolved.toLowerCase().endsWith(base.toLowerCase()), true);
    }
  }
});

test('resolveCommand accepts an explicit path and rejects a missing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osm-res-'));
  tmpDirs.push(dir);
  const f = join(dir, 'thing.cmd');
  writeFileSync(f, '@echo off\n');
  assert.equal(resolveCommand(f), f);
  assert.equal(resolveCommand(join(dir, 'nope.cmd')), null);
});

// ---------------------------------------------------------------------------
// Detection (read-only)
// ---------------------------------------------------------------------------

test('detectTargets reports every target and never claims a path it did not find', () => {
  const targets = detectTargets();
  assert.deepEqual(
    targets.map(t => t.id),
    ALL_TARGETS,
  );
  for (const t of targets) {
    assert.equal(typeof t.detail, 'string');
    assert.notEqual(t.detail, '');
    if (!t.detected) {
      assert.equal(t.can_register, false);
      assert.equal(t.command, null);
      assert.equal(t.config_path, null);
      assert.match(t.detail, /^not detected/);
    }
    if (t.config_path !== null) assert.equal(existsSync(t.config_path) || t.mechanism === 'cli', true);
  }
  // Phase 5 targets are detect-only no matter what is installed.
  for (const id of ['kimi', 'zed', 'vscode'] as const) {
    const t = targets.find(x => x.id === id);
    assert.ok(t);
    assert.equal(t.can_register, false);
    assert.equal(t.mechanism, 'none');
  }
});

test('detectTargets honours an isolated HOME without touching the real one', () => {
  const home = mkdtempSync(join(tmpdir(), 'osm-det-'));
  tmpDirs.push(home);
  const targets = detectTargets({ ...process.env, USERPROFILE: home, HOME: home });
  const claude = targets.find(t => t.id === 'claude');
  assert.ok(claude);
  if (claude.detected) {
    assert.equal(claude.config_path, join(home, '.claude.json'));
  }
  const kimi = targets.find(t => t.id === 'kimi');
  assert.ok(kimi);
  assert.equal(kimi.detected, false, 'an empty temp HOME must not detect kimi');
});

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

test('unifiedDiff produces a real unified diff and nothing when identical', () => {
  assert.equal(unifiedDiff('same\ntext', 'same\ntext', 'a', 'b'), '');
  const d = unifiedDiff('(absent)', JSON.stringify({ type: 'stdio', command: 'node' }, null, 2), 'a', 'b');
  assert.match(d, /^--- a\n\+\+\+ b\n@@ -\d+,\d+ \+\d+,\d+ @@\n/);
  assert.match(d, /^-\(absent\)$/m);
  assert.match(d, /^\+ {2}"command": "node"$/m);
});

// ---------------------------------------------------------------------------
// Spec derivation
// ---------------------------------------------------------------------------

test('deriveServerSpec refuses to guess when there is no evidence', () => {
  const box = sandbox('nothing-derivable');
  const res = deriveServerSpec(box.db, box.toolId);
  assert.equal(res.ok, false);
  assert.match(res.message, /pass server explicitly/);
});

test('deriveServerSpec reads an npm key and a package.json bin', () => {
  const box = sandbox('derive');
  const npmTool = insertTool(box.db, { canonical_key: 'npm:some-mcp', name: 'some-mcp', kind: 'global-cli' });
  const npmRes = deriveServerSpec(box.db, npmTool.id);
  assert.equal(npmRes.ok, true);
  assert.deepEqual(npmRes.data, { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp'], env: {} });

  const dir = join(box.home, 'repo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ bin: { 'repo-tool': 'bin/cli.js' } }));
  const repoTool = insertTool(box.db, { canonical_key: 'github.com/x/repo-tool', name: 'repo-tool', kind: 'repo' });
  box.db
    .prepare('INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, ?, 1, ?)')
    .run(repoTool.id, dir, '1.0.0', '2026-07-31 00:00:00');
  const repoRes = deriveServerSpec(box.db, repoTool.id);
  assert.equal(repoRes.ok, true);
  assert.deepEqual(repoRes.data, { type: 'stdio', command: 'node', args: [join(dir, 'bin/cli.js')], env: {} });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test('registration is per-tool and explicit', async () => {
  const box = sandbox('guards');
  const empty = await registerMcp(box.db, box.toolId, [], opts(box));
  assert.equal(empty.ok, false);
  assert.match(empty.message, /per-tool and explicit/);

  const missing = await registerMcp(box.db, 999_999, ['claude'], opts(box));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /not found/);
});

test('Phase-5 targets are skipped with a named reason and execute nothing', async () => {
  const box = sandbox('phase5');
  const res = await registerMcp(box.db, box.toolId, ['kimi', 'zed', 'vscode'], opts(box));
  assert.equal(res.ok, false);
  for (const outcome of res.data?.targets ?? []) {
    assert.equal(outcome.status, 'skipped');
    assert.equal(outcome.commands.length, 0);
    assert.match(outcome.message, /Phase 5|not detected/);
  }
  assert.deepEqual(backupFiles(box), []);
  assert.deepEqual(eventBodies(box), []);
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

test('dry run produces a diff and writes nothing (codex, byte-level)', { ...T, skip: noCodex }, async () => {
  const box = sandbox('dry-codex');
  await seed(box, 'codex');
  const before = readFileSync(box.codexConfig);
  const backupsBefore = backupFiles(box).length;
  const eventsBefore = eventBodies(box).length;

  const res = await registerMcp(box.db, box.toolId, ['codex'], opts(box, { dryRun: true }));
  assert.equal(res.ok, true);
  const outcome = res.data?.targets[0];
  assert.ok(outcome);
  assert.equal(outcome.status, 'dry-run');
  assert.match(outcome.diff, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(outcome.diff, /^-\(absent\)$/m);
  assert.match(outcome.diff, /^\+ {4}"--stdio"$/m);
  // The exact argv it WOULD run, as an array — never a shell string.
  assert.deepEqual(outcome.commands[0].slice(1), [
    'mcp',
    'add',
    serverNameFor('dry-codex'),
    '--env',
    'OSM_MODE=test',
    '--',
    'node',
    'osm-server.js',
    '--stdio',
  ]);

  assert.deepEqual(readFileSync(box.codexConfig), before, 'dry run modified config.toml');
  assert.equal(backupFiles(box).length, backupsBefore, 'dry run took a backup');
  assert.equal(eventBodies(box).length, eventsBefore, 'dry run wrote a journal event');
  assert.equal((await servingDetail('dry-codex', { env: box.env })).count, 0);
});

test('dry run produces a diff and writes nothing (claude)', { ...T, skip: noClaude }, async () => {
  const box = sandbox('dry-claude');
  await seed(box, 'claude');
  const name = serverNameFor('dry-claude');
  const backupsBefore = backupFiles(box).length;
  const eventsBefore = eventBodies(box).length;

  const res = await registerMcp(box.db, box.toolId, ['claude'], opts(box, { dryRun: true }));
  assert.equal(res.ok, true);
  const outcome = res.data?.targets[0];
  assert.ok(outcome);
  assert.equal(outcome.status, 'dry-run');
  assert.match(outcome.diff, /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.deepEqual(outcome.commands[0].slice(1), [
    'mcp',
    'add-json',
    name,
    JSON.stringify(SPEC),
    '--scope',
    'user',
  ]);

  // The claude CLI rewrites its own bookkeeping on any read, so the meaningful
  // assertion is that OSM added no server, no backup and no journal entry.
  const cfg = JSON.parse(readFileSync(box.claudeConfig, 'utf8')) as { mcpServers?: Record<string, unknown> };
  assert.deepEqual(Object.keys(cfg.mcpServers ?? {}), ['pre-existing']);
  assert.equal(backupFiles(box).length, backupsBefore);
  assert.equal(eventBodies(box).length, eventsBefore);
});

// ---------------------------------------------------------------------------
// Live write: backup, verification, journal
// ---------------------------------------------------------------------------

test('register backs up before writing and verifies by CLI read-back', { ...T, skip: noClaude }, async () => {
  const box = sandbox('backup-claude');
  await seed(box, 'claude');
  const preWrite = readFileSync(box.claudeConfig);
  // Seeding is itself an OSM write, so it already took one backup.
  const backupsBefore = backupFiles(box);

  const res = await registerMcp(box.db, box.toolId, ['claude'], opts(box));
  assert.equal(res.ok, true, res.message);
  const outcome = res.data?.targets[0];
  assert.ok(outcome);
  assert.equal(outcome.status, 'registered');

  const added = backupFiles(box).filter(f => !backupsBefore.includes(f));
  assert.equal(added.length, 1, `expected one new backup, got ${JSON.stringify(added)}`);
  assert.match(added[0], /^\d{8}-\d{6}-\d{3}-claude-\.claude\.json$/);
  assert.equal(outcome.backup, join(box.backupsDir, added[0]));
  assert.deepEqual(
    readFileSync(join(box.backupsDir, added[0])),
    preWrite,
    'the backup must be the bytes as they were BEFORE the write',
  );

  // Read the state back the same way the registrar claims to.
  const detail = await servingDetail('backup-claude', { env: box.env });
  assert.equal(detail.count, 1);
  assert.deepEqual(detail.serving, ['claude']);
  assert.deepEqual(detail.unreadable, []);

  const cfg = JSON.parse(readFileSync(box.claudeConfig, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(cfg.mcpServers[serverNameFor('backup-claude')], SPEC);
  assert.ok(cfg.mcpServers['pre-existing'], 'a neighbouring server must survive');
  assert.ok(eventBodies(box).includes(`registered → claude (${serverNameFor('backup-claude')})`));
});

test('a corrupted write is rolled back from the backup', { ...T, skip: noClaude }, async () => {
  const box = sandbox('rollback-claude');
  await seed(box, 'claude');
  const preWrite = readFileSync(box.claudeConfig);

  const res = await registerMcp(
    box.db,
    box.toolId,
    ['claude'],
    opts(box, {
      // Corrupt the target after the CLI write, before verification.
      afterWrite: (_target, configPath) => {
        assert.ok(configPath);
        writeFileSync(configPath, 'not json at all {{{');
      },
    }),
  );

  assert.equal(res.ok, false);
  const outcome = res.data?.targets[0];
  assert.ok(outcome);
  assert.equal(outcome.status, 'rolled-back');
  assert.match(outcome.message, /verification failed/);
  assert.ok(outcome.backup, 'a rollback needs a backup to restore from');
  assert.deepEqual(
    readFileSync(box.claudeConfig),
    preWrite,
    'rollback must restore the config byte-for-byte',
  );
  assert.equal((await servingDetail('rollback-claude', { env: box.env })).count, 0);
  assert.equal(
    eventBodies(box).includes(`registered → claude (${serverNameFor('rollback-claude')})`),
    false,
    'a rolled-back write must not be journalled as registered',
  );
});

test('a corrupted write is rolled back from the backup (codex)', { ...T, skip: noCodex }, async () => {
  const box = sandbox('rollback-codex');
  await seed(box, 'codex');
  const preWrite = readFileSync(box.codexConfig);

  const res = await registerMcp(
    box.db,
    box.toolId,
    ['codex'],
    opts(box, {
      afterWrite: (_target, configPath) => {
        assert.ok(configPath);
        writeFileSync(configPath, 'this is not toml [[[\n');
      },
    }),
  );

  assert.equal(res.ok, false);
  const outcome = res.data?.targets[0];
  assert.ok(outcome);
  assert.equal(outcome.status, 'rolled-back');
  assert.deepEqual(readFileSync(box.codexConfig), preWrite);
});

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

test('register → unregister leaves claude byte-identical', { ...T, skip: noClaude }, async () => {
  const box = sandbox('round-claude');
  await seed(box, 'claude');
  const start = readFileSync(box.claudeConfig);

  const reg = await registerMcp(box.db, box.toolId, ['claude'], opts(box));
  assert.equal(reg.ok, true, reg.message);
  assert.notDeepEqual(readFileSync(box.claudeConfig), start, 'register did not change the config');

  const unreg = await unregisterMcp(box.db, box.toolId, ['claude'], { env: box.env });
  assert.equal(unreg.ok, true, unreg.message);
  const outcome = unreg.data?.targets[0];
  assert.ok(outcome);
  assert.equal(outcome.status, 'unregistered');

  assert.deepEqual(readFileSync(box.claudeConfig), start, 'round trip was not byte-identical');
  assert.equal((await servingDetail('round-claude', { env: box.env })).count, 0);
  const events = eventBodies(box);
  const name = serverNameFor('round-claude');
  assert.ok(events.includes(`registered → claude (${name})`));
  assert.ok(events.includes(`unregistered → claude (${name})`));
});

test('register → unregister leaves codex byte-identical', { ...T, skip: noCodex }, async () => {
  const box = sandbox('round-codex');
  await seed(box, 'codex');
  const start = readFileSync(box.codexConfig);

  const reg = await registerMcp(box.db, box.toolId, ['codex'], opts(box));
  assert.equal(reg.ok, true, reg.message);
  assert.notDeepEqual(readFileSync(box.codexConfig), start);
  // Read back through the CLI, not the file, and confirm env survived.
  const detail = await servingDetail('round-codex', { env: box.env });
  assert.deepEqual(detail.serving, ['codex']);

  const unreg = await unregisterMcp(box.db, box.toolId, ['codex'], { env: box.env });
  assert.equal(unreg.ok, true, unreg.message);
  assert.deepEqual(readFileSync(box.codexConfig), start, 'round trip was not byte-identical');
  assert.equal((await servingDetail('round-codex', { env: box.env })).count, 0);
});

test('re-registering an identical server is a no-op', { ...T, skip: noCodex }, async () => {
  const box = sandbox('idempotent');
  await seed(box, 'codex');
  assert.equal((await registerMcp(box.db, box.toolId, ['codex'], opts(box))).ok, true);
  const afterFirst = readFileSync(box.codexConfig);
  const backupsAfterFirst = backupFiles(box).length;

  const again = await registerMcp(box.db, box.toolId, ['codex'], opts(box));
  assert.equal(again.ok, true);
  assert.equal(again.data?.targets[0].status, 'already');
  assert.deepEqual(readFileSync(box.codexConfig), afterFirst);
  assert.equal(backupFiles(box).length, backupsAfterFirst, 'a no-op must not take a backup');
});

// ---------------------------------------------------------------------------
// servingCount
// ---------------------------------------------------------------------------

test('servingCount reads back from every agent', { ...T, skip: noCodex }, async () => {
  const box = sandbox('serving');
  assert.equal(await servingCount('serving', { env: box.env }), 0);
  await seed(box, 'codex');
  assert.equal(await servingCount('serving', { env: box.env }), 0, 'a neighbour must not count');
  assert.equal((await registerMcp(box.db, box.toolId, ['codex'], opts(box))).ok, true);
  assert.equal(await servingCount('serving', { env: box.env }), 1);
  assert.equal((await unregisterMcp(box.db, box.toolId, ['codex'], { env: box.env })).ok, true);
  assert.equal(await servingCount('serving', { env: box.env }), 0);
});

// ---------------------------------------------------------------------------
// Windows shim hazard
// ---------------------------------------------------------------------------

test(
  'an argument cmd.exe would mangle is refused, not executed',
  { ...T, skip: !WIN ? 'win32 only' : noClaude },
  async () => {
    const box = sandbox('metachar');
    await seed(box, 'claude');
    const before = readFileSync(box.claudeConfig);

    const res = await registerMcp(box.db, box.toolId, ['claude'], {
      env: box.env,
      // `&` survives neither cmd.exe's tokenizer nor the shim's %* re-parse.
      server: { type: 'http', url: 'https://example.dev/mcp?a=1&b=2' },
    });

    assert.equal(res.ok, false);
    const outcome = res.data?.targets[0];
    assert.ok(outcome);
    assert.equal(outcome.status, 'rolled-back');
    assert.match(outcome.message, /metacharacter/);
    assert.deepEqual(readFileSync(box.claudeConfig), before);
    assert.equal((await servingDetail('metachar', { env: box.env })).count, 0);
  },
);
