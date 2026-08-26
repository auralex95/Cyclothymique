/**
 * Pavé XY pan / tilt.
 *
 * Le déplacement est RELATIF (le point ne saute pas sous le doigt) : c'est
 * indispensable quand plusieurs lyres, à des positions différentes, sont
 * pilotées ensemble. Le mode "fine" divise la sensibilité par ~7 pour un
 * réglage au degré près (16 bits si le profil propose les canaux fine).
 *
 * Activation du mode fine : bouton dédié dans la vue, ou double-tap sur le pavé.
 */

import { h, draggable } from '../util.js';

const FINE_FACTOR = 0.14;

export function xyPad({ getPan, getTilt, getGhosts, onDelta, isFine, onToggleFine }) {
  const dot = h('.dot');
  const readout = h('.readout');
  const badge = h('.fine-badge.hidden', null, 'FINE');
  const ghostLayer = h('.ghosts');
  const node = h('.xypad', null, h('.cross-h'), h('.cross-v'), ghostLayer, dot, readout, badge);

  let lastTap = 0;

  draggable(node, {
    onStart: () => {
      // Double-tap : bascule le mode précision.
      const now = performance.now();
      if (now - lastTap < 320) onToggleFine?.();
      lastTap = now;
    },
    onMove: ({ dx, dy, w, h: height, first }) => {
      if (first) return;                       // le premier contact ne bouge rien
      const factor = isFine() ? FINE_FACTOR : 1;
      // Un balayage complet du pavé = toute la course pan (ou tilt).
      onDelta((dx / w) * factor, (-dy / height) * factor);
      node.refresh();
    }
  });

  node.refresh = () => {
    const pan = getPan(), tilt = getTilt();
    dot.style.left = `${pan * 100}%`;
    dot.style.top = `${(1 - tilt) * 100}%`;
    readout.textContent = `Pan ${(pan * 100).toFixed(1)} %   Tilt ${(tilt * 100).toFixed(1)} %`;
    node.classList.toggle('fine', !!isFine());
    badge.classList.toggle('hidden', !isFine());

    // Repères des autres projecteurs de la sélection.
    const ghosts = getGhosts?.() || [];
    if (ghosts.length !== ghostLayer.childElementCount) {
      ghostLayer.replaceChildren(...ghosts.map(() => h('.dot.ghost')));
    }
    ghosts.forEach((g, i) => {
      const el = ghostLayer.children[i];
      if (!el) return;
      el.style.left = `${g.pan * 100}%`;
      el.style.top = `${(1 - g.tilt) * 100}%`;
    });
  };

  node.refresh();
  return node;
}
