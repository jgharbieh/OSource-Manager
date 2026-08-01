/**
 * Live queries against PUBLIC catalogs — "other people's shelves".
 *
 * PLAN.md locked decision #10: catalogs are queried **live, never mirrored**.
 * Nothing in this file writes to the database. The only DB access is a
 * read-only index of the local shelf, used to mark which results are already
 * on it (`already_tracked`). A row enters the DB only when the user presses
 * Track, and that goes through ops.trackTool like every other track.
 *
 * Three sources, each degrading on its own so one dead source never takes the
 * page down:
 *
 *  - `docker`    `docker mcp catalog …` via execFile with an argv ARRAY.
 *                The CLI surface is **probed** (`--help`) before it is used.
 *                PLAN.md's [R2] correction table exists because v1 guessed
 *                `docker mcp server enable`, which does not exist; the real
 *                shape is `docker mcp catalog server ls <oci-reference>`.
 *  - `github`    api.github.com/search/repositories. Unauthenticated search
 *                is 10 req/min and the wider REST allowance is 60/hr, so the
 *                remaining quota is surfaced in every response and a 403
 *                degrades to an ok:false source status — never a throw.
 *  - `anthropic` contents API for the anthropics/skills repo, enriched from
 *                raw.githubusercontent.com (which costs no API quota).
 *
 * GITHUB_TOKEN is read from the environment when present and sent as a Bearer
 * token. It is never stored, never logged, and never placed in the response.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OpResult, ToolKind } from './types.js';
import { type Db, now, selectTools } from './db.js';
import { aliasesForGitUrl, canonicalKeyForGitUrl, canonicalKeyForSkill } from './canonical.js';

// --- shapes ---

export type CatalogSource = 'docker' | 'anthropic' | 'github';

export const ALL_CATALOG_SOURCES: readonly CatalogSource[] = ['docker', 'anthropic', 'github'];

/** Exactly the body POST /api/tools/track accepts. `null` on an item means OSM
 *  has no canonical identity for it, so Track is not offered at all. */
export interface TrackPayload {
  url?: string;
  name?: string;
  kind?: ToolKind;
  why?: string;
}

export interface CatalogItem {
  source: CatalogSource;
  name: string;
  description: string;
  /** Where a human goes to read about it. Always an absolute http(s) URL. */
  url: string;
  stars?: number;
  already_tracked: boolean;
  /** Local row id when already_tracked — the UI's "Go to row". */
  tool_id?: number;
  /** One line of where this result came from. Rendered on the card. */
  provenance: string;
  /** Track payload, or null when this item has no canonical identity. */
  track: TrackPayload | null;
  /** Why `track` is null. Shown as the disabled button's reason. */
  track_hint?: string;
}

export interface CatalogSourceStatus {
  id: CatalogSource;
  label: string;
  /** false = this source failed or is unavailable; `message` says why. */
  ok: boolean;
  count: number;
  message: string;
}

/**
 * GitHub's remaining allowance, straight from the response headers.
 * `resource` is GitHub's own `x-ratelimit-resource` ('search' vs 'core' are
 * separate buckets with different ceilings) — never inferred.
 */
export interface GithubQuota {
  resource: string | null;
  remaining: number | null;
  limit: number | null;
  /** ISO timestamp when the window resets. */
  reset: string | null;
}

export interface CatalogResults {
  items: CatalogItem[];
  /** One entry per source that was asked for, failures included. */
  sources: CatalogSourceStatus[];
  github_quota: GithubQuota;
  queried_at: string;
}

export interface CatalogQuery {
  /** Which sources to hit. Absent/empty = all of them. */
  sources?: CatalogSource[];
  /** Free-text filter. GitHub search is SKIPPED without one — an empty search
   *  would burn quota to return nothing useful. */
  q?: string;
  /** Per-source cap. Default 40, clamped to 1..100. */
  limit?: number;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Best-available error text; null when ok. */
  error: string | null;
}

