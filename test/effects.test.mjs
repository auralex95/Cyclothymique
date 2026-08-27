/** Tests du moteur d'effets : formes d'onde, cumul, non-destruction de la base. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WAVEFORMS, evaluateEffect, effectAttributes, defaultEffectSettings, hueToRgb } from '../shared/effects.js';
import { ShowEngine } from '../server/engine.js';

const PROFILE = {
  id: 'mh', name: 'Lyre test', channelCount: 8,
  channels: {
    pan: { channel: 1, fine: 2 }, tilt: { channel: 3, fine: 4 }, dimmer: { channel: 5 },
    red: { channel: 6 }, green: { channel: 7 }, blue: { channel: 8 }
  }
};

function makeEngine(effects = []) {
  const show = {
    universes: [{ id: 0, name: 'U1', net: 0, subNet: 0, universe: 0, mode: 'broadcast', target: '2.255.255.255', enabled: true }],
    fixtures: [
      { id: 'a', name: 'A', profileId: 'mh', universeId: 0, address: 1 },
      { id: 'b', name: 'B', profileId: 'mh', universeId: 0, address: 9 }
    ],
    groups: [], presets: [], effects, settings: { refreshRate: 30 }
  };
  const engine = new ShowEngine({ sender: { ready: true, sendUniverse() {} }, show, library: [PROFILE] });
  engine.setValues([
    { id: 'a', attr: 'pan', value: 0.5 }, { id: 'a', attr: 'tilt', value: 0.5 }, { id: 'a', attr: 'dimmer', value: 1 },
    { id: 'b', attr: 'pan', value: 0.5 }, { id: 'b', attr: 'tilt', value: 0.5 }, { id: 'b', attr: 'dimmer', value: 1 }
  ]);
  /** Rend la trame à l'instant t (secondes) et renvoie le buffer DMX. */
  engine.renderAt = (seconds) => {
    engine.startedAt = Date.now() - seconds * 1000;
    engine.render();
    return engine.buffers.get(0);
  };
  return engine;
}

test('chaque forme d’onde a le départ et l’amplitude attendus', () => {
  // sin et triangle partent du milieu en montant
  for (const name of ['sin', 'triangle']) {
    assert.ok(Math.abs(WAVEFORMS[name](0)) < 1e-9, `${name}(0) doit valoir 0`);
    assert.ok(WAVEFORMS[name](0.1) > 0, `${name} doit monter`);
    assert.ok(Math.abs(WAVEFORMS[name](0.25) - 1) < 1e-9, `${name} atteint son sommet au quart`);
  }
  // le créneau part en haut, la dent de scie part de son minimum et monte
  assert.equal(WAVEFORMS.square(0.1), 1);
  assert.equal(WAVEFORMS.square(0.6), -1);
  assert.equal(WAVEFORMS.saw(0), -1);
  assert.ok(Math.abs(WAVEFORMS.saw(0.5)) < 1e-9);
  assert.ok(WAVEFORMS.saw(0.99) > 0.97);
  // toutes restent bornées à -1…+1
  for (const [name, fn] of Object.entries(WAVEFORMS)) {
    for (let p = 0; p < 3; p += 0.017) {
      const v = fn(p, 1);
      assert.ok(v >= -1 && v <= 1, `${name} hors bornes à ${p.toFixed(2)} : ${v}`);
    }
  }
});

test('la forme aléatoire est stable dans un cycle et reproductible', () => {
  const a = WAVEFORMS.random(1.2, 3);
  assert.equal(WAVEFORMS.random(1.8, 3), a, 'même valeur dans le même cycle');
  assert.notEqual(WAVEFORMS.random(2.2, 3), a, 'valeur différente au cycle suivant');
  assert.notEqual(WAVEFORMS.random(1.2, 4), a, 'valeur différente d’une fixture à l’autre');
});

test('la taille d’un mouvement est l’amplitude crête à crête', () => {
  // 100 % = toute la course : depuis le centre, le sommet atteint 0.5 d’écart.
  assert.equal(evaluateEffect({ preset: 'panSweep', bpm: 60, size: 1, spread: 0 }, 0, 1, 0.25).values.pan, 0.5);
  assert.equal(evaluateEffect({ preset: 'panSweep', bpm: 60, size: 0.4, spread: 0 }, 0, 1, 0.25).values.pan, 0.2);
});

test('le cercle met le pan et le tilt en quadrature', () => {
  const at = (t) => evaluateEffect({ preset: 'circle', bpm: 60, size: 1, spread: 0 }, 0, 1, t).values;
  assert.ok(Math.abs(at(0).pan) < 1e-9 && Math.abs(at(0).tilt - 0.5) < 1e-9, 'à t=0 : tilt au sommet, pan nul');
  assert.ok(Math.abs(at(0.25).pan - 0.5) < 1e-9, 'un quart de cycle plus tard, pan au sommet');
});

test('le chase décale les projecteurs dans le temps', () => {
  const chase = { preset: 'dimmerChase', bpm: 60, size: 1, spread: 1 };
  assert.equal(evaluateEffect(chase, 0, 4, 0).values.dimmer, 1, 'premier allumé au départ');
  assert.equal(evaluateEffect(chase, 2, 4, 0).values.dimmer, 0, 'troisième éteint au départ');
  assert.equal(evaluateEffect(chase, 0, 4, 0.5).values.dimmer, 0);
  assert.equal(evaluateEffect(chase, 2, 4, 0.5).values.dimmer, 1);
});

test('la profondeur d’un effet de dimmer borne la modulation', () => {
  const half = { preset: 'dimmerPulse', bpm: 60, size: 0.5, spread: 0 };
  assert.equal(evaluateEffect(half, 0, 1, 0.25).values.dimmer, 1, 'sommet : pleine intensité');
  assert.equal(evaluateEffect(half, 0, 1, 0.75).values.dimmer, 0.5, 'creux : moitié de l’intensité');
});

