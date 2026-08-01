import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { Settings, Tool, ToolKind } from './types.js';
import {
  type Db,
  type ScanSource,
  type SeenInstallation,
  addAlias,
  addEvent,
  findToolByAlias,
  insertTool,
  replaceInstallationsForScan,
  rowToTool,
  selectToolByCanonicalKey,
  selectTools,
  upsertObservations,
  upsertTag,
  withTransaction,
} from './db.js';
import {
  aliasesForGitUrl,
  canonicalKeyForGitUrl,
  canonicalKeyForLocal,
  canonicalKeyForNpm,
  canonicalKeyForSkill,
  nameFromCanonicalKey,
} from './canonical.js';

/**
 * Machine discovery: scans disks, package managers, skills dirs, docker, and
 * IMPORTED.md, then reconciles into the registry.
 *
 * Sacred rule: discovery writes ONLY installations/observations and creates
 * NEW tool rows. It never updates owned fields (verdict, why_i_want_it,
 * retire_reason, favorite, user comments) on existing rows, and it is
 * idempotent — repeat runs produce the same rows.
 *
 * Transaction note: replaceInstallationsForScan opens its own transaction and
 * SQLite forbids nested BEGIN, so the scan is split into (a) one atomic
 * row-creation/alias/event phase and (b) per-tool/per-source installation
 * reconciliation, each atomic on its own.
 */

export interface ImportedEntry {
  name: string;
  url: string | null;
  deleted: boolean;
  note: string | null;
}

export interface DiscoveryReport {
  repos: number;
  globalClis: number;
  skills: number;
  binaries: number;
  dockerContainers: number;
  importedSeed: number;
  errors: string[];
}

export interface DiscoveryOpts {
  importedPath?: string;
  /** Reserved for deterministic timestamps; currently informational only. */
  now?: string;
  /** Skip scanners that shell out to real machine tools (used by tests). */
  skip?: { npm?: boolean; winget?: boolean; docker?: boolean };
  /** Test hook: parse this text instead of shelling out to `winget list`. */
  wingetListFixture?: string;
}

const DEFAULT_IMPORTED_PATH = 'D:\\dev\\tools\\IMPORTED.md';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a command, returning trimmed stdout or null on any failure. Stdout is kept even on non-zero exit (npm ls does that). */
function tryExec(cmd: string, args: string[], timeoutMs = 15000, shell = false): string | null {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      shell,
    });
    return out.trim();
  } catch (err) {
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    if (stdout && String(stdout).trim()) return String(stdout).trim();
    return null;
  }
}

/**
 * Run a single static command string through the shell (needed for .cmd
 * shims like npm on Windows — CVE-2024-27980 blocks execFile on .cmd without
 * a shell). Deliberately takes NO args array: shell:true plus an args array
 * trips Node's DEP0190 warning; a literal command string with no
 * user-controlled content does not.
 */
function tryShell(command: string, timeoutMs = 15000): string | null {
  try {
    const out = execFileSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      shell: true,
    });
    return out.trim();
  } catch (err) {
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    if (stdout && String(stdout).trim()) return String(stdout).trim();
    return null;
  }
}

// --- pending-tool sink (dedup + merge before touching the DB) ---

interface PendingInstall {
  source: ScanSource;
  seen: SeenInstallation;
}

interface PendingTool {
  createKey: string;
  name: string;
  kind: ToolKind;
  source: string;
  /** Keys tried in order against canonical_key and aliases to find an existing row. */
  matchKeys: string[];
  addAliases: string[];
  eventOnCreate: string | null;
  whyOnCreate: string | null;
  /** Machine-detected tags (detected=1), upserted on every scan — idempotent. */
  detectedTags: string[];
  installs: PendingInstall[];
}

class Sink {
  private byKey = new Map<string, PendingTool>();

  add(p: PendingTool): void {
    const existing = this.byKey.get(p.createKey);
    if (!existing) {
      this.byKey.set(p.createKey, p);
      return;
    }
    for (const k of p.matchKeys) if (!existing.matchKeys.includes(k)) existing.matchKeys.push(k);
    for (const a of p.addAliases) if (!existing.addAliases.includes(a)) existing.addAliases.push(a);
    for (const t of p.detectedTags) if (!existing.detectedTags.includes(t)) existing.detectedTags.push(t);
    for (const i of p.installs) {
      if (!existing.installs.some(x => x.source === i.source && x.seen.where_ === i.seen.where_)) {
        existing.installs.push(i);
      }
    }
    if (!existing.eventOnCreate) existing.eventOnCreate = p.eventOnCreate;
    if (!existing.whyOnCreate) existing.whyOnCreate = p.whyOnCreate;
  }

