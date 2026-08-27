/**
 * Point d'entrée de l'interface web.
 *
 * Responsabilités : connexion au backend, bandeau permanent (master, blackout,
 * état de la liaison), navigation entre les vues, enregistrement du service worker.
 */

import * as S from './state.js';
import { connect, reconnect, setMaster, setBlackout } from './net.js';
import { attachHFader } from './components/fader.js';
import { pct, toast } from './util.js';

import * as controlView from './views/control.js';
import * as presetsView from './views/presets.js';
import * as patchView from './views/patch.js';
import * as fixturesView from './views/fixtures.js';
import * as networkView from './views/network.js';
import * as monitorView from './views/monitor.js';

const VIEWS = {
  control: controlView,
  presets: presetsView,
  patch: patchView,
  fixtures: fixturesView,
  network: networkView,
  monitor: monitorView
};

const viewEl = document.getElementById('view');
const ledEl = document.getElementById('conn-led');
const connTextEl = document.getElementById('conn-text');
const offlineEl = document.getElementById('offline');
const offlineDetailEl = document.getElementById('offline-detail');
const masterValueEl = document.getElementById('master-value');
const blackoutBtn = document.getElementById('blackout-btn');

let currentView = null;
let disposeView = null;

/** Affiche une vue et libère la précédente (désabonnements). */
function showView(name) {
  if (!VIEWS[name]) return;
  disposeView?.();
  currentView = name;
  disposeView = VIEWS[name].render(viewEl) || null;
  for (const tab of document.querySelectorAll('#tabs .tab')) {
    tab.classList.toggle('active', tab.dataset.view === name);
  }
  viewEl.scrollTop = 0;
}

document.getElementById('tabs').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (tab) showView(tab.dataset.view);
});

// ------------------------------------------------------------ master & blackout

const masterFader = attachHFader(document.getElementById('master-fader'), {
  get: () => S.state.master,
  set: (v) => { setMaster(v); masterValueEl.textContent = pct(v); }
});

S.on('master', (v) => { masterValueEl.textContent = pct(v); masterFader.refresh(); });

blackoutBtn.addEventListener('click', () => setBlackout(!S.state.blackout));
S.on('blackout', (on) => {
  blackoutBtn.classList.toggle('on', on);
  blackoutBtn.textContent = on ? 'BLACKOUT ACTIF' : 'BLACKOUT';
});

// Barre d'espace = blackout sur desktop (raccourci de régie).
window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && ev.target === document.body) {
    ev.preventDefault();
    setBlackout(!S.state.blackout);
  }
});

// ----------------------------------------------------------- état de la liaison

S.on('connection', (connected, reason) => {
  ledEl.classList.toggle('ok', connected);
  connTextEl.textContent = connected ? 'connecté' : 'hors ligne';
  offlineEl.classList.toggle('hidden', connected);
  if (!connected) {
    offlineDetailEl.textContent = reason ? `Cause : ${reason}` : 'Reconnexion automatique en cours…';
  } else {
    toast('Connecté au serveur Art-Net');
  }
});

S.on('status', (status) => {
  // La LED passe à l'orange si le serveur est joignable mais n'émet plus d'Art-Net.
  const artnet = status?.artnet;
  const stale = !artnet?.ready || (artnet.lastSendAt && Date.now() - artnet.lastSendAt > 2000);
  ledEl.classList.toggle('warn', S.state.connected && stale);
  if (S.state.connected) {
    connTextEl.textContent = stale
      ? 'serveur OK · Art-Net inactif'
      : `${artnet.refreshRate} Hz · ${status.nodes.length} node(s)`;
  }
});

document.getElementById('offline-retry').addEventListener('click', reconnect);

// La première réception de l'état déclenche le rendu initial.
S.on('show', () => { if (!currentView) showView('control'); });

// ----------------------------------------------------------------- démarrage

connect();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[pwa]', err.message));
  });
}

// Empêche le zoom par double-tap et le "pull to refresh" pendant un show.
document.addEventListener('gesturestart', (e) => e.preventDefault());
