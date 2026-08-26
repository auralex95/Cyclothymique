/**
 * Vue "Presets" : mémoires de looks rappelables en un tap.
 *
 * Un preset est un instantané des valeurs (toutes les fixtures, ou seulement
 * la sélection courante). Au rappel, le serveur effectue le fondu sur le temps
 * de fade choisi. Volontairement simple : pas de chaser programmable.
 */

import { h, mount, toast } from '../util.js';
import * as S from '../state.js';
import { send } from '../net.js';
import { slider } from '../components/fader.js';

const MAX_FADE = 20;   // secondes

export function render(container) {
  const unsubs = [];

  function draw() {
    const fadeSlider = slider({
      label: 'Temps de fade au rappel',
      get: () => S.state.fadeTime / MAX_FADE,
      set: (v) => { S.state.fadeTime = Math.round(v * MAX_FADE * 10) / 10; },
      format: (v) => `${(v * MAX_FADE).toFixed(1)} s`
    });

    const tiles = S.presets().map((preset) => {
      const count = Object.keys(preset.values || {}).length;
      return h('button.preset-tile', {
        type: 'button',
        style: { background: preset.color || '#3b82f6' },
        onclick: (ev) => {
          send('preset:recall', { id: preset.id, fadeTime: S.state.fadeTime });
          // On garde une référence : ev.currentTarget est remis à null dès la fin du handler.
          const tile = ev.currentTarget;
          tile.classList.add('flash');
          setTimeout(() => tile.classList.remove('flash'), 250);
        }
      },
        preset.name,
        h('small', null, `${count} proj.`),
        h('small', null, `défaut ${Number(preset.fadeTime ?? 0).toFixed(1)} s`)
      );
    });

    const editor = h('.panel', null,
      h('h3', null, 'Édition des presets'),
      S.presets().length
        ? h('div', null, S.presets().map((preset) => h('.row', { style: { marginBottom: '8px' } },
            h('input', {
              type: 'text', value: preset.name, style: { flex: '1 1 160px' },
              onchange: (ev) => send('preset:update', { id: preset.id, changes: { name: ev.target.value } })
            }),
            h('input', {
              type: 'color', value: preset.color || '#3b82f6',
              style: { width: '56px', height: '48px', background: 'transparent', border: 0 },
              oninput: (ev) => send('preset:update', { id: preset.id, changes: { color: ev.target.value } })
            }),
            h('label.inline', null, 'Fade',
              h('input', {
                type: 'number', min: '0', max: String(MAX_FADE), step: '0.1',
                value: String(preset.fadeTime ?? 0), style: { width: '90px' },
                onchange: (ev) => send('preset:update', { id: preset.id, changes: { fadeTime: Number(ev.target.value) } })
              })
            ),
            h('button.btn.small.danger', {
              type: 'button',
              onclick: () => { if (confirm(`Supprimer « ${preset.name} » ?`)) send('preset:remove', preset.id); }
            }, 'Supprimer')
          )))
        : h('p.muted', null, 'Aucun preset enregistré.')
    );

    mount(container,
      h('.panel', null,
        h('h3', null, 'Enregistrer un look'),
        h('.row', null,
          h('button.btn.primary', { type: 'button', onclick: () => record(false) }, 'Enregistrer TOUT'),
          h('button.btn', {
            type: 'button',
            disabled: !S.state.selection.length,
            onclick: () => record(true)
          }, `Enregistrer la sélection (${S.state.selection.length})`),
          h('span.spacer'),
          h('span.muted', null, 'Un preset portant le même nom est écrasé.')
        ),
        h('div', { style: { marginTop: '10px' } }, fadeSlider)
      ),
      h('.panel', null,
        h('h3', null, `Looks (${S.presets().length})`),
        S.presets().length
          ? h('.preset-grid', null, tiles)
          : h('p.muted', null, 'Réglez vos projecteurs dans l’onglet Contrôle puis enregistrez un look.')
      ),
      editor
    );
  }

  function record(selectionOnly) {
    const name = prompt('Nom du look :', `Look ${S.presets().length + 1}`);
    if (!name) return;
    send('preset:record', {
      name,
      fixtureIds: selectionOnly ? [...S.state.selection] : null,
      fadeTime: S.state.fadeTime
    });
    toast(`Look « ${name} » enregistré`);
  }

  draw();
  unsubs.push(S.on('show', draw));
  unsubs.push(S.on('selection', draw));

  return () => unsubs.forEach((u) => u());
}