  entries(): PendingTool[] {
    return [...this.byKey.values()];
  }
}

// --- git helpers ---

function gitRemoteUrl(dir: string): string | null {
  const out = tryExec('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  if (out) {
    const first = out.split(/\r?\n/)[0].trim();
    if (first) return first;
  }
  // Fallback: parse .git/config by hand (works without git on PATH).
  try {
    const cfg = readFileSync(join(dir, '.git', 'config'), 'utf8');
    const section = cfg.match(/\[remote "origin"\]([^[]*)/);
    const url = section?.[1].match(/^\s*url\s*=\s*(\S+)\s*$/m);
    if (url) return url[1].trim();
  } catch {
    // no readable config — no remote
  }
  return null;
}

function gitVersion(dir: string): string | null {
  const desc = tryExec('git', ['-C', dir, 'describe', '--tags', '--always']);
  if (desc) return desc.split(/\r?\n/)[0].trim() || null;
  const sha = tryExec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
  return sha ? sha.split(/\r?\n/)[0].trim() || null : null;
}

/** Git repos under a scan dir: the dir itself plus two levels below (pruned at .git). */
function findGitRepos(scanDir: string): string[] {
  const repos: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (existsSync(join(dir, '.git'))) {
      repos.push(dir);
      return;
    }
    if (depth >= 2) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(scanDir, 0);
  return repos;
}

// --- scanners (populate the sink; no DB writes) ---

function scanRepos(settings: Settings, report: DiscoveryReport, sink: Sink): void {
  for (const scanDir of settings.scanDirs) {
    if (!existsSync(scanDir)) continue;
    for (const dir of findGitRepos(scanDir)) {
      try {
        const url = gitRemoteUrl(dir);
        const version = gitVersion(dir);
        const abs = resolve(dir);
        const gitKey = url ? canonicalKeyForGitUrl(url) : null;
        const createKey = gitKey ?? canonicalKeyForLocal(abs);
        const aliases = url ? aliasesForGitUrl(url) : [];
        sink.add({
          createKey,
          name: gitKey ? nameFromCanonicalKey(gitKey) : basename(abs),
          kind: 'repo',
          source: `scan:${scanDir}`,
          matchKeys: [createKey, ...aliases],
          addAliases: [createKey, ...aliases],
          eventOnCreate: null,
          whyOnCreate: null,
          detectedTags: [],
          installs: [{ source: 'disk', seen: { where_: abs, version_local: version } }],
        });
        report.repos++;
      } catch (err) {
        report.errors.push(`repos: ${dir}: ${errMsg(err)}`);
      }
    }
  }
}

function scanSkills(settings: Settings, report: DiscoveryReport, sink: Sink): void {
  for (const skillsDir of settings.skillsDirs) {
    if (!existsSync(skillsDir)) continue;
    let entries;
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true });
    } catch (err) {
      report.errors.push(`skills: ${skillsDir}: ${errMsg(err)}`);
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(skillsDir, e.name);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      try {
        const abs = resolve(dir);
        const skillKey = canonicalKeyForSkill(e.name);
        const url = existsSync(join(dir, '.git')) ? gitRemoteUrl(dir) : null;
        const gitKey = url ? canonicalKeyForGitUrl(url) : null;
        const gitAliases = url ? aliasesForGitUrl(url) : [];
        // A skill that is itself a clone of an already-known repo is the SAME
        // tool: match the git identity first, create a skill row only if unseen.
        sink.add({
          createKey: skillKey,
          name: e.name,
          kind: 'skill',
          source: 'skills-dir',
          matchKeys: gitKey ? [gitKey, ...gitAliases, skillKey] : [skillKey],
          addAliases: [skillKey, ...(gitKey ? [gitKey, ...gitAliases] : [])],
          eventOnCreate: null,
          whyOnCreate: null,
          detectedTags: [],
          // where_ 'skills-dir:<absdir>' is disk-scoped for reconciliation
          // (db's named-source scope matches 'skills-dir' exactly only).
          installs: [{ source: 'disk', seen: { where_: `skills-dir:${abs}`, version_local: null } }],
        });
        report.skills++;
      } catch (err) {
        report.errors.push(`skills: ${dir}: ${errMsg(err)}`);
      }
    }
  }
}

