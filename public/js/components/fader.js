/**
 * Faders tactiles (horizontal, vertical, slider générique).
 *
 * Comportement : la valeur suit le doigt (positionnement absolu), ce qui est le
 * geste attendu sur tablette. Chaque composant expose une méthode `refresh()`
 * pour se remettre à jour quand la valeur change ailleurs (preset, autre iPad).
 */

import { h, draggable, clamp01, pct } from '../util.js';

/** Fader horizontal appliqué à un élément existant (utilisé pour le master). */
export function attachHFader(el, { get, set }) {
  const fill = h('.fill');
  el.replaceChildren(fill);

  draggable(el, {
    onMove: ({ x, w }) => {
      const v = clamp01(x / w);
      set(v);
      fill.style.width = `${v * 100}%`;
    }
  });

  el.refresh = () => { fill.style.width = `${clamp01(get()) * 100}%`; };
  el.refresh();
  return el;
}

/** Fader vertical (dimmer d'une fixture ou d'une sélection). */
export function vFader({ title = 'Dimmer', get, set }) {
  const fill = h('.fill');
  const label = h('.label');
  const node = h('.vfader', null, h('.title', null, title), fill, label);

  draggable(node, {
    onMove: ({ y, h: height }) => {
      const v = clamp01(1 - y / height);   // le haut du fader = 100 %
      set(v);
      paint(v);
    }
  });

  function paint(v) {
    fill.style.height = `${clamp01(v) * 100}%`;
    label.textContent = pct(v);
  }

  node.refresh = () => paint(get());
  node.refresh();
  return node;
}

/**
 * Slider horizontal générique (zoom, focus, iris, composantes couleur…).
 * `format` permet d'afficher des % ou une valeur DMX brute.
 */
export function slider({ label, className = '', get, set, format = pct }) {
  const fill = h('.fill');
  const value = h('span');
  const track = h('.track', null, fill);
  const node = h(`.slider${className ? `.${className}` : ''}`, null,
    h('.slabel', null, h('span', null, label), value),
    track
  );

  draggable(track, {
    onMove: ({ x, w }) => {
      const v = clamp01(x / w);
      set(v);
      paint(v);
    }
  });

  function paint(v) {
    fill.style.width = `${clamp01(v) * 100}%`;
    value.textContent = format(v);
  }

  node.refresh = () => paint(get());
  node.refresh();
  return node;
}
