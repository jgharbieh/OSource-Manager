/**
 * Clone a repo into a container, never onto the host disk.
 *
 * "Try it" was unreachable for anything not already checked out: you cannot plan
 * a trial from a repo that isn't there. Cloning to `D:\dev\tools` would have
 * fixed that by making the mess this app exists to prevent — an untried repo
 * left on disk forever.
 *
 * So the checkout lives in a named Docker volume and the source container mounts
 * it. Kill it and the source goes with it; keep it and promote it deliberately.
 * Recorded as a normal trial row (`osm.trial=<uid>` on the volume, the container
 * and the image-ownership flag), so tearDown() in trial.ts removes it with the
 * same verified-ownership rules and needs no special case.
 *
 * Nothing from the repo executes: git clones, then the container idles on
 * `sleep infinity`. Running the project's own code is still try_it's job, behind
 * the flag allowlist.
 */
import { randomUUID } from 'node:crypto';
import type { OpResult } from './types.js';
import {
  type Db,
  addEvent,
  beginTrial,
  latestTrial,
  selectTool,
  updateToolVerdict,
  upsertObservations,
  withTransaction,
} from './db.js';
import {
  DOCKER_UNAVAILABLE,
  docker,
  dockerAvailable,
  dockerBinFrom,
  imageExists,
  lines,
} from './trial.js';
import { resolveGithub } from './resolve.js';

/** Small, official, and already carries git. Pinned by tag, not digest-floated. */
const GIT_IMAGE = 'alpine/git:latest';
const CLONE_TIMEOUT_MS = 300_000;
const WORKDIR = '/src';

export interface SandboxOpts {
  dockerBin?: string;
  timeoutMs?: number;
  /** Full history instead of --depth 1. Off by default: a trial wants the code. */
  fullHistory?: boolean;
}

export interface SandboxResult {
  trial_uid: string;
  container: string;
  volume: string;
  image: string;
  /** Path INSIDE the container, not on the host — there is no host path. */
  path: string;
  /** Top-level listing, so "it cloned" is evidence rather than a claim. */
  entries: string[];
  image_created_by_osm: number;
  /** Ready to paste: opens a shell in the clone. */
  exec_hint: string;
  clone_output: string;
}

function ok<T>(message: string, data?: T): OpResult<T> {
  return data === undefined ? { ok: true, message } : { ok: true, message, data };
}
function fail<T = never>(message: string): OpResult<T> {
  return { ok: false, message };
}

function slugOf(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s === '' ? 'repo' : s;
}

/**
 * Clone a tool's repo into a fresh named volume and leave an idle container
 * mounting it. Never throws; every failure path cleans up what it created.
 */
