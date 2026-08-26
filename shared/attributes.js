/**
 * Dictionnaire des attributs reconnus par l'application.
 *
 * Un "attribut" est une fonction logique d'un projecteur (pan, dimmer, rouge...).
 * Chaque profil de fixture (data/fixtures/*.json) associe un attribut à un ou
 * deux canaux DMX (canal grossier + canal "fine" optionnel pour le 16 bits).
 *
 * En interne, TOUTES les valeurs d'attributs sont normalisées entre 0 et 1.
 * La conversion vers les octets DMX est faite au moment du rendu (server/engine.js).
 *
 * Ce fichier est partagé : il est importé par le serveur (Node) ET par le
 * navigateur (module ES servi tel quel). Ne pas y mettre de code spécifique à Node.
 */

/**
 * @typedef {Object} AttributeMeta
 * @property {string} label      Libellé affiché dans l'interface
 * @property {string} group      Regroupement dans l'UI : position | intensity | color | beam | control
 * @property {string} ui         Type de contrôle : pad | fader | color | wheel | button
 * @property {number} default    Valeur par défaut (0..1) appliquée au patch d'une fixture
 * @property {boolean} [invertible] L'attribut peut être inversé en mode "miroir" de groupe
 */

/** @type {Record<string, AttributeMeta>} */
export const ATTRIBUTES = {
  // --- Position ---------------------------------------------------------
  pan:        { label: 'Pan',        group: 'position',  ui: 'pad',   default: 0.5, invertible: true },
  tilt:       { label: 'Tilt',       group: 'position',  ui: 'pad',   default: 0.5, invertible: true },
  ptSpeed:    { label: 'Vitesse P/T',group: 'position',  ui: 'fader', default: 0 },

  // --- Intensité --------------------------------------------------------
  dimmer:     { label: 'Dimmer',     group: 'intensity', ui: 'fader', default: 0 },
  shutter:    { label: 'Shutter',    group: 'intensity', ui: 'wheel', default: 1 },

  // --- Couleur ----------------------------------------------------------
  red:        { label: 'Rouge',      group: 'color',     ui: 'color', default: 1 },
  green:      { label: 'Vert',       group: 'color',     ui: 'color', default: 1 },
  blue:       { label: 'Bleu',       group: 'color',     ui: 'color', default: 1 },
  white:      { label: 'Blanc',      group: 'color',     ui: 'color', default: 0 },
  amber:      { label: 'Ambre',      group: 'color',     ui: 'color', default: 0 },
  uv:         { label: 'UV',         group: 'color',     ui: 'color', default: 0 },
  colorWheel: { label: 'Roue couleur', group: 'color',   ui: 'wheel', default: 0 },
  cto:        { label: 'CTO',        group: 'color',     ui: 'fader', default: 0 },

  // --- Faisceau ---------------------------------------------------------
  gobo:       { label: 'Roue gobo',  group: 'beam',      ui: 'wheel', default: 0 },
  goboRotate: { label: 'Rotation gobo', group: 'beam',   ui: 'fader', default: 0 },
  prism:      { label: 'Prisme',     group: 'beam',      ui: 'wheel', default: 0 },
  zoom:       { label: 'Zoom',       group: 'beam',      ui: 'fader', default: 0.5 },
  focus:      { label: 'Focus',      group: 'beam',      ui: 'fader', default: 0.5 },
  iris:       { label: 'Iris',       group: 'beam',      ui: 'fader', default: 1 },
  frost:      { label: 'Frost',      group: 'beam',      ui: 'fader', default: 0 },

  // --- Divers / contrôle ------------------------------------------------
  macro:      { label: 'Macro',      group: 'control',   ui: 'wheel', default: 0 },
  macroSpeed: { label: 'Vitesse macro', group: 'control',ui: 'fader', default: 0 },
  control:    { label: 'Contrôle',   group: 'control',   ui: 'wheel', default: 0 }
};

/** Attributs de couleur additive gérés par le color picker, dans l'ordre d'affichage. */
export const COLOR_ATTRS = ['red', 'green', 'blue', 'white', 'amber', 'uv'];

/** Ordre d'affichage des groupes d'attributs dans l'interface de contrôle. */
export const GROUP_ORDER = ['intensity', 'position', 'color', 'beam', 'control'];

export const GROUP_LABELS = {
  position: 'Position',
  intensity: 'Intensité',
  color: 'Couleur',
  beam: 'Faisceau',
  control: 'Contrôle'
};

/**
 * Un profil sait-il piloter cet attribut ?
 *
 * Cas particulier du DIMMER VIRTUEL : un projecteur LED sans canal de dimmer
 * (PAR RGB 3 canaux par exemple) se règle en intensité en modulant ses
 * composantes de couleur. Le dimmer reste donc un attribut valide pour lui.
 */
export function profileSupports(profile, attr) {
  if (!profile || !profile.channels) return false;
  if (profile.channels[attr]) return true;
  if (attr === 'dimmer') return COLOR_ATTRS.some((c) => profile.channels[c]);
  return false;
}

/** Le profil n'a pas de canal de dimmer mais des LED : intensité par modulation des couleurs. */
export function hasVirtualDimmer(profile) {
  return !!profile && !profile.channels.dimmer && COLOR_ATTRS.some((c) => profile.channels[c]);
}

/** Métadonnées d'un attribut, avec repli neutre si l'attribut est inconnu. */
export function attrMeta(name) {
  return ATTRIBUTES[name] || { label: name, group: 'control', ui: 'fader', default: 0 };
}
