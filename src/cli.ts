#!/usr/bin/env node
import { openDb, selectToolViews } from './core/db.js';
import { defaultDbPath, loadSettings } from './core/settings.js';
import type { Settings } from './core/types.js';
import { runDiscovery } from './core/discovery.js';
import { refreshServingCounts } from './core/registrar.js';
import { createOsmServer } from './web/server.js';
import { startOsmMcpServer } from './mcp/server.js';

const USAGE = `osm — OSource-Manager: local tool/source registry

Usage:
  osm serve [--port N]   Start the web UI + API server
  osm mcp                Serve the MCP tools over stdio (for Claude Code, Codex, …)
  osm refresh            Scan the machine and refresh the registry
  osm tools [--json]     List tracked tools
  osm setup              Register OSM as an MCP server (Phase 4 — preview only)
  osm help               Show this help
`;

function fail(message: string): never {
  process.stderr.write(`osm: ${message}\n`);
  process.exit(1);
}

function parsePort(args: string[]): number | null {
  const idx = args.indexOf('--port');
  if (idx === -1) return null;
  const raw = args[idx + 1];
  const port = Number(raw);
  if (raw === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`--port expects an integer between 1 and 65535, got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}`);
  }
  return port;
}

/** Print a DiscoveryReport without depending on its exact field names. */
function printDiscoveryReport(report: unknown): void {
  const rec = (report ?? {}) as Record<string, unknown>;
  const counts: Array<[string, number]> = [];
  for (const [key, value] of Object.entries(rec)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts.push([key, value]);
  }
  if (counts.length > 0) {
    process.stdout.write('Discovery summary:\n');
    for (const [key, value] of counts) {
      process.stdout.write(`  ${key}: ${value}\n`);
    }
  } else {
    process.stdout.write(`Discovery summary: ${JSON.stringify(report)}\n`);
  }
  const errors = rec['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    process.stdout.write(`Errors (${errors.length}):\n`);
    for (const err of errors) {
      process.stdout.write(`  - ${typeof err === 'string' ? err : JSON.stringify(err)}\n`);
    }
  }
}

/**
 * One refresh = scan the machine, then re-read serving_count from the agents.
 *
 * The second half is not optional bookkeeping: PLAN.md §Reconciliation says
 * serving_count is "derived by reading agent configs each refresh, never stored
 * as truth", and the UI's `serving ×N` chip, Serving funnel tile and
 * retire→unregister prompt all read that column. Without this call it is
 * permanently 0. Read failures are reported, never guessed at.
 */
async function refreshRegistry(db: Parameters<typeof runDiscovery>[0], settings: Settings): Promise<unknown> {
  const report = runDiscovery(db, settings) as unknown as Record<string, unknown>;
  try {
    const serving = await refreshServingCounts(db);
    if (serving.unreadable.length > 0) {
      const errors = Array.isArray(report.errors) ? (report.errors as unknown[]) : [];
      for (const u of serving.unreadable) errors.push(`serving_count: ${u.target}: ${u.error}`);
      report.errors = errors;
    }
  } catch (err) {
    const errors = Array.isArray(report.errors) ? (report.errors as unknown[]) : [];
    errors.push(`serving_count: ${err instanceof Error ? err.message : String(err)}`);
    report.errors = errors;
  }
  return report;
}

async function cmdServe(args: string[]): Promise<void> {
  const settings = loadSettings();
  const port = parsePort(args) ?? settings.port;
  const db = openDb(defaultDbPath());
  const handle = await createOsmServer(db, settings, {
    port,
    onRefresh: (d, s) => refreshRegistry(d, s),
  });

  process.stdout.write(`OSM UI → http://127.0.0.1:${handle.port}\n`);
  process.stdout.write(`Per-run token: ${handle.token}\n`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void handle
      .close()
      .catch(() => {
        // best effort
      })
      .finally(() => {
        try {
          db.close();
        } catch {
          // best effort
        }
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Serve the MCP tools over stdio. stdout is the JSON-RPC channel from here on,
 * so this command prints NOTHING — a stray line would corrupt the stream. Any
 * diagnostics belong on stderr.
 */
async function cmdMcp(): Promise<void> {
  await startOsmMcpServer();
}

async function cmdRefresh(): Promise<void> {
  const settings = loadSettings();
  const db = openDb(defaultDbPath());
  try {
    printDiscoveryReport(await refreshRegistry(db, settings));
  } finally {
    db.close();
  }
}

function cmdTools(args: string[]): void {
  const asJson = args.includes('--json');
  const db = openDb(defaultDbPath());
  try {
    const views = selectToolViews(db);
    if (asJson) {
      process.stdout.write(`${JSON.stringify(views, null, 2)}\n`);
      return;
    }
    if (views.length === 0) {
      process.stdout.write('No tools tracked yet. Run `osm refresh` first.\n');
      return;
    }
    for (const view of views) {
      const present = view.installations.filter((i) => i.present === 1).length;
      const fav = view.favorite === 1 ? ' *' : '';
      process.stdout.write(
        `${view.name}${fav}  [${view.kind}]  verdict=${view.verdict}  present=${present}\n`,
      );
    }
    process.stdout.write(`\n${views.length} tool(s) tracked.\n`);
  } finally {
    db.close();
  }
}

function cmdSetup(): void {
  process.stdout.write(
    `osm setup — preview (real self-registration ships in Phase 4)

When implemented, setup WILL:
  1. Register OSM as an MCP server into Claude Code:
       claude.cmd mcp add-json osource-manager '{"command":"osm","args":["mcp"]}' --scope user
  2. Register into Codex via its official CLI (codex mcp add ...).
  3. Probe the Docker MCP Toolkit surface (catalog/client/gateway) and register there.
  4. Verify each registration by reading state back through the official CLI.

Nothing has been changed. No config files were touched.
`,
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        break;
      case 'serve':
        await cmdServe(args);
        break;
      case 'mcp':
        await cmdMcp();
        break;
      case 'refresh':
        await cmdRefresh();
        break;
      case 'tools':
        cmdTools(args);
        break;
      case 'setup':
        cmdSetup();
        break;
      default:
        process.stderr.write(`osm: unknown command ${JSON.stringify(command)}\n\n`);
        process.stderr.write(USAGE);
        process.exit(1);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

void main();
