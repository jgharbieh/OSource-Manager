import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Tool,
  ToolKind,
  Verdict,
  Installation,
  Observations,
  Tag,
  Comment,
  Trial,
  ToolView,
} from './types.js';

/**
 * Minimal DB interface behind which the whole layer sits. DatabaseSync
 * satisfies it structurally; better-sqlite3 could be adapted later.
 */
export interface DbStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface Db {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY,
    canonical_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    verdict TEXT NOT NULL,
    why_i_want_it TEXT,
    retire_reason TEXT,
    favorite INTEGER DEFAULT 0,
    auto_update INTEGER DEFAULT 0,
    source TEXT,
    added_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS aliases (
    tool_id INTEGER NOT NULL,
    alias TEXT UNIQUE NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS installations (
    id INTEGER PRIMARY KEY,
    tool_id INTEGER NOT NULL,
    where_ TEXT,
    version_local TEXT,
    present INTEGER,
    last_seen_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS observations (
    tool_id INTEGER PRIMARY KEY,
    serving_count INTEGER DEFAULT 0,
    trial_running INTEGER DEFAULT 0,
    version_upstream TEXT,
    update_available INTEGER DEFAULT 0,
    upstream_checked_at TEXT,
    feed_etag TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tags (
    tool_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    detected INTEGER DEFAULT 1,
    PRIMARY KEY (tool_id, tag)
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    tool_id INTEGER NOT NULL,
    kind TEXT CHECK(kind IN ('user','event')),
    body TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS trials (
    id INTEGER PRIMARY KEY,
    trial_uid TEXT UNIQUE,
    tool_id INTEGER NOT NULL,
    container TEXT,
    image TEXT,
    ports TEXT,
    image_created_by_osm INTEGER DEFAULT 0,
    volumes_created_by_osm TEXT DEFAULT '[]',
    started_at TEXT,
    ended_at TEXT,
    outcome TEXT
  )`,
];

export function openDb(dbPath: string): DatabaseSync {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Web server and stdio MCP processes write concurrently to the same file.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  for (const sql of MIGRATIONS) db.exec(sql);
  return db;
}

/** ISO-ish local timestamp: "YYYY-MM-DD HH:MM:SS". */
export function now(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Wraps fn in BEGIN IMMEDIATE / COMMIT / ROLLBACK so a mutation and its journal event land atomically. */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

type Row = Record<string, unknown>;

export function rowToTool(row: Row): Tool {
  return {
    id: row.id as number,
    canonical_key: row.canonical_key as string,
    name: row.name as string,
    kind: row.kind as ToolKind,
    verdict: row.verdict as Verdict,
    why_i_want_it: (row.why_i_want_it ?? null) as string | null,
    retire_reason: (row.retire_reason ?? null) as string | null,
    favorite: row.favorite as number,
    auto_update: row.auto_update as number,
    source: (row.source ?? null) as string | null,
    added_at: row.added_at as string,
    updated_at: row.updated_at as string,
  };
}

function rowToInstallation(row: Row): Installation {
  return {
    id: row.id as number,
    tool_id: row.tool_id as number,
    where_: row.where_ as string,
    version_local: (row.version_local ?? null) as string | null,
    present: row.present as number,
    last_seen_at: row.last_seen_at as string,
  };
}

function rowToObservations(row: Row): Observations {
  return {
    tool_id: row.tool_id as number,
    serving_count: row.serving_count as number,
    trial_running: row.trial_running as number,
    version_upstream: (row.version_upstream ?? null) as string | null,
    update_available: row.update_available as number,
    upstream_checked_at: (row.upstream_checked_at ?? null) as string | null,
    feed_etag: (row.feed_etag ?? null) as string | null,
  };
}

function rowToTag(row: Row): Tag {
  return {
    tool_id: row.tool_id as number,
    tag: row.tag as string,
    detected: row.detected as number,
  };
}

function rowToComment(row: Row): Comment {
  return {
    id: row.id as number,
    tool_id: row.tool_id as number,
    kind: row.kind as Comment['kind'],
    body: row.body as string,
    created_at: row.created_at as string,
  };
}

function rowToTrial(row: Row): Trial {
  return {
    id: row.id as number,
    trial_uid: row.trial_uid as string,
    tool_id: row.tool_id as number,
    container: (row.container ?? null) as string | null,
    image: (row.image ?? null) as string | null,
    ports: (row.ports ?? null) as string | null,
    image_created_by_osm: row.image_created_by_osm as number,
    volumes_created_by_osm: (row.volumes_created_by_osm ?? '[]') as string,
    started_at: row.started_at as string,
    ended_at: (row.ended_at ?? null) as string | null,
    outcome: (row.outcome ?? null) as string | null,
  };
}

// --- tools ---

export interface NewTool {
  canonical_key: string;
  name: string;
  kind: ToolKind;
  verdict?: Verdict;
  why_i_want_it?: string | null;
  retire_reason?: string | null;
  favorite?: number;
  auto_update?: number;
  source?: string | null;
}

export function insertTool(db: Db, tool: NewTool): Tool {
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO tools (canonical_key, name, kind, verdict, why_i_want_it, retire_reason, favorite, auto_update, source, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    tool.canonical_key,
    tool.name,
    tool.kind,
    tool.verdict ?? 'wanted',
    tool.why_i_want_it ?? null,
    tool.retire_reason ?? null,
    tool.favorite ?? 0,
    tool.auto_update ?? 0,
    tool.source ?? null,
    ts,
    ts,
  );
  return {
    id: Number(info.lastInsertRowid),
    canonical_key: tool.canonical_key,
    name: tool.name,
    kind: tool.kind,
    verdict: tool.verdict ?? 'wanted',
    why_i_want_it: tool.why_i_want_it ?? null,
    retire_reason: tool.retire_reason ?? null,
    favorite: tool.favorite ?? 0,
    auto_update: tool.auto_update ?? 0,
    source: tool.source ?? null,
    added_at: ts,
    updated_at: ts,
  };
}

export function selectTool(db: Db, id: number): Tool | undefined {
  const row = db.prepare('SELECT * FROM tools WHERE id = ?').get(id);
  return row ? rowToTool(row) : undefined;
}

export function selectToolByCanonicalKey(db: Db, key: string): Tool | undefined {
  const row = db.prepare('SELECT * FROM tools WHERE canonical_key = ?').get(key);
  return row ? rowToTool(row) : undefined;
}

export function selectTools(db: Db): Tool[] {
  const rows = db.prepare('SELECT * FROM tools ORDER BY favorite DESC, name COLLATE NOCASE').all();
  return rows.map(rowToTool);
}

export function updateToolVerdict(db: Db, id: number, verdict: Verdict, retireReason: string | null): void {
  db.prepare('UPDATE tools SET verdict = ?, retire_reason = ?, updated_at = ? WHERE id = ?')
    .run(verdict, retireReason, now(), id);
}

export function touchUpdatedAt(db: Db, toolId: number): void {
  db.prepare('UPDATE tools SET updated_at = ? WHERE id = ?').run(now(), toolId);
}

// --- composed views ---

export function selectToolView(db: Db, id: number): ToolView | undefined {
  const tool = selectTool(db, id);
  if (!tool) return undefined;
  return buildToolView(db, tool);
}

export function selectToolViews(db: Db): ToolView[] {
  return selectTools(db).map(tool => buildToolView(db, tool));
}

function buildToolView(db: Db, tool: Tool): ToolView {
  const aliases = db.prepare('SELECT alias FROM aliases WHERE tool_id = ? ORDER BY alias')
    .all(tool.id)
    .map(r => r.alias as string);
  return {
    ...tool,
    aliases,
    installations: selectInstallations(db, tool.id),
    observations: selectObservations(db, tool.id),
    tags: selectTags(db, tool.id),
  };
}

// --- aliases ---

export function addAlias(db: Db, toolId: number, alias: string): void {
  db.prepare('INSERT OR IGNORE INTO aliases (tool_id, alias) VALUES (?, ?)').run(toolId, alias);
}

export function findToolByAlias(db: Db, alias: string): Tool | undefined {
  const row = db.prepare(
    'SELECT t.* FROM tools t JOIN aliases a ON a.tool_id = t.id WHERE a.alias = ?',
  ).get(alias);
  return row ? rowToTool(row) : undefined;
}

// --- tags ---

export function selectTags(db: Db, toolId: number): Tag[] {
  return db.prepare('SELECT * FROM tags WHERE tool_id = ? ORDER BY tag').all(toolId).map(rowToTag);
}

export function upsertTag(db: Db, toolId: number, tag: string, detected = 1): void {
  db.prepare('INSERT OR REPLACE INTO tags (tool_id, tag, detected) VALUES (?, ?, ?)')
    .run(toolId, tag, detected);
}

export function deleteTag(db: Db, toolId: number, tag: string): void {
  db.prepare('DELETE FROM tags WHERE tool_id = ? AND tag = ?').run(toolId, tag);
}

// --- comments ---

export function selectComments(db: Db, toolId: number): Comment[] {
  return db.prepare('SELECT * FROM comments WHERE tool_id = ? ORDER BY created_at DESC, id DESC')
    .all(toolId)
    .map(rowToComment);
}

/** Journal event. Call inside withTransaction alongside the mutation it describes. */
export function addEvent(db: Db, toolId: number, body: string): void {
  db.prepare('INSERT INTO comments (tool_id, kind, body, created_at) VALUES (?, ?, ?, ?)')
    .run(toolId, 'event', body, now());
}

export function addUserComment(db: Db, toolId: number, body: string): Comment {
  const ts = now();
  const info = db.prepare('INSERT INTO comments (tool_id, kind, body, created_at) VALUES (?, ?, ?, ?)')
    .run(toolId, 'user', body, ts);
  return { id: Number(info.lastInsertRowid), tool_id: toolId, kind: 'user', body, created_at: ts };
}

// --- installations ---
// Discovery writes ONLY installations/observations — never owned fields
// (verdict, why_i_want_it, retire_reason, favorite, comments).

export function selectInstallations(db: Db, toolId: number): Installation[] {
  return db.prepare('SELECT * FROM installations WHERE tool_id = ? ORDER BY where_')
    .all(toolId)
    .map(rowToInstallation);
}

export interface SeenInstallation {
  where_: string;
  version_local: string | null;
}

/** Scan-source names that occupy the whole where_ value. Anything else is a disk path. */
const NAMED_SOURCES = ['npm-g', 'winget', 'skills-dir'] as const;
export type ScanSource = (typeof NAMED_SOURCES)[number] | 'disk';

function scopeSql(source: ScanSource): { sql: string; params: unknown[] } {
  if (source === 'disk') {
    return { sql: `where_ NOT IN (${NAMED_SOURCES.map(() => '?').join(', ')})`, params: [...NAMED_SOURCES] };
  }
  return { sql: 'where_ = ?', params: [source] };
}

/**
 * Upsert the installations one scan saw, by (tool_id, where_). Rows belonging to
 * this scan source that were NOT re-seen get present = 0 but are kept, with
 * last_seen_at preserved.
 */
export function replaceInstallationsForScan(
  db: Db,
  toolId: number,
  source: ScanSource,
  seen: SeenInstallation[],
): void {
  withTransaction(db, () => {
    const ts = now();
    const find = db.prepare('SELECT id FROM installations WHERE tool_id = ? AND where_ = ?');
    const insert = db.prepare(
      'INSERT INTO installations (tool_id, where_, version_local, present, last_seen_at) VALUES (?, ?, ?, 1, ?)',
    );
    const update = db.prepare(
      'UPDATE installations SET present = 1, version_local = ?, last_seen_at = ? WHERE id = ?',
    );
    for (const s of seen) {
      const existing = find.get(toolId, s.where_);
      if (existing) {
        update.run(s.version_local, ts, existing.id as number);
      } else {
        insert.run(toolId, s.where_, s.version_local, ts);
      }
    }
    const scope = scopeSql(source);
    const seenWheres = seen.map(s => s.where_);
    const notSeen =
      seenWheres.length > 0
        ? `AND where_ NOT IN (${seenWheres.map(() => '?').join(', ')})`
        : '';
    db.prepare(
      `UPDATE installations SET present = 0 WHERE tool_id = ? AND present = 1 AND ${scope.sql} ${notSeen}`,
    ).run(toolId, ...scope.params, ...seenWheres);
  });
}

// --- observations ---

export function selectObservations(db: Db, toolId: number): Observations | null {
  const row = db.prepare('SELECT * FROM observations WHERE tool_id = ?').get(toolId);
  return row ? rowToObservations(row) : null;
}

export function upsertObservations(
  db: Db,
  toolId: number,
  fields: Partial<Omit<Observations, 'tool_id'>>,
): void {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return;
  const cols = ['tool_id', ...keys].join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const updates = keys.map(k => `${k} = excluded.${k}`).join(', ');
  db.prepare(
    `INSERT INTO observations (${cols}) VALUES (?, ${placeholders})
     ON CONFLICT(tool_id) DO UPDATE SET ${updates}`,
  ).run(toolId, ...keys.map(k => fields[k] ?? null));
}

// --- trials ---

export interface BeginTrialInput {
  trial_uid: string;
  container?: string | null;
  image?: string | null;
  ports?: string | null;
  image_created_by_osm?: number;
  /** Volume names created by osm for this trial; stored as a JSON array. */
  volumes_created_by_osm?: string[];
}

export function beginTrial(db: Db, toolId: number, input: BeginTrialInput): number {
  const info = db.prepare(
    `INSERT INTO trials (trial_uid, tool_id, container, image, ports, image_created_by_osm, volumes_created_by_osm, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.trial_uid,
    toolId,
    input.container ?? null,
    input.image ?? null,
    input.ports ?? null,
    input.image_created_by_osm ?? 0,
    JSON.stringify(input.volumes_created_by_osm ?? []),
    now(),
  );
  return Number(info.lastInsertRowid);
}

export function endTrial(db: Db, trialId: number, outcome: string | null = null): void {
  db.prepare('UPDATE trials SET ended_at = ?, outcome = ? WHERE id = ?')
    .run(now(), outcome, trialId);
}

export function latestTrial(db: Db, toolId: number): Trial | undefined {
  const row = db.prepare(
    'SELECT * FROM trials WHERE tool_id = ? ORDER BY started_at DESC, id DESC LIMIT 1',
  ).get(toolId);
  return row ? rowToTrial(row) : undefined;
}
