/**
 * Serveur : sert l'interface web, expose l'API WebSocket temps réel et pilote
 * le moteur Art-Net.
 *
 * Démarrage :  npm start          (variables : PORT, ARTNET_BIND)
 * L'iPad se connecte ensuite sur http://<ip-de-la-machine>:3000
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';

import { ArtNetSender } from './artnet.js';
import { ShowEngine } from './engine.js';
import {
  loadShow, loadFixtureLibrary, saveShowDebounced, saveShowNow, defaultShow, ROOT,
  saveFixtureProfile, deleteFixtureProfile
} from './store.js';
import { validateProfile } from './fixtureProfile.js';
import { EFFECT_PRESETS, defaultEffectSettings } from '../shared/effects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------- démarrage

const show = loadShow();
const library = loadFixtureLibrary();
console.log(`[serveur] ${library.length} profils de fixtures chargés, ${show.fixtures.length} projecteurs patchés`);

const sender = new ArtNetSender({ bindAddress: process.env.ARTNET_BIND || '0.0.0.0' });
sender.on('error', (err) => console.error('[artnet]', err.message));

const engine = new ShowEngine({
  sender,
  show,
  library,
  onShowChanged: () => saveShowDebounced(show)
});

/**
 * Recharge la bibliothèque de profils DEPUIS LE DISQUE, en place.
 * Le tableau `library` est partagé avec le moteur : on le modifie sans le
 * remplacer, pour que `engine.getProfile()` voie immédiatement les nouveautés.
 */
function reloadLibrary() {
  library.splice(0, library.length, ...loadFixtureLibrary());
  io.emit('library', library);
}

/**
 * Enregistre un profil (création ou modification) et met tout le monde à jour.
 * @returns {{ ok: boolean, errors?: string[], profile?: Object }}
 */
function saveProfile(input) {
  const { profile, errors } = validateProfile(input);
  if (!profile) return { ok: false, errors };
  try {
    saveFixtureProfile(profile);
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
  reloadLibrary();
  engine.refreshProfile(profile.id);   // les projecteurs déjà patchés suivent
  io.emit('values:full', engine.snapshot());
  return { ok: true, profile };
}

/** Projecteurs patchés utilisant un profil (un profil utilisé ne se supprime pas). */
function fixturesUsing(profileId) {
  return show.fixtures.filter((f) => f.profileId === profileId);
}

/** Sauvegarde + diffusion du show à tous les clients après une modification de structure. */
function showChanged() {
  engine.syncFixtures();
  saveShowDebounced(show);
  io.emit('show', show);
}

// ------------------------------------------------------------- serveur HTTP

const app = express();
app.use(express.json({ limit: '5mb' }));

// Interface web (aucune étape de build : ce sont des modules ES servis tels quels).
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));

/**
 * Même garde-fou que sur le WebSocket, pour les routes qui modifient le show.
 * Le client envoie le code dans l'en-tête X-Admin-Pin une fois le mode Régie
 * déverrouillé. Sans code configuré, la route reste ouverte.
 */
function requireAdmin(req, res, next) {
  const expected = adminPin();
  if (!expected || String(req.get('X-Admin-Pin') || '') === expected) return next();
  res.status(403).json({ errors: ['Mode Régie requis : entrez le code d’accès.'] });
}

/** Bibliothèque de profils. */
app.get('/api/fixtures', (_req, res) => res.json(library));

/** Un profil seul, en téléchargement (partage entre installations). */
app.get('/api/fixtures/:id', (req, res) => {
  const profile = library.find((p) => p.id === req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profil inconnu' });
  res.setHeader('Content-Disposition', `attachment; filename="${profile.id}.json"`);
  res.json(profile);
});

/** Création ou modification d'un profil de fixture (prise en compte immédiate). */
app.post('/api/fixtures', requireAdmin, (req, res) => {
  const result = saveProfile(req.body);
  if (!result.ok) return res.status(400).json({ errors: result.errors });
  res.json({ ok: true, profile: result.profile });
});

/** Suppression d'un profil, refusée tant qu'un projecteur l'utilise. */
app.delete('/api/fixtures/:id', requireAdmin, (req, res) => {
  const inUse = fixturesUsing(req.params.id);
  if (inUse.length) {
    return res.status(409).json({
      errors: [`Profil utilisé par ${inUse.length} projecteur(s) : ${inUse.map((f) => f.name).join(', ')}`]
    });
  }
  try {
    if (!deleteFixtureProfile(req.params.id)) return res.status(404).json({ errors: ['Profil inconnu'] });
  } catch (err) {
    return res.status(400).json({ errors: [err.message] });
  }
  reloadLibrary();
  res.json({ ok: true });
});

/** Export du show complet (patch + groupes + presets + réseau) : sauvegarde iPad. */
app.get('/api/show', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="show.json"');
  res.json(show);
});

