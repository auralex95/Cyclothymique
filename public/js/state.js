/**
 * État côté client : miroir local de l'état du serveur + sélection courante.
 *
 * Les vues s'abonnent aux événements ('show', 'values', 'status'…) et se
 * redessinent. Les mouvements de faders sont appliqués localement tout de suite
 * (réactivité immédiate) puis envoyés au serveur de façon throttlée.
 */

import { hasVirtualDimmer } from '/shared/attributes.js';

const listeners = new Map();

export const state = {
  connected: false,
  show: null,          // patch, groupes, presets, univers, réglages
  library: [],         // profils de fixtures
  values: {},          // { fixtureId: { attr: 0..1 } }
  master: 1,
  blackout: false,
  status: null,        // état Art-Net + nodes découverts
  selection: [],       // ids de fixtures sélectionnés (ordre = ordre de sélection)
  mirror: false,       // miroir pan pour la sélection
  fine: false,         // mode précision du pavé XY
  fadeTime: 1          // temps de fade au rappel des presets (secondes)
};

export function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => listeners.get(event).delete(cb);
}

export function emit(event, payload) {
  for (const cb of listeners.get(event) || []) {
    try { cb(payload); } catch (err) { console.error(`[state] listener ${event}`, err); }
  }
}

// ------------------------------------------------------------------ helpers

// Accès pratiques à l'état (toujours via `state`, jamais de copie locale :
// une vue qui garderait une référence raterait les mises à jour du serveur).
export const fixtures = () => state.show?.fixtures || [];
export const universes = () => state.show?.universes || [];
export const presets = () => state.show?.presets || [];
export const groups = () => state.show?.groups || [];

export function fixtureById(id) {
  return fixtures().find((f) => f.id === id) || null;
}

export function profileOf(fixture) {
  if (!fixture) return null;
  return state.library.find((p) => p.id === fixture.profileId) || null;
}

/** Fixtures actuellement sélectionnées, dans l'ordre de sélection. */
export function selected() {
  return state.selection.map(fixtureById).filter(Boolean);
}

/** Valeur d'un attribut pour une fixture (undefined si non gérée par le profil). */
export function valueOf(fixtureId, attr) {
  return state.values[fixtureId]?.[attr];
}

/**
 * Valeur "affichée" d'un attribut pour la sélection : celle de la première
 * fixture qui possède l'attribut (repli sur le défaut du profil).
 */
export function selectionValue(attr, fallback = 0) {
  for (const fx of selected()) {
    const v = valueOf(fx.id, attr);
    if (v !== undefined) return v;
  }
  return fallback;
}

/** Attributs disponibles sur AU MOINS une des fixtures sélectionnées. */
export function selectionAttributes() {
  const attrs = new Set();
  for (const fx of selected()) {
    const profile = profileOf(fx);
    if (!profile) continue;
    for (const attr of Object.keys(profile.channels)) attrs.add(attr);
    // Le dimmer virtuel n'a pas de canal : on l'ajoute explicitement.
    if (hasVirtualDimmer(profile)) attrs.add('dimmer');
  }
  return [...attrs];
}

/** Slots de roue (couleur, gobo, shutter…) du premier profil qui en propose. */
export function selectionWheelSlots(attr) {
  for (const fx of selected()) {
    const slots = profileOf(fx)?.wheels?.[attr];
    if (slots?.length) return slots;
  }
  return null;
}

/** Applique localement des valeurs reçues du serveur ou saisies par l'utilisateur. */
export function applyValues(entries) {
  for (const { id, attr, value } of entries) {
    if (!state.values[id]) state.values[id] = {};
    state.values[id][attr] = value;
  }
  emit('values', entries);
}

export function setSelection(ids) {
  state.selection = [...new Set(ids)].filter((id) => fixtureById(id));
  emit('selection', state.selection);
}

export function toggleSelection(id) {
  const i = state.selection.indexOf(id);
  if (i >= 0) state.selection.splice(i, 1);
  else state.selection.push(id);
  emit('selection', state.selection);
}