function scanBinaries(settings: Settings, report: DiscoveryReport, sink: Sink): void {
  for (const scanDir of settings.scanDirs) {
    if (!existsSync(scanDir)) continue;
    if (existsSync(join(scanDir, '.git'))) continue; // scanDir is itself a repo
    let entries;
    try {
      entries = readdirSync(scanDir, { withFileTypes: true });
    } catch (err) {
      report.errors.push(`binaries: ${scanDir}: ${errMsg(err)}`);
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.exe$/i.test(e.name)) continue;
      try {
        const abs = resolve(join(scanDir, e.name));
        const key = canonicalKeyForLocal(abs);
        sink.add({
          createKey: key,
          name: e.name.replace(/\.exe$/i, ''),
          kind: 'binary',
          source: `scan:${scanDir}`,
          matchKeys: [key],
          addAliases: [key],
          eventOnCreate: null,
          whyOnCreate: null,
          detectedTags: [],
          installs: [{ source: 'disk', seen: { where_: abs, version_local: null } }],
        });
        report.binaries++;
      } catch (err) {
        report.errors.push(`binaries: ${join(scanDir, e.name)}: ${errMsg(err)}`);
      }
    }
  }
}

function scanNpm(report: DiscoveryReport, sink: Sink): void {
  // On Windows the runnable is npm.cmd; execFile('npm') gets ENOENT there and
  // .cmd shims need a shell on patched Node (CVE-2024-27980). tryShell passes
  // a static command string with no args array, which avoids DEP0190.
  const out = tryShell('npm ls -g --json --depth=0', 60000);
  if (out === null) {
    report.errors.push('npm: not available');
    return;
  }
  let parsed: { dependencies?: Record<string, { version?: string }> };
  try {
    parsed = JSON.parse(out);
  } catch {
    report.errors.push('npm: could not parse `npm ls -g --json` output');
    return;
  }
  for (const [pkg, info] of Object.entries(parsed.dependencies ?? {})) {
    try {
      const key = canonicalKeyForNpm(pkg);
      sink.add({
        createKey: key,
        name: pkg,
        kind: 'global-cli',
        source: 'npm-g',
        matchKeys: [key],
        addAliases: [key, pkg],
        eventOnCreate: null,
        whyOnCreate: null,
        detectedTags: [],
        installs: [{ source: 'npm-g', seen: { where_: 'npm-g', version_local: info.version ?? null } }],
      });
      report.globalClis++;
    } catch (err) {
      report.errors.push(`npm: ${pkg}: ${errMsg(err)}`);
    }
  }
}

// --- winget: MSIX normalization + system classification ---

export interface WingetEntry {
  name: string;
  /** Id exactly as winget reported it (may be MSIX\...). */
  rawId: string;
  /** Canonical Id: MSIX prefix + version/arch/publisher-hash suffix stripped. */
  id: string;
  version: string;
  system: boolean;
}

/** Trailing `_<version>_<arch>__<publisherHash>` or `_<arch>__<publisherHash>` of an MSIX package full name. */
const MSIX_SUFFIX = /_(?:\d+(?:\.\d+)*_)?(?:x86|x64|arm64|arm|neutral)__[0-9a-z]+$/i;

/**
 * winget lists MSIX-packaged apps twice: once as the classic installer entry
 * (`ZedIndustries.Zed`) and once as the package full name
 * (`MSIX\ZedIndustries.Zed_1.0.0.0_x64__8wekyb3d8bbwe`). Normalize the MSIX
 * form back to the plain package Id so both collapse to ONE canonical key —
 * the same reconciliation class as SSH-vs-HTTPS git remotes.
 */
export function normalizeWingetId(rawId: string): string {
  if (!/^msix\\/i.test(rawId)) return rawId;
  const stripped = rawId.replace(/^msix\\/i, '').replace(MSIX_SUFFIX, '');
  return stripped || rawId; // never normalize to an empty key
}

/**
 * Dev-tool exceptions under vendor prefixes — checked FIRST, never 'system'.
 * (DotNet.SDK is intentionally a prefix: it covers Microsoft.DotNet.SDK.8, .9, ...)
 */
