import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, insertTool, now, beginTrial, latestTrial, selectComments } from '../dist/core/db.js';
import { tryIt, tearDown, trialLogs } from '../dist/core/trial.js';

// Tests run against compiled output (tsc -p tsconfig.json first), same as the
// other suites. Docker-dependent tests SKIP cleanly when docker is absent.
//
// Docker discipline in here: only 'alpine' and 'hello-world' are ever used,
// every resource is labelled osm.trial=<uid>, and the after() hook force-removes
// exactly the containers/volumes these tests named — never a broad label sweep,
// which would eat a real OSM trial running on the machine.

const tmpDirs: string[] = [];
const openDbs: Array<{ close(): void }> = [];
const madeContainers: string[] = [];
const madeVolumes: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osm-trial-'));
  tmpDirs.push(dir);
  return dir;
}

function testDb(): ReturnType<typeof openDb> {
  const db = openDb(join(tmpDir(), 'osm.db'));
  openDbs.push(db);
  return db;
}

function rand(): string {
  return randomBytes(4).toString('hex');
}

function dockerSync(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 120_000,
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const DOCKER = dockerSync(['version', '--format', '{{.Server.Version}}']).ok;
const skipNoDocker = DOCKER ? false : 'docker is not available on this machine';

function imageExists(ref: string): boolean {
  return dockerSync(['image', 'inspect', ref, '--format', '{{.Id}}']).ok;
}

function volumeExists(name: string): boolean {
  return dockerSync(['volume', 'inspect', name, '--format', '{{.Name}}']).ok;
}

function containerExists(name: string): boolean {
  const res = dockerSync(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
  return res.ok && res.out.trim() === name;
}

function imageSet(): Set<string> {
  const res = dockerSync(['images', '--format', '{{.Repository}}:{{.Tag}}']);
  return new Set(res.out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== ''));
}

function volumeSet(): Set<string> {
  const res = dockerSync(['volume', 'ls', '--format', '{{.Name}}']);
  return new Set(res.out.split(/\r?\n/).map(l => l.trim()).filter(l => l !== ''));
}

after(() => {
  if (DOCKER) {
    for (const c of madeContainers) dockerSync(['rm', '-f', c]);
    for (const v of madeVolumes) dockerSync(['volume', 'rm', '-f', v]);
  }
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** Tool row + present disk installation pointing at a fresh fixture dir. */
function toolWith(db: ReturnType<typeof openDb>, files: Record<string, string>, name = `osmtest-${rand()}`) {
  const dir = join(tmpDir(), 'repo');
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  const tool = insertTool(db, { canonical_key: `local:${name}`, name, kind: 'repo' });
  db.prepare(
    'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, NULL, 1, ?)',
  ).run(tool.id, dir, now());
  const container = `osm-try-${name}`;
  madeContainers.push(container);
  return { id: tool.id, dir, name, container };
}

function trialCount(db: ReturnType<typeof openDb>, toolId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM trials WHERE tool_id = ?').get(toolId) as { n: number }).n;
}

function verdictOf(db: ReturnType<typeof openDb>, toolId: number): string {
  return (db.prepare('SELECT verdict FROM tools WHERE id = ?').get(toolId) as { verdict: string }).verdict;
}

const readmeRun = (cmd: string): string => `# fixture\n\n\`\`\`bash\n${cmd}\n\`\`\`\n`;

// --- guard rails (no docker required) ---

test('tryIt NEVER executes a refused plan — compose with privileged: true', async () => {
  const db = testDb();
  const t = toolWith(db, {
    'docker-compose.yml': 'services:\n  web:\n    image: alpine\n    privileged: true\n',
  });

  const res = await tryIt(db, t.id, { confirm: true });

  assert.equal(res.ok, false);
  assert.match(res.message, /refused/i);
  assert.match(res.message, /--privileged/);
  assert.equal(trialCount(db, t.id), 0, 'a refused plan must not create a trial row');
  assert.equal(verdictOf(db, t.id), 'wanted', 'a refused plan must not change the verdict');
  if (DOCKER) assert.equal(containerExists(t.container), false);
  db.close();
});

test('tryIt refuses a plan whose flags are off the allowlist (docker.sock bind mount)', async () => {
  const db = testDb();
  const t = toolWith(db, {
    'docker-compose.yml':
      'services:\n  web:\n    image: alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
  });

  const res = await tryIt(db, t.id, { confirm: true });

  assert.equal(res.ok, false);
  assert.match(res.message, /docker\.sock/);
  assert.equal(trialCount(db, t.id), 0);
  db.close();
});

test('tryIt on a tool with no docker instructions fails cleanly', async () => {
  const db = testDb();
  const t = toolWith(db, { 'README.md': '# nothing to run here\n' });

  const res = await tryIt(db, t.id, { confirm: true });

  assert.equal(res.ok, false);
  assert.match(res.message, /ships no container recipe/);
  assert.equal(trialCount(db, t.id), 0);
  db.close();
});

test('first trial of a source requires explicit confirmation', async () => {
  const db = testDb();
  const t = toolWith(db, { 'README.md': readmeRun('docker run -d --name web alpine') });

  const res = await tryIt(db, t.id); // no confirm

  assert.equal(res.ok, false);
  assert.match(res.message, /requires explicit confirmation/);
  assert.match(res.message, /confirm: true/);
  assert.equal(trialCount(db, t.id), 0);
  db.close();
});

test('tryIt on an unknown tool fails cleanly', async () => {
  const db = testDb();
  const res = await tryIt(db, 4242, { confirm: true });
  assert.equal(res.ok, false);
  assert.match(res.message, /not found/);
  db.close();
});

test('tearDown / trialLogs with no trial recorded fail cleanly', async () => {
  const db = testDb();
  const t = toolWith(db, { 'README.md': '# x\n' });

  const td = await tearDown(db, t.id);
  assert.equal(td.ok, false);
  assert.match(td.message, /no trial recorded/);

  const logs = await trialLogs(db, t.id);
  assert.equal(logs.ok, false);
  assert.match(logs.message, /no trial recorded/);

  db.close();
});

test('docker unavailable → every entry point returns a clean fail, never throws', async () => {
  const db = testDb();
  const bin = 'osm-no-such-docker-binary';
  const t = toolWith(db, { 'README.md': readmeRun('docker run -d --name web -p 8080:80 alpine') });

  const run = await tryIt(db, t.id, { confirm: true, dockerBin: bin });
  assert.equal(run.ok, false);
  assert.match(run.message, /docker is not available/);
  assert.equal(trialCount(db, t.id), 0);

  // A recorded trial + missing docker must still fail cleanly, not throw.
  beginTrial(db, t.id, { trial_uid: `uid-${rand()}`, container: 'osm-try-ghost', image: 'alpine:latest' });

  const td = await tearDown(db, t.id, { dockerBin: bin });
  assert.equal(td.ok, false);
  assert.match(td.message, /docker is not available/);
  assert.equal(latestTrial(db, t.id)!.ended_at, null, 'a failed teardown must not close the trial row');

  const logs = await trialLogs(db, t.id, 50, { dockerBin: bin });
  assert.equal(logs.ok, false);
  assert.match(logs.message, /docker is not available/);

  db.close();
});

test('tearDown refuses to run twice on the same trial', async () => {
  const db = testDb();
  const t = toolWith(db, { 'README.md': '# x\n' });
  const id = beginTrial(db, t.id, { trial_uid: `uid-${rand()}`, container: null, image: null });
  db.prepare("UPDATE trials SET ended_at = ?, outcome = 'torn-down' WHERE id = ?").run(now(), id);

  const td = await tearDown(db, t.id);
  assert.equal(td.ok, false);
  assert.match(td.message, /already torn down/);
  db.close();
});

// --- live docker ---

test(
  'try_it lifecycle: label, loopback-only port readback, journal, logs, re-entry guard',
  { skip: skipNoDocker },
  async () => {
    const db = testDb();
    const t = toolWith(db, {
      'README.md': readmeRun('docker run -d --name web -p 8080:80 -e OSM_FIXTURE=1 alpine ping 127.0.0.1'),
    });

    const res = await tryIt(db, t.id, { confirm: true });
    assert.equal(res.ok, true, res.message);
    const run = res.data!;

    // argv: only allowlisted flags reached docker, name/label are ours.
    assert.equal(run.argv[0], 'run');
    assert.ok(run.argv.includes('-d'));
    assert.equal(run.container, t.container);
    assert.equal(run.argv[run.argv.indexOf('--name') + 1], t.container);
    assert.ok(run.argv.includes(`osm.trial=${run.trial_uid}`));
    assert.equal(run.argv.includes('web'), false, 'the repo does not get to name the container');
    const allowed = new Set(['-d', '--name', '--label', '-p', '-v', '-e', '--shm-size', '--memory']);
    const imageIdx = run.argv.indexOf(run.image);
    for (const tok of run.argv.slice(1, imageIdx)) {
      if (tok.startsWith('-')) assert.ok(allowed.has(tok.split('=')[0]), `non-allowlisted flag reached argv: ${tok}`);
    }
    assert.equal(run.argv.includes('8080:80'), false, 'raw host port must never reach argv');
    assert.ok(run.argv.includes('127.0.0.1::80'));

    // The container really carries the trial label.
    const label = dockerSync(['inspect', t.container, '--format', '{{index .Config.Labels "osm.trial"}}']);
    assert.equal(label.out.trim(), run.trial_uid);

    // Port was read back from docker, and is loopback only.
    assert.equal(run.ports.length, 1);
    assert.equal(run.ports[0].container_port, '80/tcp');
    assert.equal(run.ports[0].host_ip, '127.0.0.1');
    assert.match(run.ports[0].host_port, /^\d+$/);
    const dockerPort = dockerSync(['port', t.container]);
    assert.match(dockerPort.out, /127\.0\.0\.1:/);
    assert.equal(/0\.0\.0\.0:/.test(dockerPort.out), false, 'must not publish on all interfaces');
    assert.deepEqual(run.warnings, []);

    // Persisted: trial row + journal event + verdict.
    const trial = latestTrial(db, t.id)!;
    assert.equal(trial.trial_uid, run.trial_uid);
    assert.equal(trial.container, t.container);
    assert.equal(trial.ended_at, null);
    assert.deepEqual(JSON.parse(trial.ports!), run.ports);
    assert.equal(verdictOf(db, t.id), 'trying');
    const events = selectComments(db, t.id).filter(c => c.kind === 'event');
    assert.ok(events.some(e => e.body.includes(`trial started ${run.trial_uid}`)), 'trial start was not journaled');

    // A second try while the first is live is refused.
    const again = await tryIt(db, t.id, { confirm: true });
    assert.equal(again.ok, false);
    assert.match(again.message, /still running/);
    assert.equal(trialCount(db, t.id), 1);

    // Logs are read-only and carry the container's output.
    const logs = await trialLogs(db, t.id, 20);
    assert.equal(logs.ok, true, logs.message);
    assert.equal(logs.data!.container, t.container);
    assert.match(logs.data!.logs, /PING 127\.0\.0\.1/);
    assert.equal(containerExists(t.container), true, 'reading logs must not remove the container');

    // Teardown: container gone, shared alpine image untouched and reported.
    const td = await tearDown(db, t.id);
    assert.equal(td.ok, true, td.message);
    assert.ok(td.data!.removed.some(r => r.includes(t.container)));
    assert.match(td.message, /kept shared image alpine:latest/);
    assert.equal(containerExists(t.container), false);
    assert.equal(imageExists('alpine:latest'), true);
    assert.equal(latestTrial(db, t.id)!.outcome, 'torn-down');
    assert.equal(verdictOf(db, t.id), 'kept', 'still on disk after the trial');

    db.close();
  },
);

test(
  'SHARED RESOURCES SURVIVE: pre-existing image + pre-existing volume are never OSM-owned',
  { skip: skipNoDocker },
  async () => {
    // Pre-pull the image (already cached on this machine; pull only if absent
    // so the test does not depend on the network).
    if (!imageExists('alpine:latest')) {
      const pull = dockerSync(['pull', 'alpine:latest']);
      assert.equal(pull.ok, true, `could not pre-pull alpine:latest: ${pull.out}`);
    }

    // Pre-create a named volume that is NOT ours.
    const shared = `osm-test-shared-${rand()}`;
    const fresh = `osm-test-new-${rand()}`;
    madeVolumes.push(shared, fresh);
    assert.equal(dockerSync(['volume', 'create', shared]).ok, true);
    assert.equal(volumeExists(shared), true);

    const imagesBefore = imageSet();
    const volumesBefore = volumeSet();
    assert.ok(volumesBefore.has(shared));
    assert.equal(volumesBefore.has(fresh), false);

    const db = testDb();
    const t = toolWith(db, {
      'docker-compose.yml':
        `services:\n  app:\n    image: alpine:latest\n    volumes:\n      - ${shared}:/shared\n      - ${fresh}:/fresh\n`,
    });

    const res = await tryIt(db, t.id, { confirm: true });
    assert.equal(res.ok, true, res.message);
    const run = res.data!;

    // Ownership: the pre-existing image and volume are NOT claimed.
    assert.equal(run.image_created_by_osm, 0, 'a pre-existing image must never be recorded as OSM-created');
    assert.deepEqual(run.volumes_created_by_osm, [fresh], 'only the volume that did not exist before is OSM-owned');
    assert.equal(volumeExists(fresh), true, 'the trial should have created the new volume');

    const trial = latestTrial(db, t.id)!;
    assert.equal(trial.image_created_by_osm, 0);
    assert.deepEqual(JSON.parse(trial.volumes_created_by_osm), [fresh]);

    // Teardown.
    const td = await tearDown(db, t.id);
    assert.equal(td.ok, true, td.message);

    // THE POINT: both pre-existing resources still exist.
    assert.equal(imageExists('alpine:latest'), true, 'shared image was deleted — ownership tracking failed');
    assert.equal(volumeExists(shared), true, 'shared volume was deleted — ownership tracking failed');
    assert.match(td.message, /kept shared image alpine:latest/);
    assert.ok(
      td.data!.kept.some(k => k.includes(shared)),
      `skipped shared volume must be reported: ${JSON.stringify(td.data!.kept)}`,
    );

    // And the OSM-created ones are gone.
    assert.equal(volumeExists(fresh), false, 'the OSM-created volume should have been removed');
    assert.equal(containerExists(t.container), false);

    // Global diff: nothing disappeared except what OSM created.
    const imagesAfter = imageSet();
    const volumesAfter = volumeSet();
    for (const img of imagesBefore) {
      assert.ok(imagesAfter.has(img), `image vanished during the trial: ${img}`);
    }
    for (const vol of volumesBefore) {
      assert.ok(volumesAfter.has(vol), `volume vanished during the trial: ${vol}`);
    }
    const leftover = [...volumesAfter].filter(v => !volumesBefore.has(v));
    assert.equal(leftover.includes(fresh), false, `OSM-created volume left behind: ${leftover.join(', ')}`);

    db.close();
  },
);

test(
  'image ownership: an image OSM had to pull is owned and removed on teardown',
  { skip: skipNoDocker },
  async t0 => {
    const preExisting = imageExists('hello-world:latest');

    const db = testDb();
    const t = toolWith(db, { 'README.md': readmeRun('docker run -d --name hw hello-world:latest') });

    // Registry blob fetches are flaky on some networks. A failed pull records
    // nothing and creates nothing, so re-entry is clean — retry a bounded
    // number of times before giving up on the branch.
    const isPullFailure = (r: { ok: boolean; message: string }): boolean =>
      !r.ok && /docker pull .* failed/.test(r.message);
    let res = await tryIt(db, t.id, { confirm: true });
    for (let attempt = 0; attempt < 3 && isPullFailure(res); attempt++) {
      assert.equal(trialCount(db, t.id), 0, 'a failed pull must not record a trial');
      assert.equal(containerExists(t.container), false, 'a failed pull must leave no container');
      res = await tryIt(db, t.id, { confirm: true });
    }
    if (isPullFailure(res)) {
      // The OSM-pulls-it branch cannot be exercised without the registry. The
      // clean fail is itself correct behaviour, so assert that and skip.
      assert.equal(trialCount(db, t.id), 0, 'a failed pull must not record a trial');
      assert.equal(containerExists(t.container), false, 'a failed pull must leave no container');
      t0.skip(`registry unreachable after 4 attempts: ${res.message.slice(0, 120)}`);
      db.close();
      return;
    }
    assert.equal(res.ok, true, res.message);
    const run = res.data!;

    if (preExisting) {
      // Machine already had it: OSM must not claim or delete it.
      assert.equal(run.image_created_by_osm, 0);
      const td = await tearDown(db, t.id);
      assert.equal(td.ok, true, td.message);
      assert.match(td.message, /kept shared image hello-world:latest/);
      assert.equal(imageExists('hello-world:latest'), true);
    } else {
      // OSM pulled it: OSM owns it and gives it back.
      assert.equal(run.image_created_by_osm, 1, 'an image OSM pulled must be recorded as OSM-created');
      assert.equal(imageExists('hello-world:latest'), true);
      const td = await tearDown(db, t.id);
      assert.equal(td.ok, true, td.message);
      assert.ok(td.data!.removed.some(r => r.includes('hello-world')), 'the OSM-pulled image should be removed');
      assert.equal(imageExists('hello-world:latest'), false, 'machine state should be restored');
    }
    assert.equal(containerExists(t.container), false);

    db.close();
  },
);

test(
  'teardown reverts the verdict to wanted when nothing is left on disk',
  { skip: skipNoDocker },
  async () => {
    const db = testDb();
    const t = toolWith(db, { 'README.md': readmeRun('docker run -d --name web alpine ping 127.0.0.1') });

    const res = await tryIt(db, t.id, { confirm: true });
    assert.equal(res.ok, true, res.message);
    assert.equal(verdictOf(db, t.id), 'trying');

    // The clone was deleted from disk while the trial ran.
    db.prepare('UPDATE installations SET present = 0 WHERE tool_id = ?').run(t.id);

    const td = await tearDown(db, t.id);
    assert.equal(td.ok, true, td.message);
    assert.equal(td.data!.verdict, 'wanted');
    assert.equal(verdictOf(db, t.id), 'wanted');
    const events = selectComments(db, t.id).filter(c => c.kind === 'event');
    assert.ok(events.some(e => e.body.includes('trial ended')), 'teardown was not journaled');

    db.close();
  },
);
