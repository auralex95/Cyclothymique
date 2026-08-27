/** Tests de l'éditeur de profils : validation, assainissement, prise en compte à chaud. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateProfile, slugify, supportsFine } from '../server/fixtureProfile.js';
import { ShowEngine } from '../server/engine.js';

test('slugify produit un identifiant de fichier sûr', () => {
  assert.equal(slugify('Générique — Lyre Wash 12ch'), 'generique-lyre-wash-12ch');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('   '), '');
});

test('un profil complet est accepté et normalisé', () => {
  const { profile, errors } = validateProfile({
    name: 'Lyre Beam 7R',
    channelCount: 6,
    channels: {
      pan: { channel: 1, fine: 2 },
      tilt: { channel: 3, fine: 4 },
      dimmer: { channel: 5, default: 0 },
      gobo: { channel: 6 }
    },
    wheels: { gobo: [{ name: 'Ouvert', value: 0 }, { name: 'Gobo 1', value: 10 }] }
  });

  assert.deepEqual(errors, []);
  assert.equal(profile.id, 'lyre-beam-7r');
  assert.equal(profile.shortName, 'Lyre Beam 7R');       // repli sur le nom
  assert.equal(profile.manufacturer, 'Personnalisé');
  assert.deepEqual(profile.channels.pan, { channel: 1, fine: 2 });
  assert.equal(profile.wheels.gobo.length, 2);
});

test('un canal utilisé deux fois est refusé', () => {
  const { profile, errors } = validateProfile({
    name: 'Doublon', channelCount: 4,
    channels: { dimmer: { channel: 1 }, red: { channel: 1 } }
  });
  assert.equal(profile, null);
  assert.ok(errors.some((e) => e.includes('deux fois')), errors.join(' | '));
});

test('un canal hors de la fixture est refusé', () => {
  const { errors } = validateProfile({ name: 'Trop loin', channelCount: 4, channels: { dimmer: { channel: 9 } } });
  assert.ok(errors.some((e) => e.includes('hors de la fixture')), errors.join(' | '));
});

test('seules les fonctions continues acceptent un canal fin', () => {
  assert.equal(supportsFine('pan'), true);
  assert.equal(supportsFine('zoom'), true);
  assert.equal(supportsFine('gobo'), false);
  const { errors } = validateProfile({
    name: 'Roue fine', channelCount: 4, channels: { gobo: { channel: 1, fine: 2 } }
  });
  assert.ok(errors.some((e) => e.includes('canal fin')), errors.join(' | '));
});

test('une fonction inconnue est refusée', () => {
  const { errors } = validateProfile({ name: 'Inconnu', channelCount: 2, channels: { laser: { channel: 1 } } });
  assert.ok(errors.some((e) => e.includes('Fonction inconnue')), errors.join(' | '));
});

test('un slot de roue sans canal correspondant est refusé', () => {
  const { errors } = validateProfile({
    name: 'Slot orphelin', channelCount: 2,
    channels: { dimmer: { channel: 1 } },
    wheels: { gobo: [{ name: 'Ouvert', value: 0 }] }
  });
  assert.ok(errors.some((e) => e.includes('aucun canal')), errors.join(' | '));
});

test('les valeurs de slot hors 0…255 sont refusées', () => {
  const { errors } = validateProfile({
    name: 'Slot faux', channelCount: 2,
    channels: { gobo: { channel: 1 } },
    wheels: { gobo: [{ name: 'Trop', value: 300 }] }
  });
  assert.ok(errors.some((e) => e.includes('0 et 255')), errors.join(' | '));
});

test('modifier un profil conserve les valeurs des fonctions maintenues', () => {
  const before = validateProfile({
    name: 'Évolutif', channelCount: 4,
    channels: { dimmer: { channel: 1 }, red: { channel: 2 }, green: { channel: 3 } }
  }).profile;

  const library = [before];
  const show = {
    universes: [{ id: 0, name: 'U1', net: 0, subNet: 0, universe: 0, mode: 'broadcast', target: '2.255.255.255', enabled: true }],
    fixtures: [{ id: 'f1', name: 'P1', profileId: before.id, universeId: 0, address: 1 }],
    groups: [], presets: [], settings: { refreshRate: 30 }
  };
  const engine = new ShowEngine({ sender: { ready: true, sendUniverse() {} }, show, library });

  engine.setValues([{ id: 'f1', attr: 'dimmer', value: 1 }, { id: 'f1', attr: 'red', value: 0.5 }]);

  // Le profil évolue : « green » disparaît, « blue » et « zoom » apparaissent.
  const after = validateProfile({
    id: before.id, name: 'Évolutif', channelCount: 4,
    channels: { dimmer: { channel: 1 }, red: { channel: 2 }, blue: { channel: 3 }, zoom: { channel: 4, default: 0.25 } }
  }).profile;
  library[0] = after;
  engine.refreshProfile(after.id);

  assert.equal(engine.getValue('f1', 'dimmer'), 1, 'valeur conservée');
  assert.equal(engine.getValue('f1', 'red'), 0.5, 'valeur conservée');
  assert.equal(engine.getValue('f1', 'green'), undefined, 'fonction retirée');
  assert.equal(engine.getValue('f1', 'zoom'), 0.25, 'nouvelle fonction à son défaut');
});
