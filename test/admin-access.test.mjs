/**
 * Test d'intégration du garde-fou Live / Régie sur les routes HTTP.
 *
 * Le serveur est lancé pour de vrai, avec un show temporaire protégé par un code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3197;
const PIN = '4242';

/** Show temporaire : on ne touche pas au show de l'utilisateur. */
function writeTempShow() {
  const dir = path.join(ROOT, 'data', 'show');
  const file = path.join(dir, 'show.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    universes: [{ id: 0, name: 'U1', net: 0, subNet: 0, universe: 0, mode: 'broadcast', target: '127.0.0.1', enabled: true }],
    fixtures: [], groups: [], presets: [], effects: [],
    settings: { refreshRate: 30, discovery: false, broadcastAddress: '127.0.0.1', adminPin: PIN }
  }, null, 2));
  return () => {
    if (backup !== null) fs.writeFileSync(file, backup);
    else fs.rmSync(file, { force: true });
  };
}

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

test('les routes de programmation exigent le code quand il est défini', async (t) => {
  const restore = writeTempShow();
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ARTNET_BIND: '127.0.0.1' },
    stdio: 'ignore'
  });

  t.after(() => { server.kill('SIGINT'); restore(); });

  const base = `http://127.0.0.1:${PORT}`;
  assert.ok(await waitForServer(`${base}/api/status`), 'le serveur doit démarrer');

  // La lecture reste ouverte : l'écran Live doit pouvoir s'afficher.
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.adminPinSet, true, 'l’existence du code est annoncée');
  assert.equal(status.adminPin, undefined, 'le code lui-même n’est jamais exposé');
  assert.equal((await fetch(`${base}/api/fixtures`)).status, 200, 'la bibliothèque reste lisible');

  const profile = {
    name: 'Profil interdit', channelCount: 2,
    channels: { dimmer: { channel: 1 }, red: { channel: 2 } }
  };
  const post = (headers) => fetch(`${base}/api/fixtures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(profile)
  });

  // Sans code : refusé.
  const denied = await post({});
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).errors[0], /Régie/);
  assert.equal(fs.existsSync(path.join(ROOT, 'data/fixtures/profil-interdit.json')), false,
    'aucun fichier ne doit être écrit');

  // Mauvais code : refusé aussi.
  assert.equal((await post({ 'X-Admin-Pin': '0000' })).status, 403);

  // Bon code : accepté.
  const allowed = await post({ 'X-Admin-Pin': PIN });
  assert.equal(allowed.status, 200);
  const created = path.join(ROOT, 'data/fixtures/profil-interdit.json');
  assert.ok(fs.existsSync(created), 'le profil est écrit une fois le code fourni');
  fs.rmSync(created, { force: true });

  // Import de show : même règle.
  const importShow = (headers) => fetch(`${base}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ universes: [], fixtures: [] })
  });
  assert.equal((await importShow({})).status, 403);
  assert.equal((await importShow({ 'X-Admin-Pin': PIN })).status, 200);
});
