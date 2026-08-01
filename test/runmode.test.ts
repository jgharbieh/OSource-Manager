import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runModeArgv, inspectRunArgv } from '../dist/core/sandbox.js';

/**
 * Run mode gives up ONE thing inspect mode holds — network — because reaching
 * the internet is the whole point of it. Everything else must still be withheld,
 * and these tests exist so "we needed network" never quietly becomes "we needed
 * root", "we needed a host mount", or "we needed capabilities".
 *
 * Verified live: agent-reach installed and fetched real data from V2EX and the
 * Bilibili search API inside this container, while `docker inspect` still
 * reported CapDrop=[ALL], User=65534:65534 and only OSM-owned volume mounts.
 */

const argv = runModeArgv({
  container: 'osm-src-thing',
  volume: 'osm-src-thing-abc12345',
  workVolume: 'osm-src-thing-abc12345-work',
  uid: 'abc12345-0000-0000-0000-000000000000',
  path: '/src/thing',
  image: 'python:3.12-slim',
});

function hasPair(flag: string, value: string): boolean {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] === value;
}

test('run mode: unprivileged and un-escalatable, exactly like inspect mode', () => {
  assert.ok(hasPair('--cap-drop', 'ALL'), 'network is not a reason to hand back capabilities');
  assert.ok(hasPair('--security-opt', 'no-new-privileges'));
  assert.ok(hasPair('--user', '65534:65534'), 'a dependency install must not run as root');
});

test('run mode: the audited source cannot be rewritten by the install', () => {
  assert.ok(
    argv.some(a => a === 'osm-src-thing-abc12345:/src:ro'),
    'the source mount keeps :ro so an install script cannot edit the code you read',
  );
});

test('run mode: the only writable place is an OSM-owned volume', () => {
  const mounts = argv.filter((a, i) => argv[i - 1] === '-v');
  assert.equal(mounts.length, 2, 'source + work, nothing else');
  const writable = mounts.filter(m => !m.endsWith(':ro'));
  assert.deepEqual(writable, ['osm-src-thing-abc12345-work:/osm-work']);
});

test('run mode: writable volume is NOT mounted at /work', () => {
  // Docker pre-populates an empty named volume from the image's contents at the
  // mount path, ownership included. Mounting at /work against an image that
  // ships its own /work silently reverted the chown and pip could not write.
  assert.ok(!argv.some(a => a.endsWith(':/work')), '/work collides with real images');
});

test('run mode: install targets are on PATH before the container starts', () => {
  // A running container's env cannot be changed, so PATH has to be right up
  // front or the freshly installed CLI is not callable by name.
  const path = argv[argv.indexOf('--env') + 1];
  const pathEnv = argv.find(a => a.startsWith('PATH='));
  assert.ok(pathEnv, 'PATH must be set explicitly');
  assert.match(pathEnv, /\/osm-work\/venv\/bin/);
  assert.match(pathEnv, /\/osm-work\/py\/bin/);
  assert.match(pathEnv, /\/usr\/bin/, 'the image PATH must still be reachable');
  assert.ok(path.length > 0);
  assert.ok(argv.includes('PYTHONUSERBASE=/osm-work/py'), 'user-site fallback target');
  assert.ok(argv.includes('HOME=/osm-work'), 'pip and the tool write to $HOME');
});

test('run mode: capped, and never privileged or host-bound', () => {
  assert.ok(hasPair('--pids-limit', '512'));
  assert.ok(hasPair('--memory', '2g'));
  const joined = argv.join(' ');
  for (const forbidden of [
    '--privileged',
    '--network=host',
    '--pid=host',
    '--cap-add',
    '/var/run/docker.sock',
    'C:\\',
    'D:\\',
  ]) {
    assert.ok(!joined.includes(forbidden), `must never appear: ${forbidden}`);
  }
});

test('run mode: the image comes from the caller, and the container still idles', () => {
  assert.equal(argv[argv.length - 2], 'python:3.12-slim');
  assert.ok(hasPair('--entrypoint', 'sleep'));
  assert.equal(argv[argv.length - 1], 'infinity');
  assert.ok(hasPair('--label', 'osm.trial=abc12345-0000-0000-0000-000000000000'), 'teardown ownership');
});

test('the two modes differ ONLY by what run mode must give up', () => {
  const inspect = inspectRunArgv({
    container: 'c',
    volume: 'v',
    uid: 'u',
    path: '/src/x',
  });
  // Inspect has no network and nothing writable; run mode has network and one
  // writable volume. Neither has root, capabilities, or a host path.
  assert.ok(inspect.includes('--network'), 'inspect pins --network none');
  assert.ok(!argv.includes('--network'), 'run mode uses the default bridge on purpose');
  assert.ok(inspect.includes('--read-only'));
  assert.ok(!argv.includes('--read-only'), 'an install needs a writable rootfs for its temp files');
  for (const shared of ['--cap-drop', '--security-opt', '--user', '--pids-limit', '--memory']) {
    assert.ok(inspect.includes(shared) && argv.includes(shared), `${shared} must hold in BOTH modes`);
  }
});
