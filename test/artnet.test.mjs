/**
 * Tests du module Art-Net et du rendu DMX.
 * Lancement :  npm test   (utilise le lanceur de tests intégré à Node ≥ 18)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArtDmx, buildArtPoll, parseArtPollReply, portAddress } from '../server/artnet.js';
import { ShowEngine } from '../server/engine.js';

test('portAddress combine Net / Sub-Net / Universe sur 15 bits', () => {
  assert.equal(portAddress(0, 0, 0), 0x0000);
  assert.equal(portAddress(0, 0, 5), 0x0005);
  assert.equal(portAddress(0, 2, 3), 0x0023);
  assert.equal(portAddress(1, 2, 3), 0x0123);
  assert.equal(portAddress(127, 15, 15), 0x7fff);
});

test('buildArtDmx produit un paquet conforme à la spec Art-Net 4', () => {
  const data = Buffer.alloc(512);
  data[0] = 255; data[511] = 42;
  const pkt = buildArtDmx({ net: 1, subNet: 2, universe: 3, sequence: 7, data });

  assert.equal(pkt.length, 18 + 512);
  assert.equal(pkt.subarray(0, 8).toString('latin1'), 'Art-Net\0');
  assert.equal(pkt.readUInt16LE(8), 0x5000, 'OpCode ArtDMX en little-endian');
  assert.equal(pkt[10], 0);
  assert.equal(pkt[11], 14, 'version de protocole');
  assert.equal(pkt[12], 7, 'séquence');
  assert.equal(pkt[13], 0, 'port physique');
  assert.equal(pkt[14], 0x23, 'SubUni = (subNet << 4) | universe');
  assert.equal(pkt[15], 1, 'Net');
  assert.equal(pkt.readUInt16BE(16), 512, 'longueur en big-endian');
  assert.equal(pkt[18], 255);
  assert.equal(pkt[18 + 511], 42);
});

test('buildArtDmx complète à une longueur paire', () => {
  const pkt = buildArtDmx({ data: Buffer.from([10, 20, 30]) });
  assert.equal(pkt.readUInt16BE(16), 4);
  assert.equal(pkt.length, 22);
});

test('buildArtPoll produit un paquet de 14 octets', () => {
  const pkt = buildArtPoll();
  assert.equal(pkt.length, 14);
  assert.equal(pkt.readUInt16LE(8), 0x2000);
});

test('parseArtPollReply décode un ArtPollReply', () => {
  const buf = Buffer.alloc(239);
  Buffer.from('Art-Net\0', 'latin1').copy(buf, 0);
  buf.writeUInt16LE(0x2100, 8);
  buf[10] = 192; buf[11] = 168; buf[12] = 1; buf[13] = 50;
  buf.writeUInt16LE(0x1936, 14);
  buf.write('NODE-1\0', 26, 'latin1');
  buf.write('Node de test\0', 44, 'latin1');
  buf[18] = 0;        // Net
  buf[19] = 0x00;     // Sub-Net
  buf.writeUInt16BE(2, 172);
  buf[190] = 0; buf[191] = 1;

  const reply = parseArtPollReply(buf);
  assert.equal(reply.ip, '192.168.1.50');
  assert.equal(reply.shortName, 'NODE-1');
  assert.equal(reply.longName, 'Node de test');
  assert.deepEqual(reply.outputs, [0, 1]);
});

test('parseArtPollReply rejette les paquets étrangers', () => {
  assert.equal(parseArtPollReply(Buffer.alloc(300)), null);
});

// ---------------------------------------------------------------- rendu DMX

/** Moteur minimal, sans socket réelle (le sender est un espion). */
function makeEngine(fixtures, profiles) {
  const sent = [];
  const sender = { ready: true, sendUniverse: (p) => sent.push(p), stats: {} };
  const show = {
    universes: [{ id: 0, name: 'U1', net: 0, subNet: 0, universe: 0, mode: 'broadcast', target: '2.255.255.255', enabled: true }],
    fixtures, groups: [], presets: [],
    settings: { refreshRate: 30, broadcastAddress: '2.255.255.255' }
  };
  return { engine: new ShowEngine({ sender, show, library: profiles }), sent };
}

const MOVING_HEAD = {
  id: 'mh', name: 'Lyre test', channelCount: 8,
  channels: { pan: { channel: 1, fine: 2 }, tilt: { channel: 3, fine: 4 }, dimmer: { channel: 5, default: 0 }, red: { channel: 6 }, green: { channel: 7 }, blue: { channel: 8 } }
};
const PAR3 = {
  id: 'par3', name: 'PAR 3ch', channelCount: 3,
  channels: { red: { channel: 1, default: 1 }, green: { channel: 2, default: 1 }, blue: { channel: 3, default: 1 } }
};