const SYSTEM_DENY_PREFIXES = [
  'microsoft.visualstudiocode',
  'microsoft.powertoys',
  'microsoft.windowsterminal',
  'microsoft.git',
  'microsoft.dotnet.sdk',
];

/**
 * 'system' heuristic: OS/vendor components that arrive with the machine or a
 * driver suite — Microsoft.* (minus the dev tools above), every MSIX-derived
 * Id (OS-delivered packaging), and hardware/vendor prefixes. Consumer apps
 * (Discord, Brave, Spotify, ...) stay UNTAGGED: they are plausibly acquired
 * tools, not OS noise. Data-driven: extend the lists, not the logic.
 */
const SYSTEM_PREFIXES = [
  'microsoft.',
  'apple.',
  'google.chrome',
  'intel.',
  'dell.',
  'nvidia.',
  'realtek',
  'dolby',
];

export function isSystemWingetEntry(rawId: string, normalizedId: string): boolean {
  const id = normalizedId.toLowerCase();
  if (SYSTEM_DENY_PREFIXES.some(p => id.startsWith(p))) return false;
  if (/^msix\\/i.test(rawId)) return true;
  return SYSTEM_PREFIXES.some(p => id.startsWith(p));
}

/** Parse `winget list` table output (header + dashed separator, then 2+-space-separated columns). */
export function parseWingetEntries(out: string): WingetEntry[] {
  const entries: WingetEntry[] = [];
  let started = false;
  for (const line of out.split(/\r?\n/)) {
    if (!started) {
      // header is followed by a dashed separator line ("-----  --  -------")
      if (/^(?:-+\s*)+$/.test(line.trim())) started = true;
      continue;
    }
    const cols = line.trim().split(/\s{2,}/).filter(Boolean);
    if (cols.length < 3) continue;
    const [name, rawId, version] = cols;
    const id = normalizeWingetId(rawId);
    entries.push({ name, rawId, id, version, system: isSystemWingetEntry(rawId, id) });
  }
  return entries;
}

function scanWinget(report: DiscoveryReport, sink: Sink, fixture?: string): void {
  const out = fixture ?? tryExec('winget', ['list', '--disable-interactivity'], 120000);
  if (out === null) {
    report.errors.push('winget: not available or failed');
    return;
  }
  const entries = parseWingetEntries(out);
  // Collapse MSIX dupe + classic entry of the same product into ONE pending
  // row before touching the sink. The classic entry (when present) wins for
  // name, version, and classification — otherwise a consumer app shipped both
  // ways (Zed) would inherit the MSIX entry's 'system' tag.
  const byId = new Map<string, WingetEntry[]>();
  for (const e of entries) {
    const group = byId.get(e.id);
    if (group) group.push(e);
    else byId.set(e.id, [e]);
  }
  for (const [id, group] of byId) {
    try {
      const primary = group.find(e => !/^msix\\/i.test(e.rawId)) ?? group[0];
      const key = `winget:${id}`;
      const keys = [...new Set([key, ...group.map(e => `winget:${e.rawId}`)])];
      sink.add({
        createKey: key,
        name: primary.name,
        kind: 'global-cli',
        source: 'winget',
        matchKeys: keys,
        addAliases: keys,
        eventOnCreate: null,
        whyOnCreate: null,
        detectedTags: primary.system ? ['system'] : [],
        installs: [{ source: 'winget', seen: { where_: 'winget', version_local: primary.version } }],
      });
      report.globalClis += group.length;
    } catch (err) {
      report.errors.push(`winget: ${id}: ${errMsg(err)}`);
    }
  }
}

// --- IMPORTED.md ---

/**
 * Parse the hand-written origin-trace markdown. Designed against the real
 * D:\dev\tools\IMPORTED.md: a table of `| `name` | upstream | note |` rows.
 * A row is "deleted" when its text says so (e.g. "**Deleted 2026-07-31**").
 */
export function parseImportedMarkdown(content: string): ImportedEntry[] {
  const entries: ImportedEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    const name = cells[0].replace(/`/g, '').trim();
    if (!name || /^item$/i.test(name)) continue; // header
    if (/^:?-{2,}:?$/.test(cells[0].replace(/\s/g, ''))) continue; // separator
    const rowText = cells.join(' | ');
    const urlMatch = rowText.match(/https?:\/\/[^\s|)`]+/);
    const noteCell = cells.length >= 3 ? cells.slice(2).join(' | ') : cells[1];
    const note = noteCell
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim() || null;
    entries.push({
      name,
      url: urlMatch ? urlMatch[0] : null,
      deleted: /\bdeleted\b/i.test(rowText),
      note,
    });
  }
  return entries;
}

