/**
 * Vue "Live" : écran d'exploitation, volontairement minimal.
 *
 * On n'y trouve que ce qui sert pendant le spectacle — rappeler un look,
 * mettre un effet en pause, couper — avec de très grandes cibles tactiles,
 * pensées pour l'écran du Raspberry Pi comme pour l'iPad.
 *
 * Toute la programmation (patch, profils, presets, effets, réseau) vit dans
 * le mode Régie, protégé par un code si l'utilisateur en a défini un.
 */

import { h, mount, pct, toast } from '../util.js';
import * as S from '../state.js';
import { send } from '../net.js';
import { slider } from '../components/fader.js';

const MAX_FADE = 20;

export function render(container) {
  const unsubs = [];

  function presetsPanel() {
    const presets = S.presets();
    if (!presets.length) {
      return h('.panel.live-looks', null,
        h('h3', null, 'Looks'),
        h('p.muted', null,
          'Aucun look enregistré. Passez en mode Régie pour programmer le spectacle.'));
    }

    return h('.panel.live-looks', null,
      h('h3', null, 'Looks'),
      h('.live-grid', null, presets.map((preset) => h('button.live-tile', {
        type: 'button',
        style: { background: preset.color || '#3b82f6' },
        onclick: (ev) => {
          send('preset:recall', { id: preset.id, fadeTime: S.state.fadeTime });
          const tile = ev.currentTarget;
          tile.classList.add('flash');
          setTimeout(() => tile.classList.remove('flash'), 250);
        }
      },
        preset.name,
        h('small', null, `${Number(S.state.fadeTime).toFixed(1)} s`)
      )))
    );
  }

  function fadePanel() {
    return h('.panel', null,
      h('.row', null,
        h('div', { style: { flex: '1 1 240px' } },
          slider({
            label: 'Temps de fondu au rappel',
            get: () => S.state.fadeTime / MAX_FADE,
            set: (v) => { S.state.fadeTime = Math.round(v * MAX_FADE * 10) / 10; },
            format: (v) => `${(v * MAX_FADE).toFixed(1)} s`
          })),
        h('.row', { style: { flex: '0 1 auto', marginTop: '10px' } },
          [0, 1, 3, 5, 10].map((seconds) => h('button.btn', {
            type: 'button',
            class: Math.abs(S.state.fadeTime - seconds) < 0.05 ? 'on' : '',
            onclick: () => { S.state.fadeTime = seconds; draw(); }
          }, seconds === 0 ? 'Sec' : `${seconds} s`)))
      )
    );
  }

  function effectsPanel() {
    const effects = S.state.show?.effects || [];
    if (!effects.length) return null;
    const running = effects.filter((e) => e.enabled).length;

    return h('.panel', null,
      h('.row', null,
        h('h3', { style: { margin: 0, flex: '1 1 auto' } }, `Effets (${running} / ${effects.length})`),
        running
          ? h('button.btn', {
              type: 'button',
              // Chaque effet est mis en pause individuellement : en mode Live on
              // ne supprime jamais un effet, on l'arrête seulement.
              onclick: () => {
                for (const effect of effects) {
                  if (effect.enabled) send('effect:update', { id: effect.id, changes: { enabled: false } });
                }
                toast('Effets en pause');
              }
            }, 'Tout mettre en pause')
          : null
      ),
      h('div', { style: { height: '8px' } }),
      h('.live-grid', null, effects.map((effect) => h('button.live-tile.small', {
        type: 'button',
        class: effect.enabled ? 'on' : '',
        onclick: () => send('effect:update', { id: effect.id, changes: { enabled: !effect.enabled } })
      },
        effect.name,
        h('small', null, effect.enabled ? 'en cours' : 'en pause')
      )))
    );
  }

  function statusPanel() {
    const st = S.state.status;
    const artnet = st?.artnet;
    const stale = !artnet?.ready || (artnet.lastSendAt && Date.now() - artnet.lastSendAt > 2000);
    return h('.panel', null,
      h('.row', null,
        h('span', { style: { flex: '1 1 auto' } },
          h('b', { style: { color: stale ? 'var(--warn)' : 'var(--accent-2)' } },
            stale ? 'Art-Net inactif' : 'Art-Net actif'),
          h('span.muted', null, `  ${artnet?.refreshRate ?? '?'} Hz · master ${pct(S.state.master)}`)
        )
      )
    );
  }

  function draw() {
    mount(container, presetsPanel(), effectsPanel(), fadePanel(), statusPanel());
  }

  draw();
  unsubs.push(S.on('show', draw));
  unsubs.push(S.on('master', draw));
  unsubs.push(S.on('status', draw));

  return () => unsubs.forEach((u) => u());
}