export async function cloneIntoSandbox(
  db: Db,
  toolId: number,
  opts: SandboxOpts = {},
): Promise<OpResult<SandboxResult>> {
  const bin = dockerBinFrom(opts);
  const timeout = opts.timeoutMs ?? CLONE_TIMEOUT_MS;

  try {
    const tool = selectTool(db, toolId);
    if (!tool) return fail(`tool ${toolId} not found`);

    const open = latestTrial(db, toolId);
    if (open && open.ended_at === null) {
      return fail(
        `${tool.name} already has an open trial (${open.trial_uid})${open.container ? ` on container ${open.container}` : ''} — tear that down first`,
      );
    }

    const gh = await resolveGithub(db, tool);
    if (!gh) {
      return fail(
        `no repository could be resolved for ${tool.name} (key: ${tool.canonical_key}) — set its upstream in Details first`,
      );
    }
    // Built from the canonical key, never from free text: no shell, argv only.
    const url = `https://github.com/${gh.owner}/${gh.repo}.git`;

    if (!(await dockerAvailable(bin))) return fail(DOCKER_UNAVAILABLE);

    const uid = randomUUID();
    const slug = slugOf(tool.name);
    const volume = `osm-src-${slug}-${uid.slice(0, 8)}`;
    const container = `osm-src-${slug}`;
    const path = `${WORKDIR}/${slug}`;

    // Ownership is decided BEFORE the pull, exactly as try_it does it: if the
    // image was already here it is shared, and teardown must never delete it.
    const imageOwned = !(await imageExists(bin, GIT_IMAGE));

    const created: string[] = [];
    const undo = async (): Promise<void> => {
      if (created.includes('container')) await docker(bin, ['rm', '-f', container], timeout);
      if (created.includes('volume')) await docker(bin, ['volume', 'rm', volume], timeout);
      if (created.includes('image') && imageOwned) await docker(bin, ['rmi', GIT_IMAGE], timeout);
    };

    if (imageOwned) {
      const pull = await docker(bin, ['pull', GIT_IMAGE], timeout);
      if (!pull.ok) return fail(`could not pull ${GIT_IMAGE}: ${pull.error ?? 'unknown error'}`);
      created.push('image');
    }

    const vol = await docker(
      bin,
      ['volume', 'create', '--label', `osm.trial=${uid}`, volume],
      timeout,
    );
    if (!vol.ok) {
      await undo();
      return fail(`could not create volume ${volume}: ${vol.error ?? 'unknown error'}`);
    }
    created.push('volume');

    const cloneArgs = [
      'run', '--rm',
      '-v', `${volume}:${WORKDIR}`,
      '--label', `osm.trial=${uid}`,
      GIT_IMAGE,
      'clone',
      ...(opts.fullHistory ? [] : ['--depth', '1']),
      url,
      path,
    ];
    const cloned = await docker(bin, cloneArgs, timeout);
    if (!cloned.ok) {
      await undo();
      // git writes progress to stderr, so the error text is the useful part.
      return fail(`git clone of ${url} failed inside the container: ${cloned.error ?? 'unknown error'}`);
    }

    // Idle container so the clone is reachable (docker exec / the Log tab) and
    // so teardown has something concrete to remove.
    const up = await docker(
      bin,
      [
        'run', '-d',
        '--name', container,
        '-v', `${volume}:${WORKDIR}`,
        '--label', `osm.trial=${uid}`,
        '--workdir', path,
        '--entrypoint', 'sleep',
        GIT_IMAGE,
        'infinity',
      ],
      timeout,
    );
    if (!up.ok) {
      await undo();
      return fail(`cloned, but the source container would not start: ${up.error ?? 'unknown error'}`);
    }
    created.push('container');

    const ls = await docker(bin, ['exec', container, 'ls', '-A', path], timeout);
    const entries = ls.ok ? lines(ls.stdout) : [];

    const result: SandboxResult = {
      trial_uid: uid,
      container,
      volume,
      image: GIT_IMAGE,
      path,
      entries,
      image_created_by_osm: imageOwned ? 1 : 0,
      exec_hint: `docker exec -it ${container} sh`,
      clone_output: (cloned.stderr || cloned.stdout).trim(),
    };

    withTransaction(db, () => {
      beginTrial(db, toolId, {
        trial_uid: uid,
        container,
        image: GIT_IMAGE,
        ports: null,
        image_created_by_osm: imageOwned ? 1 : 0,
        volumes_created_by_osm: [volume],
      });
      upsertObservations(db, toolId, { trial_running: 1 });
      if (tool.verdict === 'wanted') updateToolVerdict(db, toolId, 'trying', tool.retire_reason);
      addEvent(
        db,
        toolId,
        `cloned into a container ${uid}: ${url} → volume ${volume} at ${path}, container ${container} ` +
          `[image_created_by_osm=${imageOwned ? 1 : 0}] — nothing was written to this disk`,
      );
    });

    return ok(
      `cloned ${gh.owner}/${gh.repo} into volume ${volume} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} at ${path}. Nothing touched your disk.`,
      result,
    );
  } catch (err) {
    return fail(`clone into container failed: ${String(err)}`);
  }
}