function seedImported(report: DiscoveryReport, sink: Sink, importedPath: string): void {
  if (!existsSync(importedPath)) return; // missing file: skip silently
  const content = readFileSync(importedPath, 'utf8');
  for (const entry of parseImportedMarkdown(content)) {
    if (!entry.url) continue; // no upstream URL — nothing to track (e.g. obscura)
    try {
      const key = canonicalKeyForGitUrl(entry.url);
      if (!key) {
        report.errors.push(`imported: ${entry.name}: unrecognized URL ${entry.url}`);
        continue;
      }
      const aliases = aliasesForGitUrl(entry.url);
      // Deleted-on-disk entries still get a row — tracked, but with NO
      // installation (the deleted-but-tracked CL4R1T4S case).
      sink.add({
        createKey: key,
        name: nameFromCanonicalKey(key),
        kind: 'repo',
        source: 'IMPORTED.md',
        matchKeys: [key, ...aliases],
        addAliases: [key, ...aliases],
        eventOnCreate: entry.deleted
          ? 'seeded from IMPORTED.md (marked deleted on disk; tracked without installation)'
          : 'seeded from IMPORTED.md',
        whyOnCreate: entry.note,
        detectedTags: [],
        installs: [],
      });
      report.importedSeed++;
    } catch (err) {
      report.errors.push(`imported: ${entry.name}: ${errMsg(err)}`);
    }
  }
}

// --- docker (reads live tools; runs after the write phase) ---

function scanDocker(db: Db, report: DiscoveryReport): void {
  const out = tryExec('docker', ['ps', '--format', 'json'], 20000);
  if (out === null) {
    report.errors.push('docker: not available or failed');
    return;
  }
  const index = new Map<string, number>();
  for (const t of selectTools(db)) {
    index.set(t.name.toLowerCase(), t.id);
    const tail = t.canonical_key.split(/[/:]/).pop()?.toLowerCase();
    if (tail && !index.has(tail)) index.set(tail, t.id);
  }
  for (const line of out.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let container: { Image?: string; Labels?: string };
    try {
      container = JSON.parse(s);
    } catch {
      continue;
    }
    report.dockerContainers++;
    // image name heuristic: strip registry, tag and digest → basename
    const base = String(container.Image ?? '').split('@')[0];
    const short = (base.split('/').pop() ?? base).split(':')[0].toLowerCase();
    if (!short) continue;
    const toolId = index.get(short);
    if (toolId === undefined) continue; // no match → skip, never create rows
    const labels = String(container.Labels ?? '');
    const trial = /(^|,)\s*osm\.trial(\s*=|,|$)/.test(labels) ? 1 : 0;
    try {
      upsertObservations(db, toolId, { trial_running: trial });
    } catch (err) {
      report.errors.push(`docker: ${short}: ${errMsg(err)}`);
    }
  }
}

// --- entry point ---

/**
 * One-off cleanup for the Phase-1 reconciliation bug: MSIX winget entries were
 * imported under `winget:MSIX\<name>_<ver>_<arch>__<hash>` keys while the same
 * product's classic entry got `winget:<name>`. When the normalized key of an
 * MSIX row matches an existing classic row, merge the dupe INTO the classic
 * row (installations, aliases, tags, comments, trials, observations re-pointed;
 * dupe row DELETEd) and journal the merge on the survivor. Idempotent — after
 * the first run there is nothing left to merge.
 */
