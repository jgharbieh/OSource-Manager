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
/**
 * Where the writable volume is mounted in run mode.
 *
 * Deliberately NOT /work: Docker pre-populates an empty named volume from
 * the image's contents at that path, ownership included, so mounting at a
 * path the image already owns silently reverts the chown below and pip cannot
 * write. Verified against agent-pod-claude, which ships its own /work.
 */
const RUNWORK = '/osm-work';

/**
 * Runtime images for run mode, chosen from what the repo actually declares.
 * Slim official images only — a repo does not get to name the image it runs in.
 */
const RUNTIMES: Array<{ id: RuntimeId; image: string; marker: RegExp; setup: string[] }> = [
  {
    id: 'python',
    image: 'python:3.12-slim',
    marker: /^(pyproject\.toml|requirements\.txt|setup\.py)$/i,
    // A venv in the writable volume: pip must not need root, and installing
    // into the image's site-packages would need a writable rootfs.
    setup: ['python -m venv /work/venv', '/work/venv/bin/pip install --no-input -q'],
  },
  {
    id: 'node',
    image: 'node:22-alpine',
    marker: /^package\.json$/i,
    setup: ['npm install --omit=dev --no-audit --no-fund'],
  },
];

export type RuntimeId = 'python' | 'node';
export type SandboxMode = 'inspect' | 'run';

