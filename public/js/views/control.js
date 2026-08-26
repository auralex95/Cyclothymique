/**
 * Vue "Contrôle" : sélection des projecteurs + pilotage temps réel.
 *
 * Organisation :
 *   colonne gauche  → groupes, sélection des fixtures (grille tactile)
 *   colonne droite  → dimmer, pavé pan/tilt, couleur, faisceau, roues
 *
 * Toute action s'applique à la sélection courante. Les attributs absolus
 * (dimmer, couleur, zoom…) prennent la même valeur sur toutes les fixtures ;
 * le pan/tilt est appliqué en RELATIF, ce qui permet le mode "miroir".
 */

import { h, mount, pct, toast } from '../util.js';
import * as S from '../state.js';
import { sendValues, send } from '../net.js';
import { vFader, slider } from '../components/fader.js';
import { xyPad } from '../components/xypad.js';
import { colorPicker } from '../components/colorpicker.js';
import { attrMeta, GROUP_LABELS, COLOR_ATTRS, profileSupports } from '/shared/attributes.js';

export function render(container) {
  const refreshables = [];   // composants à rafraîchir quand les valeurs changent
  const unsubs = [];

  // ------------------------------------------------------------- application

  /** Applique une valeur identique à toutes les fixtures sélectionnées qui gèrent l'attribut. */
  function setAttr(attr, value) {
    const entries = [];
    for (const fx of S.selected()) {
      if (profileSupports(S.profileOf(fx), attr)) entries.push({ id: fx.id, attr, value });
    }
    if (entries.length) sendValues(entries);
  }

  /** Applique plusieurs attributs d'un coup (couleur). */
  function setAttrs(values) {
    const entries = [];
    for (const fx of S.selected()) {
      const profile = S.profileOf(fx);
      for (const [attr, value] of Object.entries(values)) {
        if (profileSupports(profile, attr)) entries.push({ id: fx.id, attr, value });
      }
    }
    if (entries.length) sendValues(entries);
  }

  /**
   * Déplacement relatif pan/tilt. En mode miroir, une fixture sur deux reçoit
   * l'inverse du pan : les lyres bougent en symétrie.
   */
  function movePanTilt(dPan, dTilt) {
    const entries = [];
    S.selected().forEach((fx, index) => {
      const channels = S.profileOf(fx)?.channels;
      if (!channels) return;
      const invert = S.state.mirror && index % 2 === 1;
      if (channels.pan) {
        const cur = S.valueOf(fx.id, 'pan') ?? 0.5;
        entries.push({ id: fx.id, attr: 'pan', value: clamp(cur + (invert ? -dPan : dPan)) });
      }
      if (channels.tilt) {
        const cur = S.valueOf(fx.id, 'tilt') ?? 0.5;
        entries.push({ id: fx.id, attr: 'tilt', value: clamp(cur + dTilt) });
      }
    });
    if (entries.length) sendValues(entries);
  }

  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // --------------------------------------------------------------- sélection

  function selectionPanel() {
    const grid = h('.fixture-grid', null, S.fixtures().map((fx) => {
      const profile = S.profileOf(fx);
      const level = h('i');
      const cell = h('button.fixture-cell', {
        type: 'button',
        class: S.state.selection.includes(fx.id) ? 'selected' : '',
        onclick: () => { S.toggleSelection(fx.id); }
      },
        h('.fx-name', null, fx.name),
        h('.fx-addr', null, `U${universeLabel(fx.universeId)} · ${fx.address}${profile ? ` · ${profile.channelCount}c` : ''}`),
        h('.fx-level', null, level)
      );
      // Petit bargraphe d'intensité, pour repérer d'un coup d'œil ce qui est allumé.
      cell.refresh = () => {
        const dim = S.valueOf(fx.id, 'dimmer');
        level.style.width = `${Math.round((dim ?? 0) * 100)}%`;
      };
      refreshables.push(cell);
      return cell;
    }));

    const groupChips = h('.row', null,
      h('button.chip', { type: 'button', onclick: () => S.setSelection(S.fixtures().map((f) => f.id)) }, 'Tout'),
      h('button.chip', { type: 'button', onclick: () => S.setSelection([]) }, 'Aucun'),
      S.groups().map((g) => h('button.chip', {
        type: 'button',
        onclick: () => { S.setSelection(g.fixtureIds); S.state.mirror = !!g.mirror; }
      }, g.name)),
      h('span.spacer'),
      h('button.chip', {
        type: 'button',
        class: S.state.mirror ? 'on' : '',
        onclick: (ev) => { S.state.mirror = !S.state.mirror; ev.target.classList.toggle('on', S.state.mirror); }
      }, 'Miroir'),
      h('button.chip', { type: 'button', onclick: saveGroup }, '+ Groupe')
    );

    return h('.panel', null,
      h('h3', null, `Sélection — ${S.state.selection.length} / ${S.fixtures().length}`),
      groupChips,
      h('div', { style: { height: '8px' } }),
      S.fixtures().length ? grid : h('p.muted', null, 'Aucun projecteur patché. Rendez-vous dans l’onglet Patch.')
    );
  }

  function saveGroup() {
    if (!S.state.selection.length) return toast('Sélectionnez d’abord des projecteurs');
    const name = prompt('Nom du groupe :', `Groupe ${S.groups().length + 1}`);
    if (!name) return;
    send('group:save', { name, fixtureIds: [...S.state.selection], mirror: S.state.mirror });
    toast(`Groupe « ${name} » enregistré`);
  }

  function universeLabel(id) {
    const u = S.universes().find((x) => x.id === id);
    return u ? u.universe + 1 : '?';
  }

  // ---------------------------------------------------------------- contrôle

  function controlPanel() {
    const attrs = S.selectionAttributes();
    if (!S.state.selection.length) {
      return h('.panel', null, h('p.muted', null, 'Sélectionnez un ou plusieurs projecteurs pour les piloter.'));
    }

    const blocks = [];

    // --- Intensité + position, côte à côte ---------------------------------
    const dimmer = attrs.includes('dimmer') || attrs.some((a) => COLOR_ATTRS.includes(a))
      ? track(vFader({
          title: 'Dimmer',
          get: () => S.selectionValue('dimmer', 0),
          set: (v) => setAttr('dimmer', v)
        }))
      : null;

    const hasPanTilt = attrs.includes('pan') || attrs.includes('tilt');
    const pad = hasPanTilt ? track(xyPad({
      getPan: () => S.selectionValue('pan', 0.5),
      getTilt: () => S.selectionValue('tilt', 0.5),
      getGhosts: () => S.selected().slice(1).map((fx) => ({
        pan: S.valueOf(fx.id, 'pan') ?? 0.5,
        tilt: S.valueOf(fx.id, 'tilt') ?? 0.5
      })),
      onDelta: movePanTilt,
      isFine: () => S.state.fine,
      onToggleFine: () => { S.state.fine = !S.state.fine; fineBtn?.classList.toggle('on', S.state.fine); }
    })) : null;

    let fineBtn = null;
    if (hasPanTilt) {
      fineBtn = h('button.btn.small', {
        type: 'button',
        class: S.state.fine ? 'on' : '',
        onclick: () => { S.state.fine = !S.state.fine; fineBtn.classList.toggle('on', S.state.fine); pad.refresh(); }
      }, 'Fine');
    }

    const positionTools = hasPanTilt ? h('.row', null,
      fineBtn,
      h('button.btn.small', { type: 'button', onclick: () => { setAttr('pan', 0.5); setAttr('tilt', 0.5); refreshAll(); } }, 'Centrer'),
      h('button.btn.small', {
        type: 'button',
        onclick: () => { // inverse le pan de la sélection autour du centre
          const entries = S.selected()
            .filter((fx) => S.profileOf(fx)?.channels.pan)
            .map((fx) => ({ id: fx.id, attr: 'pan', value: 1 - (S.valueOf(fx.id, 'pan') ?? 0.5) }));
          if (entries.length) { sendValues(entries); refreshAll(); }
        }
      }, 'Inverser pan'),
      attrs.includes('ptSpeed') ? null : null
    ) : null;

    if (dimmer || pad) {
      blocks.push(h('.panel', null,
        h('h3', null, 'Intensité & position'),
        h('div', { style: { display: 'grid', gridTemplateColumns: dimmer && pad ? '110px 1fr' : '1fr', gap: '12px', alignItems: 'start' } },
          dimmer,
          pad ? h('div', null, pad, positionTools) : null
        ),
        attrs.includes('shutter') ? wheelRow('shutter') : null
      ));
    }

    // --- Couleur ------------------------------------------------------------
    const picker = colorPicker({
      attrs,
      get: (attr) => S.selectionValue(attr, 0),
      set: (values) => setAttrs(values)
    });
    if (picker) {
      refreshables.push(picker);
      blocks.push(h('.panel', null, h('h3', null, 'Couleur'), picker,
        attrs.includes('colorWheel') ? wheelRow('colorWheel') : null,
        attrs.includes('cto') ? attrSlider('cto') : null
      ));
    }

    // --- Faisceau -----------------------------------------------------------
    const beamAttrs = ['zoom', 'focus', 'iris', 'frost', 'goboRotate', 'ptSpeed']
      .filter((a) => attrs.includes(a));
    const beamWheels = ['gobo', 'prism'].filter((a) => attrs.includes(a));
    if (beamAttrs.length || beamWheels.length) {
      blocks.push(h('.panel', null,
        h('h3', null, 'Faisceau'),
        beamWheels.map(wheelRow),
        beamAttrs.map(attrSlider)
      ));
    }

    // --- Autres attributs du profil non encore affichés ---------------------
    const shown = new Set(['dimmer', 'pan', 'tilt', 'shutter', 'colorWheel', 'cto', ...COLOR_ATTRS, ...beamAttrs, ...beamWheels]);
    const rest = attrs.filter((a) => !shown.has(a));
    if (rest.length) {
      blocks.push(h('.panel', null,
        h('h3', null, GROUP_LABELS.control),
        rest.map((attr) => (S.selectionWheelSlots(attr) ? wheelRow(attr) : attrSlider(attr)))
      ));
    }

    return blocks;
  }

  /** Slider d'un attribut continu de la sélection. */
  function attrSlider(attr, labelSuffix = '') {
    return track(slider({
      label: attrMeta(attr).label + labelSuffix,
      get: () => S.selectionValue(attr, attrMeta(attr).default),
      set: (v) => setAttr(attr, v),
      format: (v) => `${pct(v)} · ${Math.round(v * 255)}`
    }));
  }

  /** Boutons de sélection de slot pour une roue physique (couleur, gobo, shutter…). */
  function wheelRow(attr) {
    const slots = S.selectionWheelSlots(attr);
    if (!slots) return attrSlider(attr);
    const buttons = slots.map((slot) => {
      const value = slot.value / 255;
      const btn = h('button.btn.small', {
        type: 'button',
        onclick: () => { setAttr(attr, value); refreshAll(); }
      }, slot.name);
      btn.refresh = () => {
        const cur = S.selectionValue(attr, 0);
        btn.classList.toggle('on', Math.abs(cur - value) < 0.004);   // ±1 pas DMX
      };
      refreshables.push(btn);
      return btn;
    });
    return h('div', null,
      h('.slabel', { style: { fontSize: '12px', color: 'var(--muted)', marginBottom: '4px' } }, attrMeta(attr).label),
      h('.wheel-slots', null, buttons),
      attrSlider(attr, ' (valeur DMX)')
    );
  }

  /** Enregistre un composant pour qu'il soit rafraîchi à chaque changement de valeur. */
  function track(node) { refreshables.push(node); return node; }

  function refreshAll() {
    for (const node of refreshables) node.refresh?.();
  }

  // ------------------------------------------------------------------ rendu

  function draw() {
    refreshables.length = 0;
    mount(container, h('.split', null,
      h('div', null, selectionPanel()),
      // Les panneaux de contrôle se répartissent sur deux colonnes si la place le permet.
      h('.control-cols', null, controlPanel())
    ));
    refreshAll();   // état initial des boutons de roue, sliders, bargraphes…
  }

  draw();
  unsubs.push(S.on('selection', draw));
  unsubs.push(S.on('show', draw));
  unsubs.push(S.on('values', refreshAll));

  return () => unsubs.forEach((u) => u());
}