function mergeMsixDuplicateRows(db: Db, report: DiscoveryReport): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`SELECT * FROM tools WHERE canonical_key LIKE 'winget:MSIX\\%'`).all();
  } catch (err) {
    report.errors.push(`msix-merge: ${errMsg(err)}`);
    return;
  }
  for (const row of rows) {
    const dupe = rowToTool(row);
    const rawId = dupe.canonical_key.slice('winget:'.length);
    const normalizedKey = `winget:${normalizeWingetId(rawId)}`;
    if (normalizedKey === dupe.canonical_key) continue; // could not normalize — leave it
    const survivor = selectToolByCanonicalKey(db, normalizedKey);
    if (!survivor || survivor.id === dupe.id) continue;
    try {
      withTransaction(db, () => {
        // Installations: re-point, but keep the classic row's own version when
        // both hold the same where_ (dupe's copy is dropped).
        for (const inst of db.prepare('SELECT id, where_ FROM installations WHERE tool_id = ?').all(dupe.id)) {
          const clash = db.prepare('SELECT id FROM installations WHERE tool_id = ? AND where_ = ?')
            .get(survivor.id, inst.where_ as string);
          if (clash) {
            db.prepare('DELETE FROM installations WHERE id = ?').run(inst.id as number);
          } else {
            db.prepare('UPDATE installations SET tool_id = ? WHERE id = ?').run(survivor.id, inst.id as number);
          }
        }
        db.prepare('UPDATE OR IGNORE aliases SET tool_id = ? WHERE tool_id = ?').run(survivor.id, dupe.id);
        db.prepare('DELETE FROM aliases WHERE tool_id = ?').run(dupe.id); // conflicting leftovers
        addAlias(db, survivor.id, dupe.canonical_key); // raw MSIX key stays findable
        db.prepare('UPDATE comments SET tool_id = ? WHERE tool_id = ?').run(survivor.id, dupe.id);
        db.prepare('UPDATE trials SET tool_id = ? WHERE tool_id = ?').run(survivor.id, dupe.id);
        db.prepare(
          'INSERT OR IGNORE INTO tags (tool_id, tag, detected) SELECT ?, tag, detected FROM tags WHERE tool_id = ?',
        ).run(survivor.id, dupe.id);
        db.prepare('DELETE FROM tags WHERE tool_id = ?').run(dupe.id);
        const dupeObs = db.prepare('SELECT tool_id FROM observations WHERE tool_id = ?').get(dupe.id);
        if (dupeObs) {
          const survivorObs = db.prepare('SELECT tool_id FROM observations WHERE tool_id = ?').get(survivor.id);
          if (survivorObs) {
            db.prepare('DELETE FROM observations WHERE tool_id = ?').run(dupe.id);
          } else {
            db.prepare('UPDATE observations SET tool_id = ? WHERE tool_id = ?').run(survivor.id, dupe.id);
          }
        }
        db.prepare('DELETE FROM tools WHERE id = ?').run(dupe.id);
        addEvent(db, survivor.id, `merged MSIX duplicate: ${dupe.canonical_key}`);
      });
    } catch (err) {
      report.errors.push(`msix-merge: ${dupe.canonical_key}: ${errMsg(err)}`);
    }
  }
}

/**
 * Flip present=0 for installations whose tool produced no pending entry this
 * run, limited to scopes actually scanned: 'npm-g'/'winget' when those
 * scanners ran, and disk paths (incl. 'skills-dir:<path>') under the
 * configured scanDirs/skillsDirs.
 */
function reconcileVanished(
  db: Db,
  settings: Settings,
  opts: DiscoveryOpts,
  reconciled: Set<string>,
  report: DiscoveryReport,
): void {
  const diskRoots = [...settings.scanDirs, ...settings.skillsDirs]
    .filter(d => existsSync(d))
    .map(d => resolve(d).toLowerCase());
  const ranNpm = !opts.skip?.npm;
  const ranWinget = !opts.skip?.winget;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare('SELECT tool_id, where_ FROM installations WHERE present = 1').all();
  } catch (err) {
    report.errors.push(`reconcile: ${errMsg(err)}`);
    return;
  }
  const vanished = new Map<string, { toolId: number; source: ScanSource }>();
  for (const row of rows) {
    const toolId = row.tool_id as number;
    const where_ = row.where_ as string;
    let source: ScanSource | null = null;
    if (where_ === 'npm-g') {
      if (ranNpm) source = 'npm-g';
    } else if (where_ === 'winget') {
      if (ranWinget) source = 'winget';
    } else if (where_ !== 'skills-dir') {
      const p = where_.startsWith('skills-dir:') ? where_.slice('skills-dir:'.length) : where_;
      const norm = resolve(p).toLowerCase();
      if (diskRoots.some(r => norm === r || norm.startsWith(r + sep))) source = 'disk';
    }
    if (!source || reconciled.has(`${toolId}|${source}`)) continue;
    vanished.set(`${toolId}|${source}`, { toolId, source });
  }
  for (const { toolId, source } of vanished.values()) {
    try {
      replaceInstallationsForScan(db, toolId, source, []);
    } catch (err) {
      report.errors.push(`reconcile: tool ${toolId} (${source}): ${errMsg(err)}`);
    }
  }
}