test('l’arc-en-ciel parcourt les teintes', () => {
  const rainbow = { preset: 'rainbow', bpm: 60, size: 1, spread: 0 };
  assert.deepEqual(evaluateEffect(rainbow, 0, 1, 0).values, { red: 1, green: 0, blue: 0 });
  const third = evaluateEffect(rainbow, 0, 1, 1 / 3).values;
  assert.ok(third.green > 0.99 && third.red < 0.01, 'un tiers de cycle plus loin : vert');
  assert.deepEqual(hueToRgb(0, 0), [1, 1, 1], 'saturation nulle = blanc');
});

test('le chase couleur avance par paliers francs', () => {
  const steps = { preset: 'colorSteps', bpm: 60, size: 1, spread: 0 };
  assert.deepEqual(evaluateEffect(steps, 0, 1, 0.05).values, evaluateEffect(steps, 0, 1, 0.1).values, 'même palier');
  assert.notDeepEqual(evaluateEffect(steps, 0, 1, 0.05).values, evaluateEffect(steps, 0, 1, 0.3).values, 'palier suivant');
});

test('effectAttributes décrit les fonctions nécessaires', () => {
  assert.deepEqual(effectAttributes('circle'), ['pan', 'tilt']);
  assert.deepEqual(effectAttributes('rainbow'), ['red', 'green', 'blue']);
  assert.deepEqual(effectAttributes('dimmerPulse'), ['dimmer']);
  assert.equal(defaultEffectSettings('circle').enabled, true);
});

// ------------------------------------------------------------------ moteur

test('un mouvement oscille autour de la position réglée, sans l’écraser', () => {
  const engine = makeEngine([{ id: 'e1', preset: 'panSweep', fixtureIds: ['a'], bpm: 60, size: 0.4, spread: 0, direction: 1, enabled: true }]);

  const pan16 = (buf) => (buf[0] * 256 + buf[1]) / 65535;
  assert.ok(Math.abs(pan16(engine.renderAt(0.25)) - 0.7) < 0.002, 'sommet à 70 %');
  assert.ok(Math.abs(pan16(engine.renderAt(0.75)) - 0.3) < 0.002, 'creux à 30 %');

  // La valeur enregistrée n'a pas bougé : arrêter l'effet restitue la base.
  assert.equal(engine.getValue('a', 'pan'), 0.5);
  engine.show.effects[0].enabled = false;
  assert.ok(Math.abs(pan16(engine.renderAt(0.25)) - 0.5) < 0.002, 'base restaurée');
});

test('un effet ne touche que les projecteurs visés', () => {
  const engine = makeEngine([{ id: 'e1', preset: 'dimmerChase', fixtureIds: ['a'], bpm: 60, size: 1, spread: 0, direction: 1, enabled: true }]);
  const buf = engine.renderAt(0.75);      // creux du créneau
  assert.equal(buf[4], 0, 'A suit l’effet');
  assert.equal(buf[12], 255, 'B garde son intensité');
});

test('le sens inverse fait tourner l’effet à l’envers', () => {
  const engine = makeEngine([{ id: 'e1', preset: 'panSweep', fixtureIds: ['a'], bpm: 60, size: 0.4, spread: 0, direction: -1, enabled: true }]);
  const pan16 = (buf) => (buf[0] * 256 + buf[1]) / 65535;
  assert.ok(Math.abs(pan16(engine.renderAt(0.25)) - 0.3) < 0.002, 'sommet et creux inversés');
});

test('deux effets sur le même attribut se cumulent', () => {
  const engine = makeEngine([
    { id: 'e1', preset: 'panSweep', fixtureIds: ['a'], bpm: 60, size: 0.2, spread: 0, direction: 1, enabled: true },
    { id: 'e2', preset: 'panSweep', fixtureIds: ['a'], bpm: 60, size: 0.2, spread: 0, direction: 1, enabled: true }
  ]);
  const pan16 = (buf) => (buf[0] * 256 + buf[1]) / 65535;
  assert.ok(Math.abs(pan16(engine.renderAt(0.25)) - 0.7) < 0.002, '0,5 + 0,1 + 0,1');
});

test('le blackout coupe même pendant un effet de dimmer', () => {
  const engine = makeEngine([{ id: 'e1', preset: 'dimmerPulse', fixtureIds: ['a', 'b'], bpm: 60, size: 1, spread: 0, direction: 1, enabled: true }]);
  engine.blackout = true;
  const buf = engine.renderAt(0.25);       // sommet de l'effet
  assert.equal(buf[4], 0);
  assert.equal(buf[12], 0);
});

test('un effet de couleur remplace la couleur de base', () => {
  const engine = makeEngine([{ id: 'e1', preset: 'rainbow', fixtureIds: ['a'], bpm: 60, size: 1, spread: 0, direction: 1, enabled: true }]);
  engine.setValues([{ id: 'a', attr: 'red', value: 0 }, { id: 'a', attr: 'green', value: 0 }, { id: 'a', attr: 'blue', value: 1 }]);
  const buf = engine.renderAt(0);          // teinte 0 = rouge
  assert.deepEqual([buf[5], buf[6], buf[7]], [255, 0, 0]);
});

test('un effet visant une fixture supprimée est ignoré', () => {
  const engine = makeEngine([{ id: 'e1', preset: 'dimmerChase', fixtureIds: ['disparue'], bpm: 60, size: 1, spread: 0, direction: 1, enabled: true }]);
  const buf = engine.renderAt(0.75);
  assert.equal(buf[4], 255, 'les projecteurs restants ne sont pas affectés');
});