export interface SandboxOpts {
  dockerBin?: string;
  timeoutMs?: number;
  /** Full history instead of --depth 1. Off by default: a trial wants the code. */
  fullHistory?: boolean;
  /**
   * 'inspect' (default) — no network, nothing writable, nothing executed. Safe
   * to point an agent at code nobody has audited.
   *
   * 'run' — the repo's own dependency install RUNS, which means arbitrary code
   * from a third party executes, and it needs network to do it. Everything that
   * can still be held is held (non-root, no capabilities, no host mount, capped),
   * but this is a real decision and belongs behind an explicit choice, never a
   * default.
   */
  mode?: SandboxMode;
  /**
   * Run mode: use an image already on this machine instead of pulling the
   * default runtime.
   *
   * Two reasons this exists. Docker Hub is not always reachable (verified: its
   * CDN drops larger layers from some networks, so `python:3.12-slim` fails
   * mid-pull while a small image succeeds), and a 2GB image already on disk
   * beats a fresh download of the same thing.
   *
   * The value comes from the CALLER, never from the repo — a repo does not get
   * to choose the image it runs in. It must still declare a runtime OSM
   * recognises; the override only changes which image provides it.
   */
  runtimeImage?: string;
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
  /** The isolation actually applied, so the UI states facts, not intentions. */
  isolation: string[];
  mode: SandboxMode;
  /** Run mode only: the runtime detected, its image, and how to invoke it. */
  runtime: RuntimeId | null;
  /** Run mode only: writable volume holding the venv / node_modules. */
  work_volume: string | null;
  /** Run mode only: output of the dependency install (arbitrary repo code ran). */
  install_output: string | null;
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
 * The argv for the inspect container. Pure and exported so the isolation is
 * covered by a test: these flags ARE the security boundary, and a future edit
 * that quietly drops one would otherwise pass every existing test while turning
 * the sandbox back into an ordinary container.
 */
export function inspectRunArgv(a: {
  container: string;
  volume: string;
  uid: string;
  path: string;
}): string[] {
  return [
    'run', '-d',
    '--name', a.container,
    // Read-only mount: what is read is what was cloned.
    '-v', `${a.volume}:${WORKDIR}:ro`,
    '--label', `osm.trial=${a.uid}`,
    // No interface at all — nothing in the repo can phone home or pull a second
    // stage. The clone happened in a separate container that had network.
    '--network', 'none',
    // A writable rootfs is a persistence foothold; /tmp is a noexec tmpfs so a
    // shell still works.
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    // Reading files needs no capability, and a setuid binary must not escalate.
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    // nobody. The clone is root-owned but world-readable: reads work, writes don't.
    '--user', '65534:65534',
    // A fork bomb or a miner in a postinstall hits a wall.
    '--pids-limit', '256',
    '--memory', '512m',
    '--workdir', a.path,
    '--entrypoint', 'sleep',
    GIT_IMAGE,
    'infinity',
  ];
}

/**
 * The argv for the RUN container. Pure and exported for the same reason as
 * inspectRunArgv: what is dropped here is the difference between "third-party
 * code executes in a box" and "third-party code executes on your machine".
 *
 * Network is ON — that is the whole point of run mode, and the honest cost of
 * it. Everything that does not have to be given away is still withheld: no host
 * path, no root, no capabilities, no privilege escalation, capped memory and
 * processes, and the source itself stays read-only so a dependency install
 * cannot rewrite the code you just audited.
 */
export function runModeArgv(a: {
  container: string;
  volume: string;
  workVolume: string;
  uid: string;
  path: string;
  image: string;
}): string[] {
  return [
    'run', '-d',
    '--name', a.container,
    // Source read-only: an install script cannot edit the code that was read.
    '-v', `${a.volume}:${WORKDIR}:ro`,
    // The only writable place, and it is an OSM-owned volume teardown removes.
    '-v', `${a.workVolume}:${RUNWORK}`,
    '--label', `osm.trial=${a.uid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65534:65534',
    '--pids-limit', '512',
    '--memory', '2g',
    // pip/npm and the tool itself write caches and config to $HOME.
    '--env', `HOME=${RUNWORK}`,
    // Both possible install targets, ahead of the image's own PATH, so the
    // tool is callable by name after the install regardless of which one
    // succeeded. A running container's env cannot be changed later.
    '--env',
    `PATH=${RUNWORK}/venv/bin:${RUNWORK}/py/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    '--env', `PYTHONUSERBASE=${RUNWORK}/py`,
    '--env', `XDG_CACHE_HOME=${RUNWORK}/.cache`,
    '--env', `PIP_CACHE_DIR=${RUNWORK}/.cache/pip`,
    '--workdir', a.path,
    '--entrypoint', 'sleep',
    a.image,
    'infinity',
  ];
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

    // Every failure path removes exactly what this call created, and nothing
    // that was already on the machine. -v takes the container's own anonymous
    // volumes; named ones are never touched by it.
    const created: string[] = [];
    let pulledRunImage: string | null = null;
    const undo = async (): Promise<void> => {
      if (created.includes('container')) await docker(bin, ['rm', '-f', '-v', container], timeout);
      if (created.includes('work-volume')) await docker(bin, ['volume', 'rm', `${volume}-work`], timeout);
      if (created.includes('volume')) await docker(bin, ['volume', 'rm', volume], timeout);
      if (created.includes('image') && imageOwned) await docker(bin, ['rmi', GIT_IMAGE], timeout);
      if (created.includes('run-image') && pulledRunImage) await docker(bin, ['rmi', pulledRunImage], timeout);
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
    //
    // INSPECT MODE. This container exists to be READ — by a human or by an
    // agent — and the code in it is untrusted by definition. So it gets the
    // whole set:
    //
    //   --network none   nothing can phone home, exfiltrate, or pull a second
    //                    stage. The clone already happened in a separate
    //                    container that had network; this one never needs it,
    //                    and with no interface there is nothing to egress over.
    //   :ro on /src      the source cannot be modified, so what is read is what
    //                    was cloned.
    //   --read-only      writable rootfs is a persistence foothold. /tmp is a
    //                    tmpfs so a shell still works.
    //   --cap-drop ALL   no capability is needed to read files.
    //   no-new-privileges  a setuid binary in the repo cannot escalate.
    //   --user 65534     nobody. The clone is root-owned but world-readable, so
    //                    reading works and writing does not.
    //   pids/memory      a fork bomb or miner in a postinstall hits a wall.
    //
    // Still true, and the strongest guarantee here: no host path is mounted, so
    // the host filesystem, the SSH keys and every .env are simply not present.
    const mode: SandboxMode = opts.mode ?? 'inspect';
    let runtime: RuntimeId | null = null;
    let runImage = GIT_IMAGE;
    let runImageOwned = false;
    let workVolume: string | null = null;
    let installOutput: string | null = null;

    if (mode === 'run') {
      // The runtime is chosen from what the repo DECLARES, never from anything
      // the repo asks for. Detection reads the clone in a throwaway container
      // that has no network of its own.
      const probe = await docker(
        bin,
        [
          'run', '--rm', '--network', 'none',
          '-v', `${volume}:${WORKDIR}:ro`,
          '--entrypoint', 'ls',
          GIT_IMAGE, '-A', path,
        ],
        timeout,
      );
      const files = probe.ok ? lines(probe.stdout) : [];
      const hit = RUNTIMES.find(r => files.some(f => r.marker.test(f)));
      if (!hit) {
        await undo();
        return fail(
          `${tool.name} declares no runtime OSM can run — looked for pyproject.toml, requirements.txt, ` +
            `setup.py and package.json in the clone. The source is still readable: clone it in inspect mode instead.`,
        );
      }
      runtime = hit.id;
      runImage = opts.runtimeImage ?? hit.image;
      // An image that was already here is shared: teardown must never delete it.
      runImageOwned = !(await imageExists(bin, runImage));
      if (runImageOwned) {
        const pull = await docker(bin, ['pull', runImage], timeout);
        if (!pull.ok) {
          await undo();
          return fail(`could not pull ${runImage}: ${pull.error ?? 'unknown error'}`);
        }
        created.push('run-image');
        pulledRunImage = runImage;
      }
      workVolume = `${volume}-work`;
      const wv = await docker(bin, ['volume', 'create', '--label', `osm.trial=${uid}`, workVolume], timeout);
      if (!wv.ok) {
        await undo();
        return fail(`could not create work volume ${workVolume}: ${wv.error ?? 'unknown error'}`);
      }
      created.push('work-volume');

      // A fresh named volume is root-owned, and the run container is nobody —
      // so pip could not even create its venv ("Permission denied: /work/venv").
      // Hand ownership over first, in a throwaway container that touches only
      // this OSM-created volume: --network none, and root ONLY for the chown.
      const own = await docker(
        bin,
        [
          'run', '--rm', '--network', 'none',
          '-v', `${workVolume}:${RUNWORK}`,
          '--user', '0:0',
          '--entrypoint', 'chown',
          GIT_IMAGE,
          '-R', '65534:65534', RUNWORK,
        ],
        timeout,
      );
      if (!own.ok) {
        await undo();
        return fail(
          `could not hand ${RUNWORK} to the unprivileged user: ${own.error ?? 'unknown error'}`,
        );
      }
    }

    // Idle container holding the clone. WHICH flags it gets is the entire
    // difference between the two modes — see inspectRunArgv / runModeArgv.
    const up = await docker(
      bin,
      mode === 'run'
        ? runModeArgv({ container, volume, workVolume: workVolume as string, uid, path, image: runImage })
        : inspectRunArgv({ container, volume, uid, path }),
      timeout,
    );
    if (!up.ok) {
      await undo();
      return fail(`cloned, but the source container would not start: ${up.error ?? 'unknown error'}`);
    }
    created.push('container');

    const ls = await docker(bin, ['exec', container, 'ls', '-A', path], timeout);
    const entries = ls.ok ? lines(ls.stdout) : [];

    if (mode === 'run' && runtime !== null) {
      // THIS is the line where third-party code executes: a dependency install
      // runs whatever the package tells it to. It happens in a container with no
      // host mount and no root, and nowhere else.
      // `python` is not guaranteed to exist — Debian-based images ship python3
      // only — so resolve whichever is present rather than assuming an alias.
      const script =
        runtime === 'python'
          ? `PY=$(command -v python3 || command -v python) || { echo "no python in this image"; exit 1; }; ` +
            // Prefer a venv; fall back to --user when ensurepip is missing.
            `if "$PY" -m venv ${RUNWORK}/venv >/dev/null 2>&1; then ` +
            `  echo "[osm] venv at ${RUNWORK}/venv"; ${RUNWORK}/venv/bin/pip install --no-input -q . 2>&1 | tail -40; ` +
            `else ` +
            `  echo "[osm] no ensurepip - user-site install into ${RUNWORK}/py (PEP 668 overridden: this python belongs to a throwaway container)"; ` +
            `  "$PY" -m pip install --no-input -q --user --break-system-packages . 2>&1 | tail -40; ` +
            `fi`
          : `npm install --omit=dev --no-audit --no-fund --prefix ${RUNWORK} 2>&1 | tail -40`;
      const install = await docker(bin, ['exec', container, 'sh', '-c', script], timeout);
      const text = `${install.stdout}${install.stderr}`.trim().slice(0, 4000);
      // A failed install is something to READ, so the container stays up with
      // the source still mounted beside it.
      installOutput = install.ok ? text : `INSTALL FAILED\n${text}`;
    }

    const isolation =
      mode === 'run'
        ? [
            'NETWORK IS ON — run mode exists to let the tool reach the internet, and that is the honest cost of it',
            'no host path is mounted: your filesystem, SSH keys and every .env are not present in there',
            'the source stays read-only, so a dependency install cannot rewrite the code you audited',
            'runs as nobody (65534) with every Linux capability dropped and no-new-privileges set',
            `the only writable place is an OSM-owned volume at ${RUNWORK}, removed by Tear down`,
            'capped at 2G and 512 processes',
            `the repo's own dependency install RAN (${runtime}) — third-party code has executed, in here`,
          ]
        : [
            'no network interface at all (--network none) — nothing in the repo can reach the internet or your LAN',
            'no host path is mounted: your filesystem, SSH keys and every .env are not present in there',
            'the source is mounted read-only; the container root filesystem is read-only too (/tmp is a 64M tmpfs, noexec)',
            'runs as nobody (65534) with every Linux capability dropped and no-new-privileges set',
            'capped at 512M and 256 processes',
            'nothing from the repo has been executed — git cloned files, it did not run them',
          ];

    const ownedImage = mode === 'run' ? runImageOwned : imageOwned;

    const result: SandboxResult = {
      trial_uid: uid,
      container,
      volume,
      image: runImage,
      path,
      entries,
      image_created_by_osm: ownedImage ? 1 : 0,
      exec_hint: `docker exec -it ${container} sh`,
      clone_output: (cloned.stderr || cloned.stdout).trim(),
      isolation,
      mode,
      runtime,
      work_volume: workVolume,
      install_output: installOutput,
    };

    withTransaction(db, () => {
      beginTrial(db, toolId, {
        trial_uid: uid,
        container,
        image: runImage,
        ports: null,
        image_created_by_osm: ownedImage ? 1 : 0,
        volumes_created_by_osm: workVolume === null ? [volume] : [volume, workVolume],
      });
      upsertObservations(db, toolId, { trial_running: 1 });
      if (tool.verdict === 'wanted') updateToolVerdict(db, toolId, 'trying', tool.retire_reason);
      addEvent(
        db,
        toolId,
        `cloned into a ${mode} container ${uid}: ${url} -> volume ${volume} at ${path}, container ${container} ` +
          `[image=${runImage}, image_created_by_osm=${ownedImage ? 1 : 0}]` +
          (mode === 'run'
            ? ` - RUN mode: network on, ${runtime ?? 'unknown'} dependency install executed inside the container`
            : ' - inspect mode: no network, nothing executed') +
          ' - nothing was written to this disk',
      );
    });

    return ok(
      `cloned ${gh.owner}/${gh.repo} into volume ${volume} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} at ${path}` +
        (mode === 'run'
          ? `, ${runtime} runtime ready in ${container}`
          : ', inspect only: no network, nothing executed') +
        '. Nothing touched your disk.',
      result,
    );
  } catch (err) {
    return fail(`clone into container failed: ${String(err)}`);
  }
}