/** Import d'un show exporté précédemment. */
app.post('/api/show', requireAdmin, (req, res) => {
  const incoming = req.body;
  if (!incoming || !Array.isArray(incoming.fixtures) || !Array.isArray(incoming.universes)) {
    return res.status(400).json({ error: 'Fichier de show invalide' });
  }
  applyShow(incoming);
  res.json({ ok: true });
});

/** État du serveur (utilisé par l'indicateur de connexion et le monitoring). */
app.get('/api/status', (_req, res) => res.json(buildStatus()));

const server = http.createServer(app);
const io = new SocketServer(server, { cors: { origin: '*' } });

/** Remplace intégralement le show courant (import ou remise à zéro). */
function applyShow(incoming) {
  const base = defaultShow();
  show.universes = incoming.universes || base.universes;
  show.fixtures = incoming.fixtures || [];
  show.groups = incoming.groups || [];
  show.presets = incoming.presets || [];
  show.effects = incoming.effects || [];
  show.settings = { ...base.settings, ...(incoming.settings || {}) };
  engine.values.clear();
  engine.fades.clear();
  engine.syncFixtures();
  engine.start(); // la fréquence de rafraîchissement a pu changer
  saveShowNow(show);
  io.emit('show', show);
  io.emit('values:full', engine.snapshot());
}

/**
 * Deux modes d'usage :
 *   - « Live » : rappeler des looks, master, blackout, mettre un effet en pause.
 *   - « Régie » : tout le reste (patch, profils, presets, effets, réseau).
 *
 * Quand un code est défini dans les réglages, seules les connexions
 * authentifiées peuvent programmer. C'est un garde-fou contre les fausses
 * manœuvres en exploitation — pas un mécanisme de sécurité : le réseau
 * technique est supposé de confiance (pas de HTTPS, pas de comptes).
 */
function adminPin() {
  return String(show.settings.adminPin || '');
}

/** Sans code défini, tout le monde a les droits de programmation. */
function isAdminSocket(socket) {
  return !adminPin() || socket.data.isAdmin === true;
}

/**
 * Enveloppe un gestionnaire d'événement réservé au mode Régie.
 * L'accusé de réception éventuel explique le refus au client.
 */
function adminOnly(socket, handler) {
  return (...args) => {
    if (isAdminSocket(socket)) return handler(...args);
    const ack = args[args.length - 1];
    if (typeof ack === 'function') ack({ ok: false, errors: ['Mode Régie requis : entrez le code d’accès.'] });
    socket.emit('denied', 'Action réservée au mode Régie.');
  };
}

function buildStatus() {
  return {
    artnet: {
      ready: sender.ready,
      discovery: sender.discoveryEnabled !== false,
      packetsSent: sender.stats.packetsSent,
      lastSendAt: sender.stats.lastSendAt,
      lastError: sender.stats.lastError,
      refreshRate: show.settings.refreshRate
    },
    nodes: sender.listNodes(),
    clients: io.engine.clientsCount,
    master: engine.master,
    blackout: engine.blackout,
    // Le code lui-même n'est jamais envoyé aux clients : seulement son existence.
    adminPinSet: adminPin().length > 0
  };
}

// --------------------------------------------------------------- API socket

