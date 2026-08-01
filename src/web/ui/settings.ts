// Settings view: functional form bound to GET/PUT /api/settings.
import { getSettings, putSettings } from './api.js';
import { $, errToast, toast } from './util.js';
import type { Settings } from '../../core/types.js';

const TARGET_KEYS = ['claude', 'codex', 'docker', 'kimi', 'zed', 'vscode'] as const;
const CATALOG_KEYS = ['docker', 'anthropic', 'github'] as const;

let loaded = false;

function fill(s: Settings): void {
  ($('#s-scandirs') as HTMLTextAreaElement).value = s.scanDirs.join('\n');
  ($('#s-skillsdirs') as HTMLTextAreaElement).value = s.skillsDirs.join('\n');
  ($('#s-clonepath') as HTMLInputElement).value = s.clonePath;
  ($('#s-port') as HTMLInputElement).value = String(s.port);
  ($('#s-autoupdate') as HTMLInputElement).checked = s.autoUpdateDefault;
  $('#s-targets').innerHTML = TARGET_KEYS.map(
    (k) => `<label class="chk"><input type="checkbox" data-rt="${k}"${s.registerTargets[k] ? ' checked' : ''}> ${k}</label>`,
  ).join('');
  $('#s-catalogs').innerHTML = CATALOG_KEYS.map(
    (k) => `<label class="chk"><input type="checkbox" data-cat="${k}"${s.catalogs[k] ? ' checked' : ''}> ${k}</label>`,
  ).join('');
}

function collect(): Settings {
  const lines = (id: string): string[] =>
    ($(id) as HTMLTextAreaElement).value
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  const registerTargets = {} as Settings['registerTargets'];
  document.querySelectorAll<HTMLInputElement>('#s-targets [data-rt]').forEach((el) => {
    registerTargets[el.dataset.rt as keyof Settings['registerTargets']] = el.checked;
  });
  const catalogs = {} as Settings['catalogs'];
  document.querySelectorAll<HTMLInputElement>('#s-catalogs [data-cat]').forEach((el) => {
    catalogs[el.dataset.cat as keyof Settings['catalogs']] = el.checked;
  });
  const port = Number(($('#s-port') as HTMLInputElement).value);
  return {
    scanDirs: lines('#s-scandirs'),
    skillsDirs: lines('#s-skillsdirs'),
    clonePath: ($('#s-clonepath') as HTMLInputElement).value.trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 7807,
    autoUpdateDefault: ($('#s-autoupdate') as HTMLInputElement).checked,
    registerTargets,
    catalogs,
  };
}

export function loadSettingsView(): void {
  if (loaded) return;
  void (async () => {
    try {
      fill(await getSettings());
      loaded = true;
      $('#s-status').textContent = '';
    } catch (e) {
      errToast(e);
      $('#s-status').textContent = 'could not load settings';
    }
  })();
}

export function initSettings(): void {
  $('#sform').addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      try {
        await putSettings(collect());
        $('#s-status').textContent = `saved ${new Date().toLocaleTimeString()}`;
        toast('settings saved');
      } catch (err) {
        errToast(err);
        $('#s-status').textContent = 'save failed';
      }
    })();
  });
}
