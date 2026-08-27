/**
 * Liaison temps réel avec le backend (Socket.IO).
 *
 * Deux points importants :
 *  - les valeurs modifiées en continu (fader, pavé XY) sont accumulées et
 *    envoyées au maximum ~40 fois par seconde, pour ne pas saturer le Wi-Fi ;
 *  - la perte de connexion est signalée clairement à l'écran (voile "hors ligne")
 *    et la reconnexion est automatique.
 */

import { state, emit, applyValues } from './state.js';

const SEND_HZ = 40;

let socket = null;
// Code du mode Régie, gardé en mémoire pour les requêtes REST (import de show,
// de profil…). Jamais écrit sur le disque du navigateur.
let adminPin = null;
/** Valeurs en attente d'envoi : clé "fixtureId|attr" -> entrée. */
const pending = new Map();
let flushTimer = null;

export function connect() {
  // io() est fourni par /socket.io/socket.io.js, servi par le backend.
  socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 3000 });

  // Exposée pour le diagnostic depuis la console du navigateur (et les tests).
  window.__artnetSocket = socket;

  socket.on('connect', () => {
    state.connected = true;
    emit('connection', true);
  });

  socket.on('disconnect', (reason) => {
    state.connected = false;
    emit('connection', false, reason);
  });

  socket.on('connect_error', (err) => {
    state.connected = false;
    emit('connection', false, err?.message);
  });

  // État complet à la connexion (et après reconnexion).
  // Refus du serveur : action réservée au mode Régie.
  socket.on('denied', (message) => emit('denied', message));

  socket.on('init', (payload) => {
    state.show = payload.show;
    state.library = payload.library;
    state.values = payload.values;
    state.master = payload.master;
    state.blackout = payload.blackout;
    state.status = payload.status;
    state.isAdmin = payload.isAdmin !== false;
    // On purge la sélection des fixtures qui n'existent plus.
    state.selection = state.selection.filter((id) => payload.show.fixtures.some((f) => f.id === id));
    emit('show', state.show);
    emit('status', state.status);
    emit('values', []);
  });

  socket.on('show', (show) => {
    state.show = show;
    state.selection = state.selection.filter((id) => show.fixtures.some((f) => f.id === id));
    emit('show', show);
  });

  socket.on('values', (entries) => applyValues(entries));

  socket.on('values:full', (values) => {
    state.values = values;
    emit('values', []);
  });

  socket.on('master', (v) => { state.master = v; emit('master', v); });
  socket.on('blackout', (v) => { state.blackout = v; emit('blackout', v); });
  socket.on('status', (s) => { state.status = s; emit('status', s); });
  socket.on('monitor', (data) => emit('monitor', data));

  // Bibliothèque de profils rechargée par le serveur (profil créé ou modifié).
  socket.on('library', (library) => {
    state.library = library;
    emit('library', library);
  });
  socket.on('preset:recalled', (info) => emit('preset:recalled', info));
}

/**
 * Passage en mode Régie : le serveur vérifie le code et marque la connexion.
 * @returns {Promise<boolean>} vrai si les droits sont accordés
 */
export function authenticate(pin) {
  return new Promise((resolve) => {
    socket?.emit('auth:admin', pin, (result) => {
      state.isAdmin = !!result?.isAdmin;
      if (result?.ok) adminPin = pin;
      emit('admin', state.isAdmin);
      resolve(!!result?.ok);
    });
  });
}

/** Retour en mode Live : les droits sont relâchés si un code est défini. */
export function logout() {
  return new Promise((resolve) => {
    socket?.emit('auth:logout', (result) => {
      state.isAdmin = result?.isAdmin !== false;
      adminPin = null;
      emit('admin', state.isAdmin);
      resolve(state.isAdmin);
    });
  });
}

/** En-têtes à joindre aux requêtes REST qui modifient le show. */
export function adminHeaders(base = {}) {
  return adminPin ? { ...base, 'X-Admin-Pin': adminPin } : { ...base };
}

/** Force une tentative de reconnexion immédiate (bouton du voile hors ligne). */
export function reconnect() {
  if (socket) socket.connect();
}

/**
 * Envoi throttlé des valeurs.
 * @param {Array<{id:string, attr:string, value:number}>} entries
 */
export function sendValues(entries) {
  if (!entries.length) return;
  applyValues(entries);                      // retour visuel immédiat, sans attendre le serveur
  for (const e of entries) pending.set(`${e.id}|${e.attr}`, e);
  if (!flushTimer) flushTimer = setTimeout(flush, 1000 / SEND_HZ);
}

function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const batch = [...pending.values()];
  pending.clear();
  socket?.emit('values:set', batch);
}

/**
 * Envoi générique d'un ordre au serveur (patch, presets, réglages…).
 * `ack` est appelé avec la réponse du serveur pour les ordres qui en renvoient
 * une (enregistrement d'un profil de fixture, par exemple).
 */
export function send(event, payload, ack) {
  if (typeof ack === 'function') socket?.emit(event, payload, ack);
  else socket?.emit(event, payload);
}

export function setMaster(value) {
  state.master = value;
  emit('master', value);
  socket?.emit('master:set', value);
}

export function setBlackout(value) {
  state.blackout = value;
  emit('blackout', value);
  socket?.emit('blackout:set', value);
}
