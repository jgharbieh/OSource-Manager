/**
 * Hand a tool's path to the OS and let the OS decide what opens it.
 *
 * OSM does not know which IDE Joseph wants — that is a per-machine, per-file
 * choice Windows already stores. So there is no editor detection and no
 * configured "ide command": a directory opens in Explorer, a file opens in
 * whatever is registered for its extension (Windows will ask if nothing is).
 *
 * The path NEVER comes from the request — only from an installations row this
 * database already recorded. Nothing is passed through a shell: `explorer.exe`
 * and `open`/`xdg-open` are spawned with an argv array.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { OpResult } from './types.js';
import { type Db, selectInstallations, selectTool } from './db.js';

export interface OpenResult {
  path: string;
  opener: string;
}

const NAMED_SOURCES = ['npm-g', 'winget', 'skills-dir'];

/** Path-like installation for this tool, or null. */
function toolPath(db: Db, toolId: number): string | null {
  const insts = selectInstallations(db, toolId);
  const pick = insts.find(i => i.present === 1 && !NAMED_SOURCES.includes(i.where_))
    ?? insts.find(i => !NAMED_SOURCES.includes(i.where_));
  if (!pick) return null;
  return pick.where_.startsWith('skills-dir:') ? pick.where_.slice('skills-dir:'.length) : pick.where_;
}

function opener(): { cmd: string; args: (p: string) => string[] } {
  if (process.platform === 'win32') return { cmd: 'explorer.exe', args: p => [p] };
  if (process.platform === 'darwin') return { cmd: 'open', args: p => [p] };
  return { cmd: 'xdg-open', args: p => [p] };
}

/**
 * Open a tool's location with the OS default handler. Fire-and-forget: the
 * opener detaches, so a successful spawn is the whole result — explorer.exe
 * famously exits non-zero even when it opened the window, which is why the
 * exit code is deliberately not treated as the verdict.
 */
export function openToolPath(db: Db, toolId: number): OpResult<OpenResult> {
  const tool = selectTool(db, toolId);
  if (!tool) return { ok: false, message: `tool ${toolId} not found` };

  const path = toolPath(db, toolId);
  if (!path) {
    return {
      ok: false,
      message: `${tool.name} has no path on this machine — it is tracked, not installed (source: ${tool.source ?? 'unknown'})`,
    };
  }
  if (!existsSync(path)) {
    return { ok: false, message: `${path} is no longer on disk — refresh to update the shelf` };
  }

  const { cmd, args } = opener();
  try {
    const child = spawn(cmd, args(path), { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, message: `opened ${path}`, data: { path, opener: cmd } };
  } catch (err) {
    return { ok: false, message: `could not open ${path}: ${String(err)}` };
  }
}
