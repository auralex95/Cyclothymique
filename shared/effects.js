/**
 * Moteur d'effets : catalogue des effets et formes d'onde.
 *
 * Principe : un effet ne modifie JAMAIS les valeurs enregistrées des
 * projecteurs. Il est appliqué au moment du rendu, par-dessus la valeur de
 * base — arrêter l'effet fait donc retrouver exactement la position, la
 * couleur ou l'intensité réglées à la main.
 *
 * Trois façons de se combiner à la base :
 *   - 'add'      : oscillation autour de la valeur de base (pan, tilt…) ;
 *                  la taille est l'amplitude crête à crête, donc 100 % = toute
 *                  la course de l'attribut
 *   - 'multiply' : modulation de la valeur de base (dimmer)
 *   - 'set'      : remplacement de la valeur de base (couleur arc-en-ciel)
 *
 * Fichier partagé serveur ↔ navigateur : pas de code spécifique à Node.
 */

/** Partie fractionnaire, toujours positive (les phases négatives restent valides). */
const frac = (x) => x - Math.floor(x);

/**
 * Formes d'onde. Entrée : phase en tours (1 = un cycle complet).
 * Sortie : -1 … +1.
 *
 * Point de départ (phase 0), volontairement différent selon la forme :
 *   sin et triangle partent du milieu en montant ;
 *   square part en haut ;
 *   saw part de son minimum et monte jusqu'au sommet avant de retomber
 *   (c'est ce qui donne l'effet de vague des rampes de dimmer) ;
 *   random tire une valeur stable par cycle.
 * Changer la forme d'un effet en cours peut donc provoquer un saut : c'est normal.
 */
export const WAVEFORMS = {
  sin:      (p) => Math.sin(2 * Math.PI * p),
  triangle: (p) => 4 * Math.abs(frac(p - 0.25) - 0.5) - 1,
  square:   (p) => (frac(p) < 0.5 ? 1 : -1),
  saw:      (p) => 2 * frac(p) - 1,
  // Marche aléatoire : une valeur stable par cycle, reproductible (pas de Math.random,
  // sinon deux clients ou deux trames ne verraient pas la même chose).
  random:   (p, seed = 0) => {
    const step = Math.floor(p) + seed * 97;
    const noise = Math.sin(step * 12.9898 + 78.233) * 43758.5453;
    return (noise - Math.floor(noise)) * 2 - 1;
  }
};

export const WAVEFORM_LABELS = {
  sin: 'Sinus', triangle: 'Triangle', square: 'Créneau', saw: 'Dent de scie', random: 'Aléatoire'
};

/**
 * Catalogue des effets proposés dans l'interface.
 *
 * `parts` décrit les attributs animés :
 *   attr    : attribut piloté
 *   wave    : forme d'onde par défaut
 *   phase   : décalage fixe, en tours (0.25 = quart de cycle)
 *   freq    : multiplicateur de fréquence (2 = deux fois plus rapide)
 *   depth   : proportion de l'amplitude appliquée à cette partie
 */
export const EFFECT_PRESETS = {
  circle: {
    label: 'Cercle', family: 'position', mode: 'add', bpm: 30, size: 0.4,
    description: 'Pan et tilt en quadrature : le faisceau décrit un cercle.',
    parts: [
      { attr: 'pan', wave: 'sin', phase: 0 },
      { attr: 'tilt', wave: 'sin', phase: 0.25 }
    ]
  },
  figure8: {
    label: 'Huit', family: 'position', mode: 'add', bpm: 24, size: 0.5,
    description: 'Tilt deux fois plus rapide que le pan : trajectoire en 8.',
    parts: [
      { attr: 'pan', wave: 'sin', phase: 0 },
      { attr: 'tilt', wave: 'sin', phase: 0, freq: 2, depth: 0.6 }
    ]
  },
  panSweep: {
    label: 'Balayage pan', family: 'position', mode: 'add', bpm: 20, size: 0.7,
    description: 'Va-et-vient horizontal autour de la position de base.',
    parts: [{ attr: 'pan', wave: 'sin' }]
  },
  tiltSweep: {
    label: 'Balayage tilt', family: 'position', mode: 'add', bpm: 20, size: 0.5,
    description: 'Va-et-vient vertical autour de la position de base.',
    parts: [{ attr: 'tilt', wave: 'sin' }]
  },
  ballyhoo: {
    label: 'Ballyhoo', family: 'position', mode: 'add', bpm: 40, size: 0.6, spread: 1.5,
    description: 'Cercles désynchronisés : le grand classique des fins de morceau.',
    parts: [
      { attr: 'pan', wave: 'sin', phase: 0, freq: 1 },
      { attr: 'tilt', wave: 'sin', phase: 0.25, freq: 1.5, depth: 0.7 }
    ]
  },
  nod: {
    label: 'Hochement', family: 'position', mode: 'add', bpm: 60, size: 0.25,
    description: 'Petit mouvement de tilt sec, en triangle.',
    parts: [{ attr: 'tilt', wave: 'triangle' }]
  },

  dimmerPulse: {
    label: 'Pulse dimmer', family: 'dimmer', mode: 'multiply', bpm: 60, size: 1,
    description: 'Intensité qui respire, en sinus.',
    parts: [{ attr: 'dimmer', wave: 'sin' }]
  },
  dimmerChase: {
    label: 'Chase dimmer', family: 'dimmer', mode: 'multiply', bpm: 120, size: 1, spread: 1,
    description: 'Allumage successif des projecteurs (créneau + décalage).',
    parts: [{ attr: 'dimmer', wave: 'square' }]
  },
  dimmerRamp: {
    label: 'Rampe dimmer', family: 'dimmer', mode: 'multiply', bpm: 60, size: 1, spread: 1,
    description: 'Montée puis coupure nette, façon vague.',
    parts: [{ attr: 'dimmer', wave: 'saw' }]
  },
  dimmerRandom: {
    label: 'Scintillement', family: 'dimmer', mode: 'multiply', bpm: 240, size: 0.8, spread: 0.5,
    description: 'Intensités aléatoires mais reproductibles.',
    parts: [{ attr: 'dimmer', wave: 'random' }]
  },

  rainbow: {
    label: 'Arc-en-ciel', family: 'color', mode: 'set', bpm: 20, size: 1, spread: 1,
    description: 'Teinte qui défile en continu sur les projecteurs à LED.',
    hue: { steps: 0 }
  },
  colorSteps: {
    label: 'Chase couleur', family: 'color', mode: 'set', bpm: 60, size: 1, spread: 1,
    description: 'Sauts de couleur francs, sans dégradé.',
    hue: { steps: 6 }
  }
};

