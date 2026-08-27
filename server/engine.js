/**
 * Moteur du show : garde l'état de tous les projecteurs, calcule les buffers DMX
 * et les envoie en Art-Net en boucle continue (keep-alive).
 *
 * Principe :
 *   - l'état "vivant" est côté serveur (les valeurs 0..1 par fixture / attribut) ;
 *   - les clients web n'envoient que des ordres, ce qui garde plusieurs iPad
 *     synchronisés et permet d'enregistrer des presets côté serveur ;
 *   - une boucle unique (setInterval) rend et envoie tous les univers à la
 *     fréquence configurée, MÊME sans interaction utilisateur : c'est le
 *     keep-alive exigé par le protocole (certains nodes coupent sans signal).
 */

import { EventEmitter } from 'node:events';
import { attrMeta, hasVirtualDimmer } from '../shared/attributes.js';
import { evaluateEffect } from '../shared/effects.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class ShowEngine extends EventEmitter {
  /**
   * @param {Object} deps
   * @param {import('./artnet.js').ArtNetSender} deps.sender
   * @param {Object} deps.show     Show chargé depuis le disque (modifié en place)
   * @param {Array}  deps.library  Profils de fixtures
   * @param {Function} deps.onShowChanged  Appelé quand le show doit être sauvegardé
   */
  constructor({ sender, show, library, onShowChanged }) {
    super();
    this.sender = sender;
    this.show = show;
    this.library = library;
    this.onShowChanged = onShowChanged || (() => {});

    /** Valeurs courantes : Map<fixtureId, Map<attr, valeur 0..1>> */
    this.values = new Map();
    /** Fades en cours : Map<`${fixtureId}|${attr}`, {fixtureId, attr, from, to, start, duration}> */
    this.fades = new Map();
    /** Buffers DMX par univers : Map<universeId, Buffer(512)> */
    this.buffers = new Map();

    this.master = 1;        // Master dimmer 0..1
    this.blackout = false;  // Blackout général

    this.timer = null;
    this.frame = 0;
    // Horloge des effets : temps écoulé depuis le démarrage, en secondes.
    this.startedAt = Date.now();

    this.syncFixtures();
  }

  // ---------------------------------------------------------------- profils

  getProfile(profileId) {
    return this.library.find((p) => p.id === profileId) || null;
  }

  /** Crée / supprime les entrées de valeurs pour coller au patch courant. */
  syncFixtures() {
    const ids = new Set();
    for (const fx of this.show.fixtures) {
      ids.add(fx.id);
      if (!this.values.has(fx.id)) this.values.set(fx.id, this.defaultValues(fx));
    }
    for (const id of [...this.values.keys()]) {
      if (!ids.has(id)) this.values.delete(id);
    }
    // Un buffer par univers déclaré.
    const uids = new Set(this.show.universes.map((u) => u.id));
    for (const u of this.show.universes) {
      if (!this.buffers.has(u.id)) this.buffers.set(u.id, Buffer.alloc(512));
    }
    for (const id of [...this.buffers.keys()]) {
      if (!uids.has(id)) this.buffers.delete(id);
    }
  }

  /**
   * Après modification d'un profil : les projecteurs qui l'utilisent gardent les
   * valeurs des fonctions conservées, reçoivent le défaut des nouvelles, et
   * perdent celles qui ont disparu du profil.
   */
  refreshProfile(profileId) {
    for (const fx of this.show.fixtures) {
      if (fx.profileId !== profileId) continue;
      const defaults = this.defaultValues(fx);
      const current = this.values.get(fx.id) || new Map();
      const merged = new Map();
      for (const [attr, def] of defaults) merged.set(attr, current.has(attr) ? current.get(attr) : def);
      this.values.set(fx.id, merged);
      // Les fades portant sur une fonction disparue n'ont plus lieu d'être.
      for (const [key, fade] of this.fades) {
        if (fade.fixtureId === fx.id && !merged.has(fade.attr)) this.fades.delete(key);
      }
    }
  }

  /** Valeurs de départ d'une fixture, d'après les défauts de chaque attribut. */
  defaultValues(fx) {
    const profile = this.getProfile(fx.profileId);
    const map = new Map();
    if (!profile) return map;
    for (const attr of Object.keys(profile.channels)) {
      const def = profile.channels[attr].default;
      map.set(attr, typeof def === 'number' ? clamp01(def) : attrMeta(attr).default);
    }
    // Dimmer virtuel : l'attribut existe même sans canal dédié (éteint au démarrage).
    if (hasVirtualDimmer(profile)) map.set('dimmer', 0);
    return map;
  }

  // ----------------------------------------------------------------- valeurs

  getValue(fixtureId, attr) {
    const v = this.values.get(fixtureId);
    return v ? v.get(attr) : undefined;
  }

  /**
   * Applique une valeur immédiatement (mouvement de fader, pad XY...).
   * Annule un éventuel fade en cours sur cet attribut.
   */
  setValue(fixtureId, attr, value) {
    const map = this.values.get(fixtureId);
    if (!map) return false;
    map.set(attr, clamp01(value));
    this.fades.delete(`${fixtureId}|${attr}`);
    return true;
  }

  /**
   * Applique un lot de valeurs.
   * @param {Array<{id: string, attr: string, value: number}>} entries
   */
  setValues(entries) {
    const changed = [];
    for (const e of entries) {
      if (this.setValue(e.id, e.attr, e.value)) changed.push(e);
    }
    if (changed.length) this.emit('values', changed);
    return changed;
  }

  /** Snapshot des valeurs (pour l'état initial d'un client ou un preset). */
  snapshot(fixtureIds = null) {
    const out = {};
    for (const [id, map] of this.values) {
      if (fixtureIds && !fixtureIds.includes(id)) continue;
      out[id] = Object.fromEntries(map);
    }
    return out;
  }

  /**
   * Rappel d'un preset avec temps de fade (secondes).
   * Un fade de 0 s applique les valeurs instantanément.
   */
  applyValues(valuesByFixture, fadeSeconds = 0) {
    const now = Date.now();
    const duration = Math.max(0, fadeSeconds) * 1000;
    const changed = [];
    for (const [fixtureId, attrs] of Object.entries(valuesByFixture)) {
      const map = this.values.get(fixtureId);
      if (!map) continue; // fixture supprimée depuis l'enregistrement du preset
      for (const [attr, target] of Object.entries(attrs)) {
        const to = clamp01(target);
        if (duration <= 0) {
          map.set(attr, to);
          this.fades.delete(`${fixtureId}|${attr}`);
          changed.push({ id: fixtureId, attr, value: to });
        } else {
          this.fades.set(`${fixtureId}|${attr}`, {
            fixtureId, attr, from: map.get(attr) ?? 0, to, start: now, duration
          });
        }
      }
    }
    if (changed.length) this.emit('values', changed);
    return changed;
  }

  /** Fait avancer les fades ; renvoie les valeurs modifiées pour information des clients. */
  tickFades(now) {
    if (this.fades.size === 0) return [];
    const changed = [];
    for (const [key, fade] of this.fades) {
      const t = fade.duration <= 0 ? 1 : Math.min(1, (now - fade.start) / fade.duration);
      const value = fade.from + (fade.to - fade.from) * t;
      const map = this.values.get(fade.fixtureId);
      if (!map) { this.fades.delete(key); continue; }
      map.set(fade.attr, value);
      if (t >= 1) {
        this.fades.delete(key);
        changed.push({ id: fade.fixtureId, attr: fade.attr, value });
      }
    }
    return changed;
  }

  // ------------------------------------------------------------------ rendu

  /**
   * Écrit une valeur normalisée dans le buffer DMX, en 8 ou 16 bits.
   * @param {Buffer} buf
   * @param {number} address      Adresse DMX de départ de la fixture (1..512)
   * @param {Object} chan         { channel, fine? } — offsets 1-based dans la fixture
   * @param {number} value        0..1
   */
  writeChannel(buf, address, chan, value) {
    const v = clamp01(value);
    // Index 0-based dans l'univers : adresse de la fixture + offset du canal.
    const coarseIdx = address - 1 + (chan.channel - 1);
    if (coarseIdx < 0 || coarseIdx > 511) return;

    if (chan.fine) {
      // 16 bits : 0..65535 réparti sur canal grossier + canal fin.
      const raw = Math.round(v * 65535);
      buf[coarseIdx] = (raw >> 8) & 0xff;
      const fineIdx = address - 1 + (chan.fine - 1);
      if (fineIdx >= 0 && fineIdx <= 511) buf[fineIdx] = raw & 0xff;
    } else {
      buf[coarseIdx] = Math.round(v * 255);
    }
  }

  /** Temps écoulé depuis le démarrage du moteur, en secondes (horloge des effets). */
  elapsed() {
    return (Date.now() - this.startedAt) / 1000;
  }

  /**
   * Contribution des effets en cours, par fixture.
   *
   * Les effets ne touchent pas aux valeurs enregistrées : ils produisent des
   * modificateurs appliqués au rendu. Les arrêter restitue donc exactement la
   * position, la couleur et l'intensité réglées à la main.
   *
   * Cumul quand plusieurs effets visent le même attribut : les décalages
   * s'additionnent, les modulations se multiplient, un remplacement écrase.
   *
   * @returns {Map<string, { add: Object, mul: Object, set: Object }>}
   */
  computeEffects(seconds) {
    const out = new Map();
    for (const effect of this.show.effects || []) {
      if (effect.enabled === false) continue;
      // Une fixture supprimée du patch ne doit plus compter dans les décalages.
      const targets = (effect.fixtureIds || []).filter((id) => this.values.has(id));
      if (!targets.length) continue;

      targets.forEach((id, index) => {
        const result = evaluateEffect(effect, index, targets.length, seconds);
        if (!result) return;
        let entry = out.get(id);
        if (!entry) { entry = { add: {}, mul: {}, set: {} }; out.set(id, entry); }
        for (const [attr, value] of Object.entries(result.values)) {
          if (result.mode === 'add') entry.add[attr] = (entry.add[attr] || 0) + value;
          else if (result.mode === 'multiply') entry.mul[attr] = (entry.mul[attr] ?? 1) * value;
          else entry.set[attr] = value;
        }
      });
    }
    return out;
  }

  /** Applique les modificateurs d'effet à une valeur de base. */
  applyModifiers(mods, attr, value) {
    if (!mods) return value;
    if (mods.set[attr] !== undefined) value = mods.set[attr];
    if (mods.add[attr] !== undefined) value += mods.add[attr];
    if (mods.mul[attr] !== undefined) value *= mods.mul[attr];
    return clamp01(value);
  }

  /** Recalcule tous les buffers DMX à partir de l'état courant. */
  render() {
    for (const buf of this.buffers.values()) buf.fill(0);

    const masterLevel = this.blackout ? 0 : clamp01(this.master);
    const effects = this.computeEffects(this.elapsed());

    for (const fx of this.show.fixtures) {
      const profile = this.getProfile(fx.profileId);
      const buf = this.buffers.get(fx.universeId);
      if (!profile || !buf) continue;
      const vals = this.values.get(fx.id);
      if (!vals) continue;

      const mods = effects.get(fx.id);

      // Intensité effective : dimmer réglé × effets × master × blackout.
      const dimmerBase = vals.get('dimmer') ?? (profile.channels.dimmer ? 0 : 1);
      const dimmer = clamp01(this.applyModifiers(mods, 'dimmer', dimmerBase) * masterLevel);
      // Sans canal de dimmer physique, on module les couleurs (dimmer virtuel).
      const virtualDimmer = hasVirtualDimmer(profile);

      for (const [attr, chan] of Object.entries(profile.channels)) {
        let value = vals.get(attr);
        if (value === undefined) value = chan.default ?? attrMeta(attr).default;

        if (attr === 'dimmer') {
          value = dimmer;                              // effets déjà pris en compte
        } else {
          value = this.applyModifiers(mods, attr, value);
          if (virtualDimmer && isColorAttr(attr)) value = value * dimmer;
        }
        this.writeChannel(buf, fx.address, chan, value);
      }
    }
  }

  // ------------------------------------------------------------ boucle Art-Net

  /** Démarre la boucle d'émission (rendu + envoi de tous les univers). */
  start() {
    this.stop();
    const rate = Math.min(60, Math.max(1, this.show.settings.refreshRate || 30));
    this.timer = setInterval(() => this.tick(), Math.round(1000 / rate));
    console.log(`[engine] émission Art-Net à ${rate} Hz`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Redémarre la boucle après un changement de fréquence. */
  restart() {
    if (this.timer) this.start();
  }

  /** Une trame : avance les fades, rend, envoie. Appelée en continu. */
  tick() {
    const now = Date.now();
    const finished = this.tickFades(now);
    this.render();

    for (const u of this.show.universes) {
      if (u.enabled === false) continue;
      const buf = this.buffers.get(u.id);
      if (!buf) continue;
      this.sender.sendUniverse({
        net: u.net,
        subNet: u.subNet,
        universe: u.universe,
        data: buf,
        target: u.mode === 'unicast' && u.target ? u.target : (this.show.settings.broadcastAddress || '255.255.255.255')
      });
    }

    this.frame++;
    // Pendant un fade, on informe les clients ~10 fois par seconde pour que les
    // curseurs suivent, sans saturer la liaison WebSocket.
    if (this.fades.size > 0 && this.frame % 3 === 0) {
      this.emit('fadeProgress', this.snapshotFading());
    }
    if (finished.length) this.emit('values', finished);
  }

  /** Valeurs des attributs actuellement en fade (pour rafraîchir l'UI). */
  snapshotFading() {
    const out = [];
    for (const fade of this.fades.values()) {
      const map = this.values.get(fade.fixtureId);
      if (map) out.push({ id: fade.fixtureId, attr: fade.attr, value: map.get(fade.attr) });
    }
    return out;
  }

  /** Buffers DMX courants, pour l'onglet Debug (tableaux d'entiers 0..255). */
  monitorSnapshot() {
    const out = [];
    for (const u of this.show.universes) {
      const buf = this.buffers.get(u.id);
      if (!buf) continue;
      out.push({ universeId: u.id, name: u.name, data: [...buf] });
    }
    return out;
  }
}

/** Un attribut de couleur additive ? (utilisé pour le dimmer virtuel) */
function isColorAttr(attr) {
  return ['red', 'green', 'blue', 'white', 'amber', 'uv'].includes(attr);
}
