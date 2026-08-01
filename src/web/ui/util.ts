// Small DOM/format helpers shared across views.

export function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as HTMLElement;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

let toastT: ReturnType<typeof setTimeout> | undefined;
export function toast(m: string): void {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('show');
  if (toastT !== undefined) clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

export function errToast(e: unknown): void {
  toast(e instanceof Error ? e.message : String(e));
}

/** Absolute timestamp to the second: YYYY-MM-DD HH:mm:ss (local). */
export function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Relative time, honest and coarse: '2h ago', 'today', 'never'. */
export function fmtRel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** repo web URL from a canonical git key 'host/owner/repo'; null if it isn't one. */
export function repoWebUrl(canonicalKey: string): string | null {
  return /^[\w.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+$/i.test(canonicalKey) ? `https://${canonicalKey}` : null;
}