export const FAMILY_LABELS = {
  position: 'Mouvement',
  dimmer: 'Intensité',
  color: 'Couleur'
};

/** Attributs animés par un effet (sert à savoir quelles fixtures sont concernées). */
export function effectAttributes(presetId) {
  const preset = EFFECT_PRESETS[presetId];
  if (!preset) return [];
  if (preset.hue) return ['red', 'green', 'blue'];
  return preset.parts.map((p) => p.attr);
}

/** Réglages par défaut d'un effet, complétés par ceux du catalogue. */
export function defaultEffectSettings(presetId) {
  const preset = EFFECT_PRESETS[presetId] || {};
  return {
    bpm: preset.bpm ?? 60,        // 1 cycle par temps ; 60 BPM = 1 cycle par seconde
    size: preset.size ?? 0.25,    // amplitude, 0…1
    spread: preset.spread ?? 1,   // décalage de phase réparti sur le groupe, en tours
    wave: preset.parts?.[0]?.wave ?? 'sin',
    direction: 1,                 // 1 = avant, -1 = arrière
    enabled: true
  };
}

/** Conversion teinte → RVB (saturation et valeur à 1), pour les effets de couleur. */
export function hueToRgb(hue, saturation = 1) {
  const h = frac(hue) * 6;
  const sector = Math.floor(h);
  const f = h - sector;
  const q = 1 - f;
  let rgb;
  switch (sector % 6) {
    case 0: rgb = [1, f, 0]; break;
    case 1: rgb = [q, 1, 0]; break;
    case 2: rgb = [0, 1, f]; break;
    case 3: rgb = [0, q, 1]; break;
    case 4: rgb = [f, 0, 1]; break;
    default: rgb = [1, 0, q]; break;
  }
  // La saturation ramène progressivement vers le blanc.
  const s = Math.max(0, Math.min(1, saturation));
  return rgb.map((c) => c * s + (1 - s));
}

/**
 * Calcule la contribution d'un effet pour UNE fixture, à un instant donné.
 *
 * @param {Object} effect   Effet en cours ({ preset, bpm, size, spread, wave, direction })
 * @param {number} index    Rang de la fixture dans le groupe visé (pour le décalage)
 * @param {number} count    Nombre de fixtures visées
 * @param {number} seconds  Temps écoulé depuis le démarrage du serveur
 * @returns {{ mode: string, values: Record<string, number> }|null}
 */
export function evaluateEffect(effect, index, count, seconds) {
  const preset = EFFECT_PRESETS[effect.preset];
  if (!preset) return null;

  const direction = effect.direction < 0 ? -1 : 1;
  const cycles = seconds * ((effect.bpm ?? preset.bpm ?? 60) / 60) * direction;
  const size = Math.max(0, Math.min(1, effect.size ?? preset.size ?? 0.25));
  // Décalage de phase : réparti sur le groupe (0 = tout le monde en phase).
  const offset = count > 1 ? (index / count) * (effect.spread ?? preset.spread ?? 0) : 0;

  if (preset.hue) {
    const steps = preset.hue.steps;
    let hue = cycles + offset;
    if (steps > 0) hue = Math.floor(frac(hue) * steps) / steps;   // couleurs franches
    const [r, g, b] = hueToRgb(hue, size);
    return { mode: 'set', values: { red: r, green: g, blue: b } };
  }

  const values = {};
  for (const part of preset.parts) {
    const waveName = effect.wave && WAVEFORMS[effect.wave] ? effect.wave : part.wave;
    const wave = WAVEFORMS[waveName] || WAVEFORMS.sin;
    const phase = cycles * (part.freq ?? 1) + (part.phase ?? 0) + offset;
    const amplitude = size * (part.depth ?? 1);
    const w = wave(phase, index);
    // En 'multiply' on renvoie directement le facteur appliqué à la valeur de
    // base : 1 au sommet de l'onde, (1 - amplitude) au creux.
    values[part.attr] = preset.mode === 'multiply'
      ? 1 - amplitude * (1 - w) / 2        // modulation : 1 = pleine intensité, size = profondeur
      : w * amplitude / 2;                 // oscillation : size = amplitude crête à crête
  }
  return { mode: preset.mode, values };
}