export function runDiscovery(db: Db, settings: Settings, opts: DiscoveryOpts = {}): DiscoveryReport {
  const report: DiscoveryReport = {
    repos: 0,
    globalClis: 0,
    skills: 0,
    binaries: 0,
    dockerContainers: 0,
    importedSeed: 0,
    errors: [],
  };
  const sink = new Sink();

  // Legacy cleanup: collapse MSIX-keyed dupe rows created before winget Ids
  // were normalized (see mergeMsixDuplicateRows). Runs before the scan so the
  // current scan reconciles onto the surviving rows.
  mergeMsixDuplicateRows(db, report);

  const scanners: Array<() => void> = [
    () => scanRepos(settings, report, sink),
    () => scanSkills(settings, report, sink),
    () => scanBinaries(settings, report, sink),
    () => {
      if (!opts.skip?.npm) scanNpm(report, sink);
    },
    () => {
      if (!opts.skip?.winget) scanWinget(report, sink, opts.wingetListFixture);
    },
    () => seedImported(report, sink, opts.importedPath ?? DEFAULT_IMPORTED_PATH),
  ];
  for (const scan of scanners) {
    try {
      scan();
    } catch (err) {
      report.errors.push(errMsg(err));
    }
  }

  // Phase 1: create/reuse rows + aliases + seed events, atomically.
  const resolved = new Map<PendingTool, Tool>();
  try {
    withTransaction(db, () => {
      for (const p of sink.entries()) {
        let tool: Tool | undefined;
        for (const k of p.matchKeys) {
          tool = selectToolByCanonicalKey(db, k) ?? findToolByAlias(db, k);
          if (tool) break;
        }
        if (!tool) {
          tool = insertTool(db, {
            canonical_key: p.createKey,
            name: p.name,
            kind: p.kind,
            verdict: 'wanted',
            why_i_want_it: p.whyOnCreate,
            source: p.source,
          });
          if (p.eventOnCreate) addEvent(db, tool.id, p.eventOnCreate);
        }
        for (const a of p.addAliases) addAlias(db, tool.id, a);
        // Machine-detected tags are discovery-owned (detected=1) and the
        // upsert is idempotent, so re-tagging every scan is safe.
        for (const t of p.detectedTags) upsertTag(db, tool.id, t, 1);
        resolved.set(p, tool);
      }
    });
  } catch (err) {
    report.errors.push(`write: ${errMsg(err)}`);
  }

  // Phase 2: installation reconciliation per tool + scan source. Un-seen rows
  // flip present=0 but survive (replaceInstallationsForScan is atomic per call).
  const groups = new Map<number, Map<ScanSource, SeenInstallation[]>>();
  for (const [p, tool] of resolved) {
    for (const inst of p.installs) {
      let bySource = groups.get(tool.id);
      if (!bySource) groups.set(tool.id, (bySource = new Map()));
      let seen = bySource.get(inst.source);
      if (!seen) bySource.set(inst.source, (seen = []));
      if (!seen.some(s => s.where_ === inst.seen.where_)) seen.push(inst.seen);
    }
  }
  const reconciled = new Set<string>();
  for (const [toolId, bySource] of groups) {
    for (const [source, seen] of bySource) {
      try {
        replaceInstallationsForScan(db, toolId, source, seen);
        reconciled.add(`${toolId}|${source}`);
      } catch (err) {
        report.errors.push(`installations: tool ${toolId} (${source}): ${errMsg(err)}`);
      }
    }
  }

  // Phase 3: tools that vanished entirely (deleted repo dir, uninstalled
  // package) produce no pending entry, so phase 2 never touches them. Flip
  // their still-present installations to 0 — but only within scopes this run
  // actually scanned (paths under the configured roots, sources not skipped).
  reconcileVanished(db, settings, opts, reconciled, report);

  if (!opts.skip?.docker) {
    try {
      scanDocker(db, report);
    } catch (err) {
      report.errors.push(`docker: ${errMsg(err)}`);
    }
  }

  return report;
}
