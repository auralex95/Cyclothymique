/**
 * Vue "Effets" : mouvements, effets de dimmer et de couleur.
 *
 * Un effet s'applique à la sélection courante et tourne en continu côté
 * serveur. Il n'écrase pas les valeurs réglées à la main : il oscille autour
 * (position), module (intensité) ou remplace (couleur) — l'arrêter restitue
 * exactement la base.
 */

import { h, mount, pct, toast, throttle } from '../util.js';
import * as S from '../state.js';
import { send } from '../net.js';
import { slider } from '../components/fader.js';
import { EFFECT_PRESETS, FAMILY_LABELS, WAVEFORM_LABELS, effectAttributes } from '/shared/effects.js';
import { profileSupports } from '/shared/attributes.js';

const MAX_BPM = 300;

export function render(container) {
  const unsubs = [];
  // Un redessin pendant un glissé de fader casserait le geste : on attend la
  // fin du contact pour reprendre les valeurs du serveur.
  let dragging = false;
  let pendingRedraw = false;

  // --- envoi throttlé des réglages ----------------------------------------
  const pending = new Map();
  const flush = throttle(() => {
    for (const [id, changes] of pending) send('effect:update', { id, changes });
    pending.clear();
  }, 70);

  function update(id, changes) {
    pending.set(id, { ...(pending.get(id) || {}), ...changes });
    flush();
  }

  // --- ajout ---------------------------------------------------------------

  /** Projecteurs de la sélection réellement concernés par l'effet. */
  function eligibleTargets(presetId) {
    const attrs = effectAttributes(presetId);
    return S.selected()
      .filter((fx) => attrs.some((attr) => profileSupports(S.profileOf(fx), attr)))
      .map((fx) => fx.id);
  }

  function addEffect(presetId) {
    const preset = EFFECT_PRESETS[presetId];
    const fixtureIds = eligibleTargets(presetId);
    if (!S.state.selection.length) return toast('Sélectionnez d’abord des projecteurs (onglet Contrôle)');
    if (!fixtureIds.length) {
      return toast(`Aucun projecteur sélectionné ne gère ${FAMILY_LABELS[preset.family].toLowerCase()}`, 4000);
    }
    send('effect:add', { preset: presetId, fixtureIds });
    const ignored = S.state.selection.length - fixtureIds.length;
    toast(ignored
      ? `${preset.label} sur ${fixtureIds.length} projecteur(s) — ${ignored} ignoré(s), fonction absente`
      : `${preset.label} sur ${fixtureIds.length} projecteur(s)`);
  }

  function addPanel() {
    const families = {};
    for (const [id, preset] of Object.entries(EFFECT_PRESETS)) {
      (families[preset.family] ||= []).push([id, preset]);
    }

    return h('.panel', null,
      h('h3', null, `Ajouter un effet — ${S.state.selection.length} projecteur(s) sélectionné(s)`),
      !S.state.selection.length
        ? h('p.warn-text', null, 'Sélectionnez des projecteurs dans l’onglet Contrôle, puis revenez ici.')
        : null,
      Object.entries(families).map(([family, list]) => h('div', { style: { marginBottom: '10px' } },
        h('.slabel', { style: { fontSize: '12px', color: 'var(--muted)', marginBottom: '6px' } }, FAMILY_LABELS[family]),
        h('.row', null, list.map(([id, preset]) => h('button.btn', {
          type: 'button',
          title: preset.description,
          disabled: !S.state.selection.length,
          onclick: () => addEffect(id)
        }, preset.label)))
      ))
    );
  }

  // --- effets en cours ------------------------------------------------------

  function effectCard(effect) {
    const preset = EFFECT_PRESETS[effect.preset];
    if (!preset) return null;
    const isColor = !!preset.hue;
    const targets = effect.fixtureIds.length;

    return h(`.profile-card${effect.enabled ? '.current' : ''}`, null,
      h('.row', null,
        h('div', { style: { flex: '1 1 180px' } },
          h('b', null, effect.name),
          h('.muted', null, `${FAMILY_LABELS[preset.family]} · ${targets} projecteur(s)`)
        ),
        h('button.chip', {
          type: 'button',
          class: effect.enabled ? 'on' : '',
          onclick: () => send('effect:update', { id: effect.id, changes: { enabled: !effect.enabled } })
        }, effect.enabled ? 'En cours' : 'En pause'),
        h('button.btn.small', {
          type: 'button',
          onclick: () => send('effect:update', { id: effect.id, changes: { direction: effect.direction < 0 ? 1 : -1 } })
        }, effect.direction < 0 ? '◀ Sens inverse' : 'Sens normal ▶'),
        h('button.btn.small', {
          type: 'button',
          title: 'Sélectionner les projecteurs de cet effet',
          onclick: () => { S.setSelection(effect.fixtureIds); toast(`${targets} projecteur(s) sélectionné(s)`); }
        }, 'Cibler'),
        h('button.btn.small', {
          type: 'button',
          title: 'Appliquer cet effet à la sélection courante',
          disabled: !S.state.selection.length,
          onclick: () => {
            const fixtureIds = eligibleTargets(effect.preset);
            if (!fixtureIds.length) return toast('Aucun projecteur compatible dans la sélection', 4000);
            send('effect:update', { id: effect.id, changes: { fixtureIds } });
            toast(`Effet reporté sur ${fixtureIds.length} projecteur(s)`);
          }
        }, 'Réaffecter'),
        h('button.btn.small.danger', {
          type: 'button',
          onclick: () => send('effect:remove', effect.id)
        }, 'Supprimer')
      ),

      h('div', { style: { marginTop: '8px' } },
        slider({
          label: isColor ? 'Saturation' : 'Taille',
          get: () => effect.size,
          set: (v) => { effect.size = v; update(effect.id, { size: v }); },
          format: pct
        }),
        slider({
          label: 'Vitesse',
          get: () => effect.bpm / MAX_BPM,
          set: (v) => { effect.bpm = Math.max(1, Math.round(v * MAX_BPM)); update(effect.id, { bpm: effect.bpm }); },
          format: (v) => `${Math.max(1, Math.round(v * MAX_BPM))} BPM`
        }),
        slider({
          label: 'Décalage entre projecteurs',
          get: () => effect.spread / 2,
          set: (v) => { effect.spread = Math.round(v * 2 * 100) / 100; update(effect.id, { spread: effect.spread }); },
          format: (v) => `${Math.round(v * 2 * 360)}°`
        })
      ),

      !isColor
        ? h('.row', null,
            h('label.field', { style: { flex: '1 1 200px' } }, 'Forme d’onde',
              h('select', {
                onchange: (ev) => send('effect:update', { id: effect.id, changes: { wave: ev.target.value } })
              }, Object.entries(WAVEFORM_LABELS).map(([value, label]) =>
                h('option', { value, selected: value === effect.wave }, label))))
          )
        : null,

      h('p.muted', { style: { marginTop: '6px' } }, preset.description)
    );
  }

  function runningPanel() {
    const effects = S.state.show?.effects || [];
    return h('.panel', null,
      h('.row', null,
        h('h3', { style: { margin: 0, flex: '1 1 auto' } }, `Effets en cours (${effects.filter((e) => e.enabled).length} / ${effects.length})`),
        effects.length
          ? h('button.btn.small.danger', {
              type: 'button',
              onclick: () => { if (confirm('Arrêter et supprimer tous les effets ?')) send('effect:clear'); }
            }, 'Tout arrêter')
          : null
      ),
      h('div', { style: { height: '8px' } }),
      effects.length
        ? h('.effect-grid', null, effects.map(effectCard))
        : h('p.muted', null,
            'Aucun effet. Les effets tournent en continu et ne modifient pas les valeurs réglées à la main : ' +
            'les arrêter restitue exactement la position, la couleur et l’intensité de départ. ' +
            'Ils sont mémorisés avec les looks (onglet Presets).')
    );
  }

  // ------------------------------------------------------------------- rendu

  function draw() {
    if (dragging) { pendingRedraw = true; return; }
    pendingRedraw = false;
    mount(container, addPanel(), runningPanel());
  }

  const onDown = () => { dragging = true; };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    if (pendingRedraw) draw();
  };
  container.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  draw();
  unsubs.push(S.on('show', draw));
  unsubs.push(S.on('selection', draw));

  return () => {
    container.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    unsubs.forEach((u) => u());
  };
}