/** Injectable process runner so tests never spawn docker. */
export type ExecRunner = (bin: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

export interface CatalogOpts {
  /** Injectable fetch so tests never hit the network. */
  fetchImpl?: typeof fetch;
  /** Injectable exec so tests never spawn a process. */
  execImpl?: ExecRunner;
  dockerBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

// --- OpResult helpers (same shape as ops.ts / trial.ts) ---

function ok<T>(message: string, data?: T): OpResult<T> {
  return data === undefined ? { ok: true, message } : { ok: true, message, data };
}

function fail<T = never>(message: string): OpResult<T> {
  return { ok: false, message };
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

/** The whole Docker catalog is ~8 MB of JSON today; execFile's 1 MB default
 *  would truncate it into a parse error that looks like a CLI bug. */
const CATALOG_MAX_BUFFER = 64 * 1024 * 1024;

const SOURCE_LABEL: Record<CatalogSource, string> = {
  docker: 'Docker MCP catalog',
  anthropic: 'Anthropic skills',
  github: 'GitHub search',
};

// --- small type guards ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Collapse whitespace and cap length — catalog blurbs run to paragraphs. */
function oneLine(text: string, max = 320): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// --- the local shelf (READ ONLY) ---

/**
 * One pass over tools + aliases, returning a lookup that answers "is any of
 * these identities already on the shelf?". Canonical keys win over aliases so
 * a stale alias can never point at the wrong row.
 */
function shelfMatcher(db: Db): (candidates: string[]) => number | undefined {
  const byKey = new Map<string, number>();
  for (const t of selectTools(db)) byKey.set(t.canonical_key.toLowerCase(), t.id);
  for (const row of db.prepare('SELECT tool_id, alias FROM aliases').all()) {
    const alias = typeof row.alias === 'string' ? row.alias.toLowerCase() : null;
    const id = Number(row.tool_id);
    if (alias !== null && Number.isInteger(id) && !byKey.has(alias)) byKey.set(alias, id);
  }
  return (candidates: string[]): number | undefined => {
    for (const c of candidates) {
      const hit = byKey.get(c.trim().toLowerCase());
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
}

/** Every spelling of a git URL that would collapse to the same row. */
function gitIdentities(url: string): string[] {
  const key = canonicalKeyForGitUrl(url);
  const out = key === null ? [] : [key];
  return [...out, ...aliasesForGitUrl(url)];
}

// --- process invocation ---

const execFileAsync = promisify(execFile);

/** docker ships as docker.exe on Windows, which execFile resolves from PATH
 *  without a shell — no .cmd shim is involved (unlike claude/codex). argv is
 *  always an ARRAY; nothing here is ever handed to a shell. */
const defaultExec: ExecRunner = async (bin, args, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: CATALOG_MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr, error: null };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const stderr = e.stderr ?? '';
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr,
      error: stderr.trim() || e.message?.trim() || String(err),
    };
  }
};

// --- source: Docker MCP catalog ---

/**
 * What the installed `docker mcp catalog` CLI actually supports, learned from
 * `--help` rather than assumed. PLAN.md §"Verified mechanism corrections":
 * "Every adapter probes `--help` at build time; none is written from memory."
 */
interface DockerSurface {
  hasServerLs: boolean;
  /** `server ls` takes an <oci-reference> positional argument. */
  takesRef: boolean;
  supportsJson: boolean;
  supportsFilter: boolean;
}

async function probeDocker(run: ExecRunner, bin: string, timeoutMs: number): Promise<DockerSurface | string> {
  const help = await run(bin, ['mcp', 'catalog', '--help'], timeoutMs);
  if (!help.ok) {
    return `docker mcp catalog is not available (${help.error ?? 'unknown error'}) — nothing was queried`;
  }
  const catalogHelp = `${help.stdout}\n${help.stderr}`;
  if (!/^\s*server\b/m.test(catalogHelp)) {
    return 'this docker mcp catalog build exposes no `server` command — cannot list catalog servers';
  }
  const lsHelp = await run(bin, ['mcp', 'catalog', 'server', 'ls', '--help'], timeoutMs);
  if (!lsHelp.ok) {
    return `docker mcp catalog server ls is not available (${lsHelp.error ?? 'unknown error'})`;
  }
  const text = `${lsHelp.stdout}\n${lsHelp.stderr}`;
  return {
    hasServerLs: true,
    takesRef: /Usage:.*server ls\s+</i.test(text),
    supportsJson: /--format/.test(text) && /json/i.test(text),
    supportsFilter: /--filter/.test(text),
  };
}

/** Catalog references from `docker mcp catalog list --format json`. */
async function dockerCatalogRefs(
  run: ExecRunner,
  bin: string,
  timeoutMs: number,
): Promise<string[]> {
  const res = await run(bin, ['mcp', 'catalog', 'list', '--format', 'json'], timeoutMs);
  if (!res.ok) return [];
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(entry => (isRecord(entry) ? str(entry.ref) : ''))
      .filter(ref => ref !== '');
  } catch {
    return [];
  }
}

/** `mcp/sqlite@sha256:…` → the Docker Hub page for that repository. */
function dockerHubUrl(image: string): string | null {
  const ref = image.split('@')[0].split(':')[0];
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(ref)
    ? `https://hub.docker.com/r/${ref}`
    : null;
}

const DOCKER_TRACK_HINT =
  'a Docker catalog server is identified by its image, not by a repo — OSM has no canonical key for it. ' +
  'Enable it in the Docker MCP Toolkit, or track its upstream repo by URL.';

function dockerItems(catalogRef: string, payload: unknown, q: string, limit: number): CatalogItem[] {
  const servers: unknown = isRecord(payload) ? payload.servers : payload;
  if (!Array.isArray(servers)) return [];
  const needle = q.toLowerCase();
  const items: CatalogItem[] = [];
  for (const entry of servers) {
    if (items.length >= limit) break;
    if (!isRecord(entry)) continue;
    const snapshot = isRecord(entry.snapshot) ? entry.snapshot : {};
    const server = isRecord(snapshot.server) ? snapshot.server : entry;
    const name = str(server.name) || str(server.title);
    if (name === '') continue;
    const description = oneLine(str(server.description) || str(server.title));
    if (needle !== '' && !`${name} ${description}`.toLowerCase().includes(needle)) continue;

    const image = str(server.image) || str(entry.image);
    const remote = isRecord(server.remote) ? str(server.remote.url) : '';
    const url = dockerHubUrl(image) ?? str(server.readme) ?? remote;
    const meta = isRecord(server.metadata) ? server.metadata : {};
    const stars = num(meta.githubStars) ?? num(meta.stars);
    const owner = str(meta.owner);

    const item: CatalogItem = {
      source: 'docker',
      name,
      description: description || 'No description in the catalog.',
      url: url === '' ? 'https://hub.docker.com/u/mcp' : url,
      already_tracked: false,
      provenance: [catalogRef, owner === '' ? null : `owner ${owner}`, image === '' ? null : image]
        .filter((x): x is string => x !== null)
        .join(' · '),
      track: null,
      track_hint: DOCKER_TRACK_HINT,
    };
    if (stars !== undefined) item.stars = stars;
    items.push(item);
  }
  return items;
}

async function queryDocker(
  q: string,
  limit: number,
  opts: CatalogOpts,
): Promise<{ items: CatalogItem[]; status: CatalogSourceStatus }> {
  const run = opts.execImpl ?? defaultExec;
  const bin = opts.dockerBin ?? process.env.OSM_DOCKER_BIN ?? 'docker';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const status = (okFlag: boolean, count: number, message: string): CatalogSourceStatus => ({
    id: 'docker',
    label: SOURCE_LABEL.docker,
    ok: okFlag,
    count,
    message,
  });

  const surface = await probeDocker(run, bin, timeoutMs);
  if (typeof surface === 'string') return { items: [], status: status(false, 0, surface) };
  if (!surface.supportsJson) {
    return {
      items: [],
      status: status(false, 0, 'this docker mcp build has no --format json on `catalog server ls` — refusing to scrape human output'),
    };
  }

  const refs = surface.takesRef ? await dockerCatalogRefs(run, bin, timeoutMs) : [''];
  if (refs.length === 0) {
    return { items: [], status: status(false, 0, 'no docker mcp catalogs are configured (`docker mcp catalog list` returned none)') };
  }

  const items: CatalogItem[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    if (items.length >= limit) break;
    const args = ['mcp', 'catalog', 'server', 'ls'];
    if (ref !== '') args.push(ref);
    // Push the filter down into the CLI when it supports one: the full catalog
    // is megabytes of JSON and this is a per-keystroke path.
    if (surface.supportsFilter && q !== '') args.push('--filter', `name=${q}`);
    args.push('--format', 'json');

    const res = await run(bin, args, timeoutMs);
    if (!res.ok) {
      errors.push(`${ref || 'default catalog'}: ${res.error ?? 'unknown error'}`);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(res.stdout);
      // The CLI filter is a name match; the free-text filter still has to run
      // locally so a description-only hit is not silently dropped.
      const filtered = dockerItems(ref, parsed, surface.supportsFilter ? '' : q, limit - items.length);
      items.push(...filtered);
    } catch (err) {
      errors.push(`${ref || 'default catalog'}: unreadable JSON (${errMsg(err)})`);
    }
  }

  if (items.length === 0 && errors.length > 0) {
    return { items, status: status(false, 0, `docker catalog read failed — ${errors.join('; ')}`) };
  }
  const note = errors.length > 0 ? ` (${errors.length} catalog(s) failed: ${errors.join('; ')})` : '';
  return { items, status: status(true, items.length, `${items.length} server(s) from ${refs.filter(Boolean).join(', ') || 'the default catalog'}${note}`) };
}

// --- GitHub REST plumbing (shared by the github + anthropic sources) ---

/**
 * Mirrors github.ts requestHeaders(); that one is module-private and github.ts
 * owns upstream release checks, not catalogs. GITHUB_TOKEN is read from the
 * environment and sent — never persisted, never echoed back.
 */
function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'osource-manager',
  };
  const token = env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function readQuota(headers: Headers): GithubQuota {
  const n = (key: string): number | null => {
    const raw = headers.get(key);
    if (raw === null) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const resetRaw = n('x-ratelimit-reset');
  return {
    resource: headers.get('x-ratelimit-resource'),
    remaining: n('x-ratelimit-remaining'),
    limit: n('x-ratelimit-limit'),
    reset: resetRaw === null ? null : new Date(resetRaw * 1000).toISOString(),
  };
}

function quotaNote(quota: GithubQuota): string {
  if (quota.remaining === null) return '';
  const bucket = quota.resource === null ? 'quota' : `${quota.resource} quota`;
  const of = quota.limit === null ? '' : `/${quota.limit}`;
  return ` · ${bucket} ${quota.remaining}${of} left`;
}

function rateLimitMessage(quota: GithubQuota): string {
  return (
    `github rate limit exhausted (remaining ${quota.remaining ?? 'unknown'}, ` +
    `resets ${quota.reset ?? 'unknown'}) — set GITHUB_TOKEN to raise it`
  );
}

// --- source: GitHub repository search ---

async function queryGithub(
  q: string,
  limit: number,
  match: (candidates: string[]) => number | undefined,
  opts: CatalogOpts,
): Promise<{ items: CatalogItem[]; status: CatalogSourceStatus; quota: GithubQuota | null }> {
  const status = (okFlag: boolean, count: number, message: string): CatalogSourceStatus => ({
    id: 'github',
    label: SOURCE_LABEL.github,
    ok: okFlag,
    count,
    message,
  });
  if (q.trim() === '') {
    // Unauthenticated search is 10 req/min. An empty search spends one of them
    // to return an arbitrary slice of GitHub, so it is simply not made.
    return { items: [], status: status(true, 0, 'type a filter to search GitHub — search costs rate limit, so it is not run blind'), quota: null };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const params = new URLSearchParams({
    q: q.trim(),
    sort: 'stars',
    order: 'desc',
    per_page: String(limit),
  });
  const url = `https://api.github.com/search/repositories?${params.toString()}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: githubHeaders(env) });
  } catch (err) {
    return { items: [], status: status(false, 0, `github search failed: ${errMsg(err)}`), quota: null };
  }

  const quota = readQuota(res.headers);
  if (res.status === 403 || res.status === 429) {
    return { items: [], status: status(false, 0, rateLimitMessage(quota)), quota };
  }
  if (!res.ok) {
    return { items: [], status: status(false, 0, `github search error: HTTP ${res.status}${quotaNote(quota)}`), quota };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { items: [], status: status(false, 0, `github search returned unreadable JSON (${errMsg(err)})`), quota };
  }
  const raw: unknown = isRecord(body) ? body.items : null;
  if (!Array.isArray(raw)) {
    return { items: [], status: status(false, 0, `github search returned an unexpected shape${quotaNote(quota)}`), quota };
  }

  const items: CatalogItem[] = [];
  for (const entry of raw.slice(0, limit)) {
    if (!isRecord(entry)) continue;
    const htmlUrl = str(entry.html_url);
    if (htmlUrl === '') continue;
    const fullName = str(entry.full_name) || str(entry.name);
    const toolId = match(gitIdentities(htmlUrl));
    const language = str(entry.language);
    const pushed = str(entry.pushed_at).slice(0, 10);
    const item: CatalogItem = {
      source: 'github',
      name: fullName,
      description: oneLine(str(entry.description)) || 'No description on the repo.',
      url: htmlUrl,
      already_tracked: toolId !== undefined,
      provenance: ['github search', language === '' ? null : language, pushed === '' ? null : `pushed ${pushed}`, entry.archived === true ? 'ARCHIVED' : null]
        .filter((x): x is string => x !== null)
        .join(' · '),
      track: { url: htmlUrl },
    };
    const stars = num(entry.stargazers_count);
    if (stars !== undefined) item.stars = stars;
    if (toolId !== undefined) item.tool_id = toolId;
    items.push(item);
  }

  const total = num(isRecord(body) ? body.total_count : undefined);
  const totalNote = total === undefined ? '' : ` of ${total} match(es)`;
  return { items, status: status(true, items.length, `${items.length}${totalNote}${quotaNote(quota)}`), quota };
}

// --- source: Anthropic skills ---

const SKILLS_REPO = 'anthropics/skills';
const SKILLS_DIR = 'skills';
const SKILLS_CONTENTS = `https://api.github.com/repos/${SKILLS_REPO}/contents/${SKILLS_DIR}`;

const SKILL_TRACK_HINT =
  'skills reach the shelf from your skills dirs, not from a URL — clone or copy the folder into a configured ' +
  'skills dir and hit Refresh. (Its canonical key would be skill:<name>, which Track cannot create from a URL.)';

/**
 * The `description:` line of a SKILL.md YAML frontmatter block. Parsed with a
 * line scanner rather than a YAML dependency (locked decision: one runtime
 * dep). Handles a plain value, a quoted value, and a folded `>`/`|` block.
 */
export function skillDescription(md: string): string {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return '';
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') return '';
    const m = /^description:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const head = m[1].trim();
    if (head !== '' && head !== '>' && head !== '|' && head !== '>-' && head !== '|-') {
      return oneLine(head.replace(/^["'](.*)["']$/s, '$1'));
    }
    // Folded/literal block: take the indented continuation lines.
    const parts: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '---') break;
      if (lines[j].trim() !== '' && !/^\s/.test(lines[j])) break;
      parts.push(lines[j].trim());
    }
    return oneLine(parts.join(' '));
  }
  return '';
}

async function queryAnthropic(
  q: string,
  limit: number,
  match: (candidates: string[]) => number | undefined,
  opts: CatalogOpts,
): Promise<{ items: CatalogItem[]; status: CatalogSourceStatus; quota: GithubQuota | null }> {
  const status = (okFlag: boolean, count: number, message: string): CatalogSourceStatus => ({
    id: 'anthropic',
    label: SOURCE_LABEL.anthropic,
    ok: okFlag,
    count,
    message,
  });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;

  let res: Response;
  try {
    res = await fetchImpl(SKILLS_CONTENTS, { headers: githubHeaders(env) });
  } catch (err) {
    return { items: [], status: status(false, 0, `anthropics/skills listing failed: ${errMsg(err)}`), quota: null };
  }

  const quota = readQuota(res.headers);
  if (res.status === 403 || res.status === 429) {
    return { items: [], status: status(false, 0, rateLimitMessage(quota)), quota };
  }
  if (!res.ok) {
    return { items: [], status: status(false, 0, `anthropics/skills contents API: HTTP ${res.status}${quotaNote(quota)}`), quota };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { items: [], status: status(false, 0, `anthropics/skills returned unreadable JSON (${errMsg(err)})`), quota };
  }
  if (!Array.isArray(body)) {
    return { items: [], status: status(false, 0, `anthropics/skills contents API returned an unexpected shape${quotaNote(quota)}`), quota };
  }

  const needle = q.trim().toLowerCase();
  const dirs = body
    .filter(isRecord)
    .filter(entry => str(entry.type) === 'dir')
    .map(entry => ({ name: str(entry.name), html: str(entry.html_url) }))
    .filter(d => d.name !== '' && !d.name.startsWith('.'))
    .filter(d => needle === '' || d.name.toLowerCase().includes(needle))
    .slice(0, limit);

  // Descriptions come from each SKILL.md's frontmatter over raw.githubusercontent,
  // which is NOT the API and costs no rate-limit quota. Best effort: a skill
  // whose README cannot be read still gets a card, just a thinner one.
  const described = await Promise.all(
    dirs.map(async d => {
      try {
        const r = await fetchImpl(
          `https://raw.githubusercontent.com/${SKILLS_REPO}/main/${SKILLS_DIR}/${d.name}/SKILL.md`,
        );
        if (!r.ok) return '';
        return skillDescription(await r.text());
      } catch {
        return '';
      }
    }),
  );

  const items: CatalogItem[] = dirs.map((d, i) => {
    const toolId = match([canonicalKeyForSkill(d.name)]);
    const item: CatalogItem = {
      source: 'anthropic',
      name: d.name,
      description: described[i] || 'Skill in anthropics/skills — open it to read SKILL.md.',
      url: d.html || `https://github.com/${SKILLS_REPO}/tree/main/${SKILLS_DIR}/${d.name}`,
      already_tracked: toolId !== undefined,
      provenance: `${SKILLS_REPO} · ${SKILLS_DIR}/${d.name}`,
      track: null,
      track_hint: SKILL_TRACK_HINT,
    };
    if (toolId !== undefined) item.tool_id = toolId;
    return item;
  });

  const skipped = needle === '' ? '' : ` matching "${q.trim()}"`;
  return { items, status: status(true, items.length, `${items.length} skill(s)${skipped}${quotaNote(quota)}`), quota };
}

// --- the one entry point ---

/**
 * Query the selected public catalogs live and mark what is already on the
 * shelf. Never throws: a failing source becomes an ok:false entry in
 * `sources` and the rest of the page still renders.
 */
export async function searchCatalogs(
  db: Db,
  query: CatalogQuery = {},
  opts: CatalogOpts = {},
): Promise<OpResult<CatalogResults>> {
  try {
    // An explicit [] means "nothing selected" (every catalog off in Settings)
    // and must stay empty; only an ABSENT `sources` falls back to all of them.
    const selected = query.sources;
    const wanted =
      selected === undefined
        ? [...ALL_CATALOG_SOURCES]
        : ALL_CATALOG_SOURCES.filter(s => selected.includes(s));
    const q = (query.q ?? '').trim();
    const limit = clampLimit(query.limit);
    const match = shelfMatcher(db);

    const results = await Promise.all(
      wanted.map(async source => {
        try {
          if (source === 'docker') {
            const r = await queryDocker(q, limit, opts);
            return { ...r, quota: null as GithubQuota | null };
          }
          if (source === 'github') return await queryGithub(q, limit, match, opts);
          return await queryAnthropic(q, limit, match, opts);
        } catch (err) {
          // Belt and braces: a source must never take the page down.
          return {
            items: [] as CatalogItem[],
            status: { id: source, label: SOURCE_LABEL[source], ok: false, count: 0, message: `${source} source failed: ${errMsg(err)}` },
            quota: null as GithubQuota | null,
          };
        }
      }),
    );

    const items = results.flatMap(r => r.items);
    const sources = results.map(r => r.status);
    // The search and core buckets are separate; prefer whichever the GitHub
    // search reported, since that is the one Browse burns fastest.
    const quotas = results.map(r => r.quota).filter((x): x is GithubQuota => x !== null);
    const github_quota =
      quotas.find(x => x.resource === 'search') ??
      quotas[0] ?? { resource: null, remaining: null, limit: null, reset: null };

    const failed = sources.filter(s => !s.ok);
    const message =
      `${items.length} result(s) from ${sources.length - failed.length}/${sources.length} source(s)` +
      (failed.length > 0 ? ` · unavailable: ${failed.map(s => s.id).join(', ')}` : '');

    return ok(message, { items, sources, github_quota, queried_at: now() });
  } catch (err) {
    return fail(`catalog search failed: ${errMsg(err)}`);
  }
}
