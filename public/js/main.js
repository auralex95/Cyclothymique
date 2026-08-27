/**
 * Point d'entrée de l'interface web.
 *
 * Responsabilités : connexion au backend, bandeau permanent (master, blackout,
 * état de la liaison), navigation entre les vues, enregistrement du service worker.
 */

import * as S from './state.js';
import { connect, reconnect, setMaster, setBlackout, authenticate, logout } from './net.js';
import { askPin } from './components/pinpad.js';
import { attachHFader } from './components/fader.js';
import { pct, toast } from './util.js';

import * as controlView from './views/control.js';
import * as presetsView from './views/presets.js';
import * as effectsView from './views/effects.js';
import * as patchView from './views/patch.js';
import * as fixturesView from './views/fixtures.js';
import * as networkView from './views/network.js';
import * as monitorView from './views/monitor.js';
import * as liveView from './views/live.js';

const VIEWS = {
  live: liveView,
  control: controlView,
  presets: presetsView,
  effects: effectsView,
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
const modeBtn = document.getElementById('mode-btn');

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

// ---------------------------------------------------------- modes Live / Régie

/**
 * Deux modes d'usage :
 *   - Live  : écran d'exploitation, uniquement les looks et les effets.
 *   - Régie : programmation complète (patch, profils, presets, effets, réseau).
 *
 * Le mode choisi est mémorisé sur l'appareil : un Raspberry Pi en régie fixe
 * rouvre son écran Live tout seul après une coupure de courant.
 */
const MODE_KEY = 'artnet.mode';

function storedMode() {
  // ?mode=live (ou ?mode=admin) l'emporte : c'est ce qu'utilise le mode kiosque.
  const forced = new URLSearchParams(location.search).get('mode');
  if (forced === 'live' || forced === 'admin') return forced;
  try {
    return localStorage.getItem(MODE_KEY) === 'admin' ? 'admin' : 'live';
  } catch {
    return 'live';   // navigation privée : on retombe sur le mode d'exploitation
  }
}

function applyMode(mode) {
  S.state.mode = mode;
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* stockage indisponible */ }
  document.body.classList.toggle('live-mode', mode === 'live');
  modeBtn.textContent = mode === 'live' ? 'Régie' : 'Mode Live';
  showView(mode === 'live' ? 'live' : 'control');
}

/** Passage en régie : demande le code si le show en définit un. */
async function enterAdminMode() {
  if (S.state.isAdmin) return applyMode('admin');

  const pin = await askPin({
    title: 'Mode Régie',
    hint: 'Entrez le code d’accès défini dans l’onglet Réseau.'
  });
  if (pin === null) return;
  if (await authenticate(pin)) applyMode('admin');
  else toast('Code incorrect', 3000);
}

modeBtn.addEventListener('click', async () => {
  if (S.state.mode === 'live') await enterAdminMode();
  else { await logout(); applyMode('live'); }
});

// Un refus du serveur (action de régie tentée en mode Live) est expliqué à l'écran.
S.on('denied', (message) => toast(message || 'Action réservée au mode Régie.', 3500));

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

// Compteur d'effets actifs sur l'onglet : on voit d'un coup d'œil que ça tourne.
const effectsTab = document.querySelector('#tabs .tab[data-view="effects"]');
S.on('show', (show) => {
  const running = (show?.effects || []).filter((e) => e.enabled).length;
  effectsTab.textContent = running ? `Effets (${running})` : 'Effets';
  effectsTab.classList.toggle('running', running > 0);
});

// La première réception de l'état déclenche le rendu initial, dans le mode retenu.
S.on('show', () => { if (!currentView) applyMode(storedMode()); });

// ----------------------------------------------------------------- démarrage

connect();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[pwa]', err.message));
  });
}

// Empêche le zoom par double-tap et le "pull to refresh" pendant un show.
document.addEventListener('gesturestart', (e) => e.preventDefault());
