/**
 * Persistance : tout est stocké dans de simples fichiers JSON (pas de base de données).
 *
 *   data/fixtures/*.json  : bibliothèque de profils (versionnée, en lecture seule)
 *   data/show/show.json   : patch + groupes + presets + réglages réseau (données utilisateur)
 *
 * Les écritures sont "atomiques" (fichier temporaire puis rename) et regroupées
 * (debounce) pour éviter d'écrire sur la carte SD à chaque mouvement de fader.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const FIXTURES_DIR = path.join(DATA_DIR, 'fixtures');
export const SHOW_DIR = path.join(DATA_DIR, 'show');
export const SHOW_FILE = path.join(SHOW_DIR, 'show.json');

/** Show vide utilisé au tout premier démarrage. */
export function defaultShow() {
  return {
    version: 1,
    // Univers de sortie. Chaque entrée = une adresse de port Art-Net + une destination.
    universes: [
      {
        id: 0,
        name: 'Univers 1',
        net: 0,
        subNet: 0,
        universe: 0,
        mode: 'broadcast',            // 'broadcast' ou 'unicast'
        target: '255.255.255.255',    // IP du node en unicast
        enabled: true
      }
    ],
    fixtures: [],   // { id, name, profileId, universeId, address }
    groups: [],     // { id, name, fixtureIds: [], mirror: false }
    presets: [],    // { id, name, color, values: { fixtureId: { attr: value } } }
    settings: {
      refreshRate: 30,              // Hz d'émission Art-Net (keep-alive inclus)
      discovery: true,              // ArtPoll périodique
      broadcastAddress: '255.255.255.255'
    }
  };
}

function ensureDirs() {
  for (const dir of [DATA_DIR, FIXTURES_DIR, SHOW_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** Charge le show depuis le disque (ou crée un show vide). */
export function loadShow() {
  ensureDirs();
  if (!fs.existsSync(SHOW_FILE)) {
    const show = defaultShow();
    writeJsonAtomic(SHOW_FILE, show);
    return show;
  }
  try {
    const raw = fs.readFileSync(SHOW_FILE, 'utf8');
    // On fusionne avec les valeurs par défaut : un fichier plus ancien reste lisible.
    return { ...defaultShow(), ...JSON.parse(raw) };
  } catch (err) {
    console.error('[store] show.json illisible, sauvegarde et repli sur un show vide :', err.message);
    try { fs.renameSync(SHOW_FILE, `${SHOW_FILE}.corrupt-${Date.now()}`); } catch { /* ignoré */ }
    return defaultShow();
  }
}

/** Écriture atomique : on écrit à côté puis on renomme, pour ne jamais tronquer le fichier. */
export function writeJsonAtomic(file, data) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let saveTimer = null;
/** Sauvegarde différée (1 s) : les modifications rapprochées ne font qu'une écriture. */
export function saveShowDebounced(show, delay = 1000) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeJsonAtomic(SHOW_FILE, show);
    } catch (err) {
      console.error('[store] échec de sauvegarde :', err.message);
    }
  }, delay);
}

/** Force l'écriture immédiate (arrêt du serveur, import de show...). */
export function saveShowNow(show) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeJsonAtomic(SHOW_FILE, show);
}

/** Charge tous les profils de fixtures présents dans data/fixtures. */
export function loadFixtureLibrary() {
  ensureDirs();
  const profiles = [];
  for (const file of fs.readdirSync(FIXTURES_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
      if (!profile.id) profile.id = path.basename(file, '.json');
      profiles.push(profile);
    } catch (err) {
      console.error(`[store] profil ignoré (${file}) :`, err.message);
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}
