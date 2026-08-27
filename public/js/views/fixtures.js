/**
 * Vue "Fixtures" : création et modification des profils de projecteurs
 * directement depuis l'interface — aucun fichier JSON à écrire à la main,
 * aucun redémarrage du serveur.
 *
 * L'éditeur raisonne canal par canal, comme une fiche technique : pour chaque
 * canal DMX de la fixture, on choisit la fonction qu'il pilote (et, pour les
 * fonctions continues, on peut désigner un second canal « fin » = 16 bits).
 */

import { h, mount, toast } from '../util.js';
import * as S from '../state.js';
import { send } from '../net.js';
import { ATTRIBUTES, attrMeta, GROUP_ORDER, GROUP_LABELS } from '/shared/attributes.js';

/** Les roues (couleur, gobo, shutter…) se pilotent par slots nommés. */
const isWheel = (attr) => attrMeta(attr).ui === 'wheel';
/** Seules les fonctions continues acceptent un canal fin (16 bits). */
const canBeFine = (attr) => ['fader', 'pad'].includes(attrMeta(attr).ui);

export function render(container) {
  const unsubs = [];
  let draft = null;        // profil en cours d'édition (null = aucun)
  let selectId = null;     // id du profil affiché dans la liste

  // ------------------------------------------------------- modèle de travail

  /** Profil du serveur → brouillon éditable (une ligne par canal DMX). */
  function toDraft(profile) {
    const rows = Array.from({ length: profile?.channelCount || 8 }, () => ({ fn: '' }));
    const defaults = {};
    for (const [attr, chan] of Object.entries(profile?.channels || {})) {
      if (rows[chan.channel - 1]) rows[chan.channel - 1].fn = attr;
      if (chan.fine && rows[chan.fine - 1]) rows[chan.fine - 1].fn = `${attr}.fine`;
      if (chan.default !== undefined) defaults[attr] = chan.default;
    }
    return {
      id: profile?.id || null,                       // null = nouveau profil
      name: profile?.name || '',
      shortName: profile?.shortName || '',
      manufacturer: profile?.manufacturer || '',
      model: profile?.model || '',
      notes: profile?.notes || '',
      channelCount: profile?.channelCount || 8,
      rows,
      defaults,
      wheels: JSON.parse(JSON.stringify(profile?.wheels || {}))
    };
  }

  /** Brouillon → profil envoyé au serveur (qui le revalide de son côté). */
  function toProfile(d) {
    const channels = {};
    const fines = {};
    d.rows.forEach((row, index) => {
      if (!row.fn) return;
      const channel = index + 1;
      if (row.fn.endsWith('.fine')) fines[row.fn.slice(0, -5)] = channel;
      else channels[row.fn] = { channel };
    });
    for (const [attr, fine] of Object.entries(fines)) {
      if (channels[attr]) channels[attr].fine = fine;
    }
    for (const [attr, value] of Object.entries(d.defaults)) {
      if (channels[attr] && value !== '' && value !== null) channels[attr].default = Number(value);
    }
    const wheels = {};
    for (const [attr, slots] of Object.entries(d.wheels)) {
      if (channels[attr] && slots.length) wheels[attr] = slots;
    }
    return {
      id: d.id || undefined,
      name: d.name, shortName: d.shortName, manufacturer: d.manufacturer,
      model: d.model, notes: d.notes, channelCount: d.channelCount,
      channels, wheels
    };
  }

  /** Canaux « fine » orphelins : signalés avant même d'appeler le serveur. */
  function localWarnings(d) {
    const warnings = [];
    const coarse = new Set(d.rows.filter((r) => r.fn && !r.fn.endsWith('.fine')).map((r) => r.fn));
    for (const row of d.rows) {
      if (row.fn.endsWith('.fine')) {
        const attr = row.fn.slice(0, -5);
        if (!coarse.has(attr)) warnings.push(`${attrMeta(attr).label} : canal fin sans canal principal`);
      }
    }
    return warnings;
  }

  // ------------------------------------------------------------- composants

  /**
   * Sélecteur de fonction. Les options sont construites une seule fois puis
   * clonées : une fixture de 512 canaux reste instantanée à afficher.
   */
  const selectTemplate = (() => {
    const select = document.createElement('select');
    select.append(new Option('— non utilisé —', ''));
    for (const group of GROUP_ORDER) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = GROUP_LABELS[group];
      for (const [attr, meta] of Object.entries(ATTRIBUTES)) {
        if (meta.group !== group) continue;
        optgroup.append(new Option(meta.label, attr));
        if (canBeFine(attr)) optgroup.append(new Option(`${meta.label} — canal fin (16 bits)`, `${attr}.fine`));
      }
      select.append(optgroup);
    }
    return select;
  })();

  function channelRow(row, index) {
    const select = selectTemplate.cloneNode(true);
    select.value = row.fn;
    select.addEventListener('change', () => { row.fn = select.value; drawEditor(); });

    const assigned = row.fn && !row.fn.endsWith('.fine') ? row.fn : null;
    const defaultInput = assigned && !isWheel(assigned)
      ? h('input', {
          type: 'number', min: '0', max: '100', step: '1',
          value: draft.defaults[assigned] !== undefined ? String(Math.round(draft.defaults[assigned] * 100)) : '',
          placeholder: '—',
          oninput: (ev) => {
            const v = ev.target.value;
            if (v === '') delete draft.defaults[assigned];
            else draft.defaults[assigned] = Math.max(0, Math.min(100, Number(v))) / 100;
          }
        })
      : h('span.muted', null, assigned ? 'slots' : '');

    return h('tr', null,
      h('td', { style: { width: '70px' } }, h('b', null, String(index + 1))),
      h('td', null, select),
      h('td', { style: { width: '120px' } }, defaultInput)
    );
  }

  /** Éditeur de slots d'une roue (nom + valeur DMX). */
  function wheelEditor(attr) {
    const slots = draft.wheels[attr] || (draft.wheels[attr] = []);
    return h('.panel', { style: { background: 'var(--panel-2)' } },
      h('h3', null, `Roue « ${attrMeta(attr).label} »`),
      slots.length
        ? h('div', null, slots.map((slot, i) => h('.row', { style: { marginBottom: '6px' } },
            h('input', {
              type: 'text', value: slot.name, placeholder: 'Nom du slot',
              style: { flex: '2 1 160px' },
              oninput: (ev) => { slot.name = ev.target.value; }
            }),
            h('input', {
              type: 'number', min: '0', max: '255', value: String(slot.value),
              style: { flex: '0 1 110px' },
              oninput: (ev) => { slot.value = Number(ev.target.value); }
            }),
            h('button.btn.small.danger', {
              type: 'button',
              onclick: () => { slots.splice(i, 1); drawEditor(); }
            }, '✕')
          )))
        : h('p.muted', null, 'Aucun slot : la fonction restera pilotable au curseur (valeur DMX brute).'),
      h('button.btn.small', {
        type: 'button',
        onclick: () => {
          const last = slots[slots.length - 1];
          slots.push({ name: `Slot ${slots.length + 1}`, value: last ? Math.min(255, last.value + 10) : 0 });
          drawEditor();
        }
      }, '+ Ajouter un slot')
    );
  }

  // ------------------------------------------------------------------ actions

  function saveDraft() {
    // Un canal fin orphelin serait silencieusement perdu à la conversion :
    // on refuse l'enregistrement plutôt que d'écrire un profil amputé.
    const warnings = localWarnings(draft);
    if (warnings.length) {
      toast(`Impossible d’enregistrer : ${warnings.join(' · ')}`, 6000);
      return;
    }
    const payload = toProfile(draft);
    send('fixture:save', payload, (result) => {
      if (!result?.ok) {
        toast(`Refusé : ${(result?.errors || ['erreur inconnue']).join(' · ')}`, 6000);
        return;
      }
      toast(`Profil « ${result.profile.name} » enregistré`);
      selectId = result.profile.id;
      draft = null;
      draw();
    });
  }

  function removeProfile(profile) {
    if (!confirm(`Supprimer définitivement le profil « ${profile.name} » ?`)) return;
    send('fixture:remove', profile.id, (result) => {
      if (!result?.ok) return toast((result?.errors || ['Suppression impossible']).join(' · '), 6000);
      toast('Profil supprimé');
      if (selectId === profile.id) { selectId = null; draft = null; }
      draw();
    });
  }

  /** Import d'un profil exporté depuis une autre installation. */
  function importProfile() {
    const input = h('input', { type: 'file', accept: 'application/json', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        const res = await fetch('/api/fixtures', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json)
        });
        const body = await res.json();
        if (!res.ok) throw new Error((body.errors || ['import refusé']).join(' · '));
        toast(`Profil « ${body.profile.name} » importé`);
      } catch (err) {
        toast(`Import impossible : ${err.message}`, 6000);
      }
    });
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  }

  // -------------------------------------------------------------------- rendu

  /** Nombre de projecteurs patchés utilisant un profil. */
  const usage = (id) => S.fixtures().filter((f) => f.profileId === id).length;

  function libraryPanel() {
    return h('.panel', null,
      h('h3', null, `Bibliothèque (${S.state.library.length})`),
      h('.row', { style: { marginBottom: '10px' } },
        h('button.btn.primary', {
          type: 'button',
          onclick: () => { draft = toDraft(null); selectId = null; draw(); }
        }, '+ Nouveau profil'),
        h('button.btn', { type: 'button', onclick: importProfile }, 'Importer')
      ),
      S.state.library.map((profile) => {
        const count = usage(profile.id);
        return h(`.profile-card${profile.id === selectId ? '.current' : ''}`, null,
          h('b', null, profile.name),
          h('.muted', null, `${profile.manufacturer || '—'} · ${profile.channelCount} canaux · ${Object.keys(profile.channels).length} fonctions`),
          h('.muted', null, count ? `utilisé par ${count} projecteur(s)` : 'non utilisé'),
          h('.actions', null,
            h('button.btn.small', {
              type: 'button',
              onclick: () => { selectId = profile.id; draft = toDraft(profile); draw(); }
            }, 'Modifier'),
            h('button.btn.small', {
              type: 'button',
              onclick: () => {
                const copy = toDraft(profile);
                copy.id = null;                       // un nouvel identifiant sera dérivé du nom
                copy.name = `${profile.name} (copie)`;
                draft = copy; selectId = null; draw();
              }
            }, 'Dupliquer'),
            h('a.btn.small', { href: `/api/fixtures/${profile.id}`, download: `${profile.id}.json` }, 'Exporter'),
            h('button.btn.small.danger', {
              type: 'button', disabled: count > 0,
              title: count ? 'Profil utilisé par le patch' : 'Supprimer',
              onclick: () => removeProfile(profile)
            }, 'Supprimer')
          )
        );
      })
    );
  }

  function editorPanel() {
    if (!draft) {
      return h('.panel', null, h('p.muted', null,
        'Choisissez un profil à modifier, ou créez-en un nouveau. ' +
        'Les modifications sont prises en compte immédiatement, sans redémarrer le serveur.'));
    }

    const warnings = localWarnings(draft);
    const wheelAttrs = [...new Set(draft.rows.map((r) => r.fn).filter((fn) => fn && !fn.endsWith('.fine')).filter(isWheel))];
    const usedCount = draft.rows.filter((r) => r.fn).length;

    return [
      h('.panel', null,
        h('h3', null, draft.id ? `Modifier « ${draft.name} »` : 'Nouveau profil'),
        h('.row', null,
          h('label.field', { style: { flex: '2 1 220px' } }, 'Nom *',
            h('input', {
              type: 'text', value: draft.name, placeholder: 'Lyre Beam 230 7R',
              oninput: (ev) => { draft.name = ev.target.value; }
            })),
          h('label.field', { style: { flex: '1 1 140px' } }, 'Nom court (patch)',
            h('input', {
              type: 'text', value: draft.shortName, placeholder: 'Beam 230',
              oninput: (ev) => { draft.shortName = ev.target.value; }
            })),
          h('label.field', { style: { flex: '1 1 140px' } }, 'Marque',
            h('input', {
              type: 'text', value: draft.manufacturer, placeholder: 'Générique',
              oninput: (ev) => { draft.manufacturer = ev.target.value; }
            })),
          h('label.field', { style: { flex: '1 1 130px' } }, 'Nombre de canaux *',
            h('input', {
              type: 'number', min: '1', max: '512', value: String(draft.channelCount),
              onchange: (ev) => {
                const n = Math.max(1, Math.min(512, Number(ev.target.value) || 1));
                draft.channelCount = n;
                // On conserve les assignations existantes en redimensionnant la liste.
                while (draft.rows.length < n) draft.rows.push({ fn: '' });
                draft.rows.length = n;
                drawEditor();
              }
            }))
        ),
        h('.row', { style: { marginTop: '8px' } },
          h('label.field', { style: { flex: '1 1 100%' } }, 'Note (optionnel)',
            h('input', {
              type: 'text', value: draft.notes, placeholder: 'Mode 16 canaux, pan 540°',
              oninput: (ev) => { draft.notes = ev.target.value; }
            }))
        ),
        draft.id ? h('p.muted', { style: { marginTop: '8px' } }, `Identifiant : ${draft.id} (inchangé lors d’un renommage)`) : null
      ),

      h('.panel', null,
        h('h3', null, `Assignation des canaux — ${usedCount} / ${draft.channelCount} utilisés`),
        h('p.muted', { style: { marginBottom: '8px' } },
          'Pour chaque canal de la fixture, choisissez la fonction pilotée. ' +
          'Un « canal fin » associé à une fonction active le 16 bits (mouvement fluide en pan/tilt). ' +
          'La colonne Défaut est la valeur appliquée au patch, en %.'),
        warnings.length ? h('p.warn-text', null, `⚠ ${warnings.join(' · ')}`) : null,
        h('table.patch', null,
          h('thead', null, h('tr', null,
            h('th', null, 'Canal'), h('th', null, 'Fonction'), h('th', null, 'Défaut')
          )),
          h('tbody', null, draft.rows.map(channelRow))
        )
      ),

      wheelAttrs.length
        ? h('.panel', null,
            h('h3', null, 'Roues et slots'),
            h('p.muted', { style: { marginBottom: '8px' } },
              'Les slots deviennent des boutons de sélection directe dans l’onglet Contrôle.'),
            wheelAttrs.map(wheelEditor))
        : null,

      h('.panel', null,
        h('.row', null,
          h('button.btn.primary', { type: 'button', onclick: saveDraft }, 'Enregistrer le profil'),
          h('button.btn', { type: 'button', onclick: () => { draft = null; draw(); } }, 'Annuler'),
          h('span.spacer'),
          draft.id && usage(draft.id)
            ? h('span.muted', null, `${usage(draft.id)} projecteur(s) patché(s) suivront la modification`)
            : null
        ))
    ];
  }

  /** Redessine uniquement l'éditeur (la liste ne bouge pas pendant la saisie). */
  function drawEditor() {
    const host = container.querySelector('.fixture-editor');
    if (host) mount(host, editorPanel());
    else draw();
  }

  function draw() {
    mount(container, h('.split', null,
      h('div', null, libraryPanel()),
      h('.fixture-editor', null, editorPanel())
    ));
  }

  draw();
  unsubs.push(S.on('library', draw));
  unsubs.push(S.on('show', () => { if (!draft) draw(); }));   // compteurs d'utilisation

  return () => unsubs.forEach((u) => u());
}