io.on('connection', (socket) => {
  console.log(`[socket] client connecté (${socket.id})`);
  // Sans code défini, la connexion a d'emblée les droits de programmation.
  socket.data.isAdmin = !adminPin();

  /** Passage en mode Régie : vérification du code. */
  socket.on('auth:admin', (pin, ack) => {
    const expected = adminPin();
    const ok = !expected || String(pin ?? '') === expected;
    if (ok) socket.data.isAdmin = true;
    if (typeof ack === 'function') ack({ ok, isAdmin: socket.data.isAdmin });
  });

  /** Déclare un événement réservé au mode Régie. */
  const onAdmin = (event, handler) => socket.on(event, adminOnly(socket, handler));

  /** Retour en mode Live : on relâche les droits si un code protège la régie. */
  socket.on('auth:logout', (ack) => {
    socket.data.isAdmin = !adminPin();
    if (typeof ack === 'function') ack({ ok: true, isAdmin: socket.data.isAdmin });
  });

  // État complet à la connexion : l'UI se reconstruit entièrement à partir de là.
  socket.emit('init', {
    show,
    library,
    values: engine.snapshot(),
    master: engine.master,
    blackout: engine.blackout,
    status: buildStatus(),
    isAdmin: socket.data.isAdmin
  });

  // ---- Contrôle temps réel -------------------------------------------------

  // Le client envoie des lots de valeurs (throttlés à ~40 Hz de son côté).
  onAdmin('values:set', (entries) => {
    if (!Array.isArray(entries)) return;
    const changed = engine.setValues(entries);
    if (changed.length) socket.broadcast.emit('values', changed);
  });

  socket.on('master:set', (value) => {
    engine.master = Math.max(0, Math.min(1, Number(value) || 0));
    socket.broadcast.emit('master', engine.master);
  });

  socket.on('blackout:set', (value) => {
    engine.blackout = Boolean(value);
    io.emit('blackout', engine.blackout);
  });

  // ---- Patch ---------------------------------------------------------------

  /**
   * Ajout de fixtures. `count` permet de patcher d'un coup une série identique
   * (ex : 8 lyres à la suite), chaque fixture étant décalée du nombre de canaux
   * du profil (ou d'un pas personnalisé).
   */
  onAdmin('patch:add', (req = {}) => {
    const profile = engine.getProfile(req.profileId);
    if (!profile) return;
    const count = Math.max(1, Math.min(64, Number(req.count) || 1));
    const step = Number(req.step) > 0 ? Number(req.step) : profile.channelCount;
    let address = Math.max(1, Math.min(512, Number(req.address) || 1));
    const universeId = Number(req.universeId) || 0;
    const baseName = (req.name || profile.shortName || profile.name).trim();

    for (let i = 0; i < count; i++) {
      if (address + profile.channelCount - 1 > 512) break; // on ne déborde pas de l'univers
      show.fixtures.push({
        id: `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: count > 1 ? `${baseName} ${i + 1}` : baseName,
        profileId: profile.id,
        universeId,
        address
      });
      address += step;
    }
    showChanged();
  });

  onAdmin('patch:update', ({ id, changes } = {}) => {
    const fx = show.fixtures.find((f) => f.id === id);
    if (!fx || !changes) return;
    if (typeof changes.name === 'string') fx.name = changes.name;
    if (Number.isFinite(changes.address)) fx.address = Math.max(1, Math.min(512, changes.address));
    if (Number.isFinite(changes.universeId)) fx.universeId = changes.universeId;
    if (typeof changes.profileId === 'string' && engine.getProfile(changes.profileId)) {
      fx.profileId = changes.profileId;
      engine.values.delete(fx.id); // le profil change : on repart des valeurs par défaut
    }
    showChanged();
  });

  onAdmin('patch:remove', (ids) => {
    const list = Array.isArray(ids) ? ids : [ids];
    show.fixtures = show.fixtures.filter((f) => !list.includes(f.id));
    // On nettoie aussi groupes, presets et effets qui référençaient ces fixtures.
    for (const g of show.groups) g.fixtureIds = g.fixtureIds.filter((id) => !list.includes(id));
    for (const p of show.presets) for (const id of list) delete p.values[id];
    for (const e of show.effects) e.fixtureIds = e.fixtureIds.filter((id) => !list.includes(id));
    show.effects = show.effects.filter((e) => e.fixtureIds.length);
    showChanged();
  });

  // ---- Bibliothèque de fixtures --------------------------------------------

  // Création / modification d'un profil depuis l'interface : pas de fichier à
  // déposer à la main, pas de redémarrage du serveur.
  onAdmin('fixture:save', (profile, ack) => {
    const result = saveProfile(profile);
    if (typeof ack === 'function') ack(result);
  });

  onAdmin('fixture:remove', (id, ack) => {
    const inUse = fixturesUsing(id);
    if (inUse.length) {
      return ack?.({ ok: false, errors: [`Profil utilisé par ${inUse.length} projecteur(s) : ${inUse.map((f) => f.name).join(', ')}`] });
    }
    try {
      if (!deleteFixtureProfile(id)) return ack?.({ ok: false, errors: ['Profil inconnu'] });
    } catch (err) {
      return ack?.({ ok: false, errors: [err.message] });
    }
    reloadLibrary();
    ack?.({ ok: true });
  });

  // ---- Groupes -------------------------------------------------------------

  onAdmin('group:save', (group = {}) => {
    if (!group.name || !Array.isArray(group.fixtureIds)) return;
    const existing = show.groups.find((g) => g.id === group.id);
    if (existing) {
      Object.assign(existing, { name: group.name, fixtureIds: group.fixtureIds, mirror: !!group.mirror });
    } else {
      show.groups.push({
        id: `grp-${Date.now().toString(36)}`,
        name: group.name,
        fixtureIds: group.fixtureIds,
        mirror: !!group.mirror
      });
    }
    showChanged();
  });

  onAdmin('group:remove', (id) => {
    show.groups = show.groups.filter((g) => g.id !== id);
    showChanged();
  });

  // ---- Effets (mouvement, dimmer, couleur) ---------------------------------

  // Un effet s'applique à une sélection de projecteurs et tourne en continu.
  // Il ne modifie pas les valeurs enregistrées : l'arrêter restitue la base.
  onAdmin('effect:add', (req = {}) => {
    const preset = EFFECT_PRESETS[req.preset];
    if (!preset || !Array.isArray(req.fixtureIds) || !req.fixtureIds.length) return;
    const fixtureIds = req.fixtureIds.filter((id) => show.fixtures.some((f) => f.id === id));
    if (!fixtureIds.length) return;

    show.effects.push({
      id: `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: req.name || preset.label,
      preset: req.preset,
      fixtureIds,
      ...defaultEffectSettings(req.preset)
    });
    showChanged();
  });

  socket.on('effect:update', ({ id, changes } = {}) => {
    const effect = show.effects.find((e) => e.id === id);
    if (!effect || !changes) return;
    // En mode Live, on peut mettre un effet en pause ou le relancer, rien d'autre.
    if (!isAdminSocket(socket)) {
      const keys = Object.keys(changes);
      if (keys.length !== 1 || keys[0] !== 'enabled') {
        socket.emit('denied', 'Modifier les réglages d’un effet demande le mode Régie.');
        return;
      }
    }
    if (typeof changes.name === 'string') effect.name = changes.name.slice(0, 40);
    if (Number.isFinite(changes.bpm)) effect.bpm = Math.max(1, Math.min(600, changes.bpm));
    if (Number.isFinite(changes.size)) effect.size = Math.max(0, Math.min(1, changes.size));
    if (Number.isFinite(changes.spread)) effect.spread = Math.max(0, Math.min(4, changes.spread));
    if (Number.isFinite(changes.direction)) effect.direction = changes.direction < 0 ? -1 : 1;
    if (typeof changes.wave === 'string') effect.wave = changes.wave;
    if (typeof changes.enabled === 'boolean') effect.enabled = changes.enabled;
    if (Array.isArray(changes.fixtureIds)) {
      effect.fixtureIds = changes.fixtureIds.filter((fid) => show.fixtures.some((f) => f.id === fid));
    }
    showChanged();
  });

  onAdmin('effect:remove', (id) => {
    show.effects = show.effects.filter((e) => e.id !== id);
    showChanged();
  });

  onAdmin('effect:clear', () => {
    show.effects = [];
    showChanged();
  });

  // ---- Presets ("looks") ---------------------------------------------------

  onAdmin('preset:record', (req = {}) => {
    const fixtureIds = Array.isArray(req.fixtureIds) && req.fixtureIds.length ? req.fixtureIds : null;
    const preset = {
      id: `pre-${Date.now().toString(36)}`,
      name: req.name || `Look ${show.presets.length + 1}`,
      color: req.color || '#3b82f6',
      fadeTime: Number.isFinite(req.fadeTime) ? req.fadeTime : 1,
      values: engine.snapshot(fixtureIds),
      // Un look mémorise aussi les effets en cours : le rappeler restitue le
      // mouvement, pas seulement les positions figées.
      effects: JSON.parse(JSON.stringify(
        fixtureIds
          ? show.effects.filter((e) => e.fixtureIds.some((id) => fixtureIds.includes(id)))
          : show.effects
      ))
    };
    // Enregistrer sur le même nom écrase le preset existant (usage rapide en live).
    const idx = show.presets.findIndex((p) => p.name === preset.name);
    if (idx >= 0) { preset.id = show.presets[idx].id; show.presets[idx] = preset; }
    else show.presets.push(preset);
    showChanged();
  });

  socket.on('preset:recall', ({ id, fadeTime } = {}) => {
    const preset = show.presets.find((p) => p.id === id);
    if (!preset) return;
    const fade = Number.isFinite(fadeTime) ? fadeTime : (preset.fadeTime ?? 0);
    engine.applyValues(preset.values, fade);
    // Les effets sont repris tels quels (sans fondu) : un look sans effet
    // enregistré arrête donc les effets en cours, ce qui est le comportement attendu.
    show.effects = JSON.parse(JSON.stringify(preset.effects || []));
    saveShowDebounced(show);
    io.emit('show', show);
    io.emit('preset:recalled', { id: preset.id, fadeTime: fade });
    if (fade <= 0) io.emit('values:full', engine.snapshot());
  });

  onAdmin('preset:update', ({ id, changes } = {}) => {
    const preset = show.presets.find((p) => p.id === id);
    if (!preset || !changes) return;
    if (typeof changes.name === 'string') preset.name = changes.name;
    if (typeof changes.color === 'string') preset.color = changes.color;
    if (Number.isFinite(changes.fadeTime)) preset.fadeTime = changes.fadeTime;
    showChanged();
  });

  onAdmin('preset:remove', (id) => {
    show.presets = show.presets.filter((p) => p.id !== id);
    showChanged();
  });

  // ---- Réseau / réglages ---------------------------------------------------

  onAdmin('universes:save', (universes) => {
    if (!Array.isArray(universes)) return;
    show.universes = universes.map((u, i) => ({
      id: Number.isFinite(u.id) ? u.id : i,
      name: u.name || `Univers ${i + 1}`,
      net: clampInt(u.net, 0, 127),
      subNet: clampInt(u.subNet, 0, 15),
      universe: clampInt(u.universe, 0, 15),
      mode: u.mode === 'unicast' ? 'unicast' : 'broadcast',
      target: u.target || '255.255.255.255',
      enabled: u.enabled !== false
    }));
    showChanged();
  });

  onAdmin('settings:save', (settings = {}) => {
    if (Number.isFinite(settings.refreshRate)) {
      show.settings.refreshRate = clampInt(settings.refreshRate, 1, 60);
    }
    if (typeof settings.broadcastAddress === 'string') {
      show.settings.broadcastAddress = settings.broadcastAddress;
    }
    if (typeof settings.discovery === 'boolean') show.settings.discovery = settings.discovery;
    if (typeof settings.adminPin === 'string') {
      // Seul un client déjà en régie arrive ici (settings:save est protégé) :
      // définir ou retirer le code ne verrouille donc jamais son auteur dehors.
      show.settings.adminPin = settings.adminPin.slice(0, 12);
      socket.data.isAdmin = true;
      io.emit('status', buildStatus());
    }
    engine.start(); // applique la nouvelle fréquence
    showChanged();
  });

  socket.on('artnet:poll', () => sender.poll(show.settings.broadcastAddress));

  onAdmin('show:reset', () => applyShow(defaultShow()));

  // ---- Monitoring DMX ------------------------------------------------------

  socket.on('monitor:subscribe', (on) => {
    if (on) socket.join('monitor');
    else socket.leave('monitor');
  });

  socket.on('disconnect', () => console.log(`[socket] client déconnecté (${socket.id})`));
});

function clampInt(value, min, max) {
  const n = Math.round(Number(value) || 0);
  return Math.max(min, Math.min(max, n));
}

// Retour des fades vers les clients (les curseurs suivent le fondu).
engine.on('fadeProgress', (entries) => { if (entries.length) io.emit('values', entries); });

// Diffusion de l'état (indicateur de connexion, nodes détectés) toutes les secondes.
setInterval(() => io.emit('status', buildStatus()), 1000);

// Trames DMX pour l'onglet Debug, uniquement si quelqu'un les regarde (10 Hz).
setInterval(() => {
  const room = io.sockets.adapter.rooms.get('monitor');
  if (room && room.size > 0) io.to('monitor').emit('monitor', engine.monitorSnapshot());
}, 100);

// ArtPoll périodique pour maintenir la liste des nodes à jour.
setInterval(() => {
  if (show.settings.discovery) sender.poll(show.settings.broadcastAddress);
}, 5000);

// -------------------------------------------------------------- lancement

const started = await sender.start();
if (!started.discovery) {
  console.warn(`[artnet] port 6454 occupé : émission OK sur le port ${started.port}, découverte des nodes indisponible`);
}
engine.start();
sender.poll(show.settings.broadcastAddress);

server.listen(PORT, () => {
  console.log('\n  Contrôleur Art-Net démarré');
  for (const url of localUrls(PORT)) console.log(`    ${url}`);
  console.log('');
});

/** Adresses IPv4 locales, affichées au démarrage pour se connecter depuis l'iPad. */
function localUrls(port) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}`);
    }
  }
  return urls;
}

// Arrêt propre : on sauvegarde et on ferme la socket UDP.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[serveur] arrêt…');
    engine.stop();
    sender.stop();
    try { saveShowNow(show); } catch { /* rien à faire de plus */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
