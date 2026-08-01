// Entry point: wire views, handlers registry, and boot the app.
import { initToken } from './api.js';
import { state, handlers } from './state.js';
import { $, errToast } from './util.js';
import * as manage from './manage.js';
import * as detail from './detail.js';
import * as palette from './palette.js';
import * as settingsView from './settings.js';

function wireViewTabs(): void {
  $('#viewtabs').addEventListener('click', (e) => {
    const tab = (e.target as Element | null)?.closest('.tab');
    if (!tab || !(tab instanceof HTMLElement) || !tab.dataset.view) return;
    const view = tab.dataset.view;
    document.querySelectorAll('#viewtabs .tab').forEach((x) => x.classList.toggle('on', x === tab));
    for (const v of ['manage', 'browse', 'settings']) {
      $('#view-' + v).classList.toggle('hidden', v !== view);
    }
    if (view === 'settings') settingsView.loadSettingsView();
  });
}

async function reload(): Promise<void> {
  await manage.loadTools();
  // keep the detail panel in sync if the selected tool still exists
  if (state.selectedId !== null && state.tools.some((t) => t.id === state.selectedId)) {
    detail.show(state.selectedId);
  } else if (state.selectedId !== null) {
    detail.close();
  }
}

async function boot(): Promise<void> {
  manage.initManage();
  detail.initDetail();
  palette.initPalette();
  settingsView.initSettings();
  wireViewTabs();

  handlers.reload = reload;
  handlers.refresh = manage.refresh;
  handlers.select = (id: number) => {
    state.selectedId = id;
    manage.renderRows();
    detail.show(id);
  };
  handlers.closeDetail = () => {
    detail.close(); // clears selectedId
    manage.renderRows();
  };
  handlers.setFilter = (fq: string) => {
    state.filter = fq;
    manage.renderPills();
    manage.renderRows();
  };
  handlers.focusAdd = () => {
    ($('#addurl') as HTMLInputElement).focus();
  };

  try {
    await initToken();
  } catch (e) {
    errToast(e);
  }
  await manage.loadTools();
}

void boot();
