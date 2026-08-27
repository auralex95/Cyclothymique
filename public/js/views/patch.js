/**
 * Vue "Patch" : assigner des projecteurs à un univers Art-Net et une adresse DMX.
 *
 * - patch en série (ex : 8 lyres à la suite) avec calcul automatique des adresses ;
 * - détection des chevauchements d'adresses (lignes en rouge) ;
 * - export / import du show complet en JSON.
 */

import { h, mount, toast } from '../util.js';
import * as S from '../state.js';
import { send } from '../net.js';

export function render(container) {
  const unsubs = [];
  // Mémorise le formulaire entre deux redessins (le patch en série reste fluide).
  const form = { profileId: null, universeId: 0, address: null, count: 1, step: 0, name: '' };

  /** Première adresse libre dans un univers pour un profil donné. */
  function nextFreeAddress(universeId, channelCount) {
    const used = new Array(513).fill(false);
    for (const fx of S.fixtures()) {
      if (fx.universeId !== universeId) continue;
      const size = S.profileOf(fx)?.channelCount || 1;
      for (let i = fx.address; i < fx.address + size && i <= 512; i++) used[i] = true;
    }
    for (let start = 1; start + channelCount - 1 <= 512; start++) {
      let free = true;
      for (let i = start; i < start + channelCount; i++) if (used[i]) { free = false; break; }
      if (free) return start;
    }
    return 1;
  }

  /** Ensemble des ids de fixtures dont la plage DMX en chevauche une autre. */
  function conflicts() {
    const bad = new Set();
    const list = S.fixtures().map((fx) => ({
      fx, size: S.profileOf(fx)?.channelCount || 1
    }));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.fx.universeId !== b.fx.universeId) continue;
        const aEnd = a.fx.address + a.size - 1, bEnd = b.fx.address + b.size - 1;
        if (a.fx.address <= bEnd && b.fx.address <= aEnd) { bad.add(a.fx.id); bad.add(b.fx.id); }
      }
    }
    return bad;
  }

  function draw() {
    const library = S.state.library;
    if (!form.profileId && library.length) form.profileId = library[0].id;
    const profile = library.find((p) => p.id === form.profileId);
    const channelCount = profile?.channelCount || 1;
    if (form.address === null) form.address = nextFreeAddress(form.universeId, channelCount);

    // ---------------------------------------------------------- formulaire
    const addressInput = h('input', {
      type: 'number', min: '1', max: '512', value: String(form.address),
      oninput: (ev) => { form.address = Number(ev.target.value); summary.textContent = summaryText(); }
    });

    const summary = h('span.muted');
    const summaryText = () => {
      const step = form.step > 0 ? form.step : channelCount;
      const last = form.address + step * (form.count - 1) + channelCount - 1;
      return `${form.count} × ${channelCount} canaux · adresses ${form.address} → ${Math.min(last, 512)}` +
             (last > 512 ? ' (dépassement : les fixtures hors univers seront ignorées)' : '');
    };
    summary.textContent = summaryText();

    const addForm = h('.panel', null,
      h('h3', null, 'Ajouter des projecteurs'),
      h('.row', null,
        h('label.field', { style: { flex: '2 1 240px' } }, 'Profil',
          h('select', {
            onchange: (ev) => {
              form.profileId = ev.target.value;
              form.address = nextFreeAddress(form.universeId, S.state.library.find((p) => p.id === form.profileId)?.channelCount || 1);
              draw();
            }
          }, library.map((p) => h('option', { value: p.id, selected: p.id === form.profileId }, `${p.name} (${p.channelCount}c)`)))
        ),
        h('label.field', { style: { flex: '1 1 130px' } }, 'Univers',
          h('select', {
            onchange: (ev) => {
              form.universeId = Number(ev.target.value);
              form.address = nextFreeAddress(form.universeId, channelCount);
              draw();
            }
          }, S.universes().map((u) => h('option', { value: String(u.id), selected: u.id === form.universeId }, u.name)))
        ),
        h('label.field', { style: { flex: '1 1 110px' } }, 'Adresse', addressInput),
        h('label.field', { style: { flex: '1 1 90px' } }, 'Quantité',
          h('input', {
            type: 'number', min: '1', max: '64', value: String(form.count),
            oninput: (ev) => { form.count = Math.max(1, Number(ev.target.value) || 1); summary.textContent = summaryText(); }
          })
        ),
        h('label.field', { style: { flex: '1 1 110px' } }, 'Pas (0 = auto)',
          h('input', {
            type: 'number', min: '0', max: '512', value: String(form.step),
            oninput: (ev) => { form.step = Math.max(0, Number(ev.target.value) || 0); summary.textContent = summaryText(); }
          })
        ),
        h('label.field', { style: { flex: '2 1 180px' } }, 'Nom (optionnel)',
          h('input', { type: 'text', value: form.name, placeholder: profile?.name || '', oninput: (ev) => { form.name = ev.target.value; } })
        )
      ),
      h('.row', { style: { marginTop: '10px' } },
        h('button.btn.primary', {
          type: 'button',
          onclick: () => {
            send('patch:add', { ...form });
            toast(`${form.count} projecteur(s) patché(s)`);
            form.name = '';
            // L'adresse libre suivante est recalculée au prochain rendu.
            form.address = null;
          }
        }, 'Patcher'),
        h('button.btn', {
          type: 'button',
          onclick: () => { form.address = nextFreeAddress(form.universeId, channelCount); draw(); }
        }, 'Adresse libre suivante'),
        h('span.spacer'), summary
      )
    );

    // ------------------------------------------------------------- tableau
    const bad = conflicts();
    const rows = S.fixtures().map((fx) => {
      const profileOfFx = S.profileOf(fx);
      const size = profileOfFx?.channelCount || 1;
      return h('tr', { class: bad.has(fx.id) ? 'conflict' : '' },
        h('td', { style: { width: '26%' } },
          h('input', {
            type: 'text', value: fx.name,
            onchange: (ev) => send('patch:update', { id: fx.id, changes: { name: ev.target.value } })
          })
        ),
        h('td', { style: { width: '24%' } },
          h('select', {
            onchange: (ev) => send('patch:update', { id: fx.id, changes: { profileId: ev.target.value } })
          }, S.state.library.map((p) => h('option', { value: p.id, selected: p.id === fx.profileId }, p.name)))
        ),
        h('td', { style: { width: '16%' } },
          h('select', {
            onchange: (ev) => send('patch:update', { id: fx.id, changes: { universeId: Number(ev.target.value) } })
          }, S.universes().map((u) => h('option', { value: String(u.id), selected: u.id === fx.universeId }, u.name)))
        ),
        h('td', { style: { width: '14%' } },
          h('input', {
            type: 'number', min: '1', max: '512', value: String(fx.address),
            onchange: (ev) => send('patch:update', { id: fx.id, changes: { address: Number(ev.target.value) } })
          })
        ),
        h('td.muted', { style: { width: '12%' } }, `${fx.address} → ${Math.min(fx.address + size - 1, 512)}`),
        h('td', { style: { width: '8%' } },
          h('button.btn.small.danger', {
            type: 'button',
            onclick: () => { if (confirm(`Supprimer « ${fx.name} » ?`)) send('patch:remove', fx.id); }
          }, '✕')
        )
      );
    });

    const table = h('.panel', null,
      h('h3', null, `Patch (${S.fixtures().length} projecteurs)`),
      bad.size ? h('p.warn-text', null, '⚠ Chevauchement d’adresses détecté (lignes en rouge).') : null,
      S.fixtures().length
        ? h('table.patch', null,
            h('thead', null, h('tr', null,
              h('th', null, 'Nom'), h('th', null, 'Profil'), h('th', null, 'Univers'),
              h('th', null, 'Adresse'), h('th', null, 'Plage'), h('th', null, '')
            )),
            h('tbody', null, rows)
          )
        : h('p.muted', null, 'Patch vide.'),
      h('.row', { style: { marginTop: '10px' } },
        h('a.btn', { href: '/api/show', download: 'show.json' }, 'Exporter le show (JSON)'),
        h('button.btn', { type: 'button', onclick: importShow }, 'Importer un show'),
        h('span.spacer'),
        h('button.btn.danger', {
          type: 'button',
          onclick: () => { if (confirm('Effacer le patch, les groupes et les presets ?')) send('show:reset'); }
        }, 'Tout effacer')
      )
    );

    mount(container, addForm, table, libraryPanel());
  }

  /** Aperçu de la bibliothèque de profils disponible (data/fixtures/*.json). */
  function libraryPanel() {
    return h('.panel', null,
      h('h3', null, `Bibliothèque de profils (${S.state.library.length})`),
      h('.row', null, S.state.library.map((p) => h('div', {
        style: { flex: '1 1 220px', background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: '12px', padding: '10px' }
      },
        h('b', null, p.name),
        h('.muted', null, `${p.manufacturer || '—'} · ${p.channelCount} canaux`),
        h('.muted', null, Object.keys(p.channels).join(', '))
      ))),
      h('p.muted', { style: { marginTop: '8px' } },
        'Pour créer ou modifier un profil, rendez-vous dans l’onglet Fixtures — la prise en compte est immédiate.')
    );
  }

  function importShow() {
    const input = h('input', { type: 'file', accept: 'application/json', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        const res = await fetch('/api/show', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json)
        });
        if (!res.ok) throw new Error((await res.json()).error || 'import refusé');
        toast('Show importé');
      } catch (err) {
        toast(`Import impossible : ${err.message}`, 4000);
      }
    });
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  }

  draw();
  unsubs.push(S.on('show', draw));
  return () => unsubs.forEach((u) => u());
}