test('le pan/tilt utilise les canaux fine (16 bits)', () => {
  const { engine } = makeEngine([{ id: 'f1', name: 'L1', profileId: 'mh', universeId: 0, address: 1 }], [MOVING_HEAD]);
  engine.setValues([{ id: 'f1', attr: 'pan', value: 0.75 }, { id: 'f1', attr: 'tilt', value: 0.5 }]);
  engine.render();
  const buf = engine.buffers.get(0);
  assert.equal(buf[0] * 256 + buf[1], Math.round(0.75 * 65535));
  assert.equal(buf[2] * 256 + buf[3], Math.round(0.5 * 65535));
});

test('le master et le blackout agissent sur le dimmer, pas sur la position', () => {
  const { engine } = makeEngine([{ id: 'f1', name: 'L1', profileId: 'mh', universeId: 0, address: 1 }], [MOVING_HEAD]);
  engine.setValues([{ id: 'f1', attr: 'dimmer', value: 1 }, { id: 'f1', attr: 'pan', value: 1 }]);

  engine.master = 0.5;
  engine.render();
  assert.equal(engine.buffers.get(0)[4], 128);

  engine.blackout = true;
  engine.render();
  assert.equal(engine.buffers.get(0)[4], 0, 'dimmer coupé');
  assert.equal(engine.buffers.get(0)[0], 255, 'la position est conservée');
});

test('dimmer virtuel : sans canal de dimmer, les couleurs sont modulées', () => {
  const { engine } = makeEngine([{ id: 'p1', name: 'PAR', profileId: 'par3', universeId: 0, address: 1 }], [PAR3]);
  engine.setValues([{ id: 'p1', attr: 'dimmer', value: 0.5 }]);
  engine.render();
  const buf = engine.buffers.get(0);
  assert.deepEqual([buf[0], buf[1], buf[2]], [128, 128, 128]);
});

test('l’adressage DMX respecte l’adresse de départ de chaque fixture', () => {
  const { engine } = makeEngine([
    { id: 'a', name: 'A', profileId: 'par3', universeId: 0, address: 1 },
    { id: 'b', name: 'B', profileId: 'par3', universeId: 0, address: 10 }
  ], [PAR3]);
  engine.setValues([
    { id: 'a', attr: 'dimmer', value: 1 }, { id: 'a', attr: 'red', value: 1 }, { id: 'a', attr: 'green', value: 0 }, { id: 'a', attr: 'blue', value: 0 },
    { id: 'b', attr: 'dimmer', value: 1 }, { id: 'b', attr: 'red', value: 0 }, { id: 'b', attr: 'green', value: 0 }, { id: 'b', attr: 'blue', value: 1 }
  ]);
  engine.render();
  const buf = engine.buffers.get(0);
  assert.deepEqual([buf[0], buf[1], buf[2]], [255, 0, 0]);
  assert.deepEqual([buf[9], buf[10], buf[11]], [0, 0, 255]);
});

test('le rappel de preset avec fade interpole dans le temps', () => {
  const { engine } = makeEngine([{ id: 'f1', name: 'L1', profileId: 'mh', universeId: 0, address: 1 }], [MOVING_HEAD]);
  engine.setValues([{ id: 'f1', attr: 'dimmer', value: 0 }]);
  engine.applyValues({ f1: { dimmer: 1 } }, 2);           // fondu de 2 s

  const start = Date.now();
  engine.tickFades(start + 1000);                          // à mi-parcours
  assert.ok(Math.abs(engine.getValue('f1', 'dimmer') - 0.5) < 0.05);

  engine.tickFades(start + 2000);
  assert.equal(engine.getValue('f1', 'dimmer'), 1);
  assert.equal(engine.fades.size, 0, 'le fade est terminé');
});

test('le keep-alive émet en continu, même sans changement', () => {
  const { engine, sent } = makeEngine([{ id: 'f1', name: 'L1', profileId: 'mh', universeId: 0, address: 1 }], [MOVING_HEAD]);
  engine.tick(); engine.tick(); engine.tick();
  assert.equal(sent.length, 3);
  assert.equal(sent[0].data.length, 512);
  assert.equal(sent[0].target, '2.255.255.255');
});

test('un univers désactivé n’émet pas', () => {
  const { engine, sent } = makeEngine([], []);
  engine.show.universes[0].enabled = false;
  engine.tick();
  assert.equal(sent.length, 0);
});
