/**
 * Vue "Debug" : visualisation des trames DMX réellement envoyées, univers par univers.
 *
 * Le serveur n'émet ces données que si au moins un client est sur cet onglet
 * (abonnement à la room "monitor"), à 10 Hz, pour ne pas alourdir le Wi-Fi.
 */

import { h, mount } from '../util.js';
import * as S from '../state.js';
import { send } from '../net.js';

export function render(container) {
  const unsubs = [];
  let current = S.universes()[0]?.id ?? 0;
  let cells = [];
  let grid = null;
  let info = null;

  send('monitor:subscribe', true);

  /** Plages occupées par les fixtures, pour colorer et légender la grille. */
  function patchMap(universeId) {
    const map = new Array(513).fill(null);
    for (const fx of S.fixtures()) {
      if (fx.universeId !== universeId) continue;
      const profile = S.profileOf(fx);
      const size = profile?.channelCount || 1;
      const attrByChannel = {};
      if (profile) {
        for (const [attr, chan] of Object.entries(profile.channels)) {
          attrByChannel[chan.channel] = attr;
          if (chan.fine) attrByChannel[chan.fine] = `${attr} fine`;
        }
      }
      for (let i = 0; i < size; i++) {
        const addr = fx.address + i;
        if (addr > 512) break;
        map[addr] = { name: fx.name, attr: attrByChannel[i + 1] || `canal ${i + 1}` };
      }
    }
    return map;
  }

  function draw() {
    const map = patchMap(current);
    cells = [];
    grid = h('.dmx-grid', null, Array.from({ length: 512 }, (_, i) => {
      const addr = i + 1;
      const patched = map[addr];
      const cell = h('.dmx-cell', {
        class: patched ? 'patched' : '',
        title: patched ? `${addr} — ${patched.name} · ${patched.attr}` : `Canal ${addr}`
      }, h('span', null, String(addr)), h('b', null, '0'));
      cells.push(cell);
      return cell;
    }));

    info = h('span.muted');

    mount(container,
      h('.panel', null,
        h('h3', null, 'Trames DMX envoyées'),
        h('.row', null,
          S.universes().map((u) => h('button.chip', {
            type: 'button',
            class: u.id === current ? 'on' : '',
            onclick: () => { current = u.id; draw(); }
          }, `${u.name} — Net ${u.net} / Sub ${u.subNet} / Uni ${u.universe}`)),
          h('span.spacer'),
          info
        ),
        h('p.muted', { style: { margin: '8px 0' } },
          'Les canaux encadrés sont patchés ; survolez (ou touchez) une case pour connaître le projecteur et la fonction.'),
        grid
      )
    );
  }

  /** Mise à jour des valeurs sans reconstruire le DOM (512 cases × 10 Hz). */
  function update(payload) {
    const universe = payload.find((u) => u.universeId === current);
    if (!universe || !cells.length) return;
    let active = 0;
    for (let i = 0; i < 512; i++) {
      const value = universe.data[i] || 0;
      const cell = cells[i];
      const b = cell.lastElementChild;
      if (b.textContent !== String(value)) b.textContent = String(value);
      const on = value > 0;
      if (on) active++;
      cell.classList.toggle('active', on);
    }
    const st = S.state.status?.artnet;
    info.textContent = `${active} canaux actifs · ${st?.refreshRate ?? '?'} Hz · ${st?.packetsSent ?? 0} paquets envoyés`;
  }

  draw();
  unsubs.push(S.on('monitor', update));
  unsubs.push(S.on('show', draw));

  return () => {
    send('monitor:subscribe', false);
    unsubs.forEach((u) => u());
  };
}
