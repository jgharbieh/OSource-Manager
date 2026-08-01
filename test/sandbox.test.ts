import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRunArgv } from '../dist/core/sandbox.js';

/**
 * These flags ARE the security boundary of the inspect sandbox — the reason it
 * is safe to point an agent at a repo nobody has audited. Verified live against
 * a running container (id → nobody, egress blocked, only `lo`, both filesystems
 * read-only, CapDrop=[ALL]); this test exists so a later edit cannot quietly
 * drop one and still pass everything else.
 */

const argv = inspectRunArgv({
  container: 'osm-src-thing',
  volume: 'osm-src-thing-abc12345',
  uid: 'abc12345-0000-0000-0000-000000000000',
  path: '/src/thing',
});

/** True when `flag value` appear adjacently, so a stray occurrence can't pass. */
function hasPair(flag: string, value: string): boolean {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] === value;
}

test('inspect sandbox: no network interface exists at all', () => {
  assert.ok(hasPair('--network', 'none'), '--network none is what stops exfiltration');
});

test('inspect sandbox: nothing is writable — source or rootfs', () => {
  assert.ok(
    argv.some(a => a === 'osm-src-thing-abc12345:/src:ro'),
    'the source mount must carry :ro',
  );
  assert.ok(argv.includes('--read-only'), 'rootfs read-only denies a persistence foothold');
  assert.ok(hasPair('--tmpfs', '/tmp:rw,noexec,nosuid,size=64m'), '/tmp is noexec + nosuid');
});

test('inspect sandbox: unprivileged, no capabilities, no escalation', () => {
  assert.ok(hasPair('--cap-drop', 'ALL'));
  assert.ok(hasPair('--security-opt', 'no-new-privileges'));
  assert.ok(hasPair('--user', '65534:65534'), 'runs as nobody, not root');
});

test('inspect sandbox: resource-capped against a miner or fork bomb', () => {
  assert.ok(hasPair('--pids-limit', '256'));
  assert.ok(hasPair('--memory', '512m'));
});

test('inspect sandbox: never a host mount, a socket, or a privilege flag', () => {
  const joined = argv.join(' ');
  // The whole point: no host path is reachable from inside.
  for (const forbidden of [
    '--privileged',
    '--network=host',
    '--pid=host',
    '--cap-add',
    '/var/run/docker.sock',
    '-v /',
    'C:\\',
    'D:\\',
  ]) {
    assert.ok(!joined.includes(forbidden), `must never appear: ${forbidden}`);
  }
  // Exactly one -v, and it is the named volume (never a bind mount).
  const mounts = argv.filter((a, i) => argv[i - 1] === '-v');
  assert.equal(mounts.length, 1);
  assert.match(mounts[0], /^osm-src-[a-z0-9-]+:\/src:ro$/);
});

test('inspect sandbox: idles, and never runs anything from the repo', () => {
  assert.ok(hasPair('--entrypoint', 'sleep'), 'the container sleeps; repo code never starts');
  assert.equal(argv[argv.length - 1], 'infinity');
  assert.ok(hasPair('--label', 'osm.trial=abc12345-0000-0000-0000-000000000000'), 'teardown ownership');
});
