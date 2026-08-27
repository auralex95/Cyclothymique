/**
 * Sélecteur de couleur pour projecteurs à LED.
 *
 * Trois façons d'agir, de la plus rapide à la plus fine :
 *   1. pastilles prédéfinies (un tap = couleur posée) ;
 *   2. sélecteur natif iOS/desktop (roue de couleur système) ;
 *   3. sliders par composante réellement présente sur le profil (R, V, B, W, A, UV).
 */

import { h, pct, hexToRgb, rgbToHex } from '../util.js';
import { slider } from './fader.js';
import { COLOR_ATTRS, attrMeta } from '/shared/attributes.js';

/** Pastilles usuelles en régie. Le blanc dédié est géré par le canal W si présent. */
const SWATCHES = [
  ['Blanc', 255, 255, 255], ['Ambre', 255, 170, 60], ['Rouge', 255, 0, 0],
  ['Orange', 255, 90, 0], ['Jaune', 255, 220, 0], ['Vert', 0, 255, 0],
  ['Cyan', 0, 220, 255], ['Bleu', 0, 60, 255], ['Lavande', 150, 120, 255],
  ['Magenta', 255, 0, 200], ['Rose', 255, 120, 160], ['Éteint', 0, 0, 0]
];

/**
 * @param {Object} opts
 * @param {string[]} opts.attrs  Attributs couleur disponibles sur la sélection
 * @param {(attr:string)=>number} opts.get
 * @param {(values:Record<string, number>)=>void} opts.set  Applique plusieurs composantes d'un coup
 */
export function colorPicker({ attrs, get, set }) {
  const available = COLOR_ATTRS.filter((a) => attrs.includes(a));
  if (!available.length) return null;

  const hasRGB = ['red', 'green', 'blue'].every((a) => available.includes(a));

  // --- pastilles ---------------------------------------------------------
  const swatches = h('.swatches', null, SWATCHES.map(([name, r, g, b]) =>
    h('button.swatch', {
      type: 'button',
      title: name,
      style: { background: rgbToHex(r, g, b) },
      onclick: () => {
        const values = {};
        if (hasRGB) Object.assign(values, { red: r / 255, green: g / 255, blue: b / 255 });
        // Une pastille "blanc" utilise le canal blanc dédié quand il existe.
        if (available.includes('white')) values.white = (r === 255 && g === 255 && b === 255) ? 1 : 0;
        if (available.includes('amber')) values.amber = 0;
        if (available.includes('uv')) values.uv = 0;
        set(values);
        node.refresh();
      }
    })
  ));

  // --- sélecteur natif ---------------------------------------------------
  const native = h('input', {
    type: 'color',
    style: { width: '100%', height: '48px', background: 'transparent', border: '0' },
    oninput: (ev) => {
      const { r, g, b } = hexToRgb(ev.target.value);
      set({ red: r / 255, green: g / 255, blue: b / 255 });
      sliders.forEach((s) => s.refresh());
    }
  });

  // --- sliders par composante -------------------------------------------
  const sliders = available.map((attr) => slider({
    label: attrMeta(attr).label,
    className: attr,
    get: () => get(attr) ?? 0,
    set: (v) => set({ [attr]: v }),
    format: (v) => `${pct(v)} · ${Math.round(v * 255)}`
  }));

  const node = h('.colorpicker', null,
    swatches,
    hasRGB ? h('.row', null, h('span.muted', null, 'Roue système'), native) : null,
    sliders
  );

  node.refresh = () => {
    sliders.forEach((s) => s.refresh());
    if (hasRGB) {
      native.value = rgbToHex((get('red') ?? 0) * 255, (get('green') ?? 0) * 255, (get('blue') ?? 0) * 255);
    }
  };
  node.refresh();
  return node;
}
