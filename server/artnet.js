/**
 * Module Art-Net : construction et émission des paquets UDP.
 *
 * Implémentation manuelle (dgram) plutôt qu'une dépendance externe, pour garder
 * le contrôle sur : le champ Net / Sub-Net / Universe, le numéro de séquence,
 * le choix broadcast/unicast et la découverte de nodes (ArtPoll / ArtPollReply).
 *
 * Référence : spécification Art-Net 4 (Artistic Licence).
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

/** Port UDP officiel Art-Net (0x1936). */
export const ARTNET_PORT = 6454;

/** En-tête présent au début de TOUS les paquets Art-Net : "Art-Net" + octet nul. */
const ARTNET_ID = Buffer.from([0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]);

/** Version de protocole (14 = Art-Net 4). */
const PROT_VER_HI = 0;
const PROT_VER_LO = 14;

// OpCodes utilisés (transmis en little-endian dans le paquet).
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const OP_DMX = 0x5000;

/**
 * Calcule l'adresse de port Art-Net 15 bits à partir de Net / Sub-Net / Universe.
 *   bits 14..8 = Net (0..127)
 *   bits  7..4 = Sub-Net (0..15)
 *   bits  3..0 = Universe (0..15)
 */
export function portAddress(net = 0, subNet = 0, universe = 0) {
  return ((net & 0x7f) << 8) | ((subNet & 0x0f) << 4) | (universe & 0x0f);
}

/**
 * Construit un paquet ArtDMX prêt à être envoyé.
 *
 * @param {Object} opts
 * @param {number} opts.net       Net Art-Net (0..127)
 * @param {number} opts.subNet    Sub-Net (0..15)
 * @param {number} opts.universe  Universe (0..15)
 * @param {number} opts.sequence  Numéro de séquence 1..255 (0 = séquencement désactivé)
 * @param {number} [opts.physical] Port physique d'origine, purement informatif
 * @param {Buffer} opts.data      Données DMX (1 à 512 octets)
 * @returns {Buffer} paquet complet (18 octets d'en-tête + données)
 */
export function buildArtDmx({ net = 0, subNet = 0, universe = 0, sequence = 0, physical = 0, data }) {
  if (!Buffer.isBuffer(data)) throw new TypeError('buildArtDmx: data doit être un Buffer');
  if (data.length < 1 || data.length > 512) throw new RangeError('buildArtDmx: longueur DMX invalide');

  // La spec impose une longueur paire, comprise entre 2 et 512.
  const length = data.length % 2 === 0 ? data.length : data.length + 1;

  const pkt = Buffer.alloc(18 + length);
  ARTNET_ID.copy(pkt, 0);                    // 0-7   : "Art-Net\0"
  pkt.writeUInt16LE(OP_DMX, 8);              // 8-9   : OpCode (little-endian)
  pkt[10] = PROT_VER_HI;                     // 10    : version haute
  pkt[11] = PROT_VER_LO;                     // 11    : version basse
  pkt[12] = sequence & 0xff;                 // 12    : séquence
  pkt[13] = physical & 0xff;                 // 13    : port physique
  pkt[14] = ((subNet & 0x0f) << 4) | (universe & 0x0f); // 14 : SubUni
  pkt[15] = net & 0x7f;                      // 15    : Net
  pkt.writeUInt16BE(length, 16);             // 16-17 : longueur (big-endian !)
  data.copy(pkt, 18);                        // 18+   : données DMX
  return pkt;
}

/** Construit un paquet ArtPoll (demande de recensement des nodes). */
export function buildArtPoll() {
  const pkt = Buffer.alloc(14);
  ARTNET_ID.copy(pkt, 0);
  pkt.writeUInt16LE(OP_POLL, 8);
  pkt[10] = PROT_VER_HI;
  pkt[11] = PROT_VER_LO;
  pkt[12] = 0x00; // Flags : pas de réponse automatique à chaque changement
  pkt[13] = 0x10; // Priorité de diagnostic (DpLow)
  return pkt;
}

/** Lit une chaîne terminée par un octet nul dans un buffer. */
function readCString(buf, offset, maxLen) {
  const end = Math.min(offset + maxLen, buf.length);
  let stop = end;
  for (let i = offset; i < end; i++) {
    if (buf[i] === 0) { stop = i; break; }
  }
  return buf.toString('latin1', offset, stop).trim();
}

/**
 * Décode un paquet ArtPollReply.
 * @returns {Object|null} informations du node, ou null si le paquet est invalide
 */
export function parseArtPollReply(buf) {
  if (buf.length < 207 || !buf.subarray(0, 8).equals(ARTNET_ID)) return null;
  if (buf.readUInt16LE(8) !== OP_POLL_REPLY) return null;

  const numPorts = buf.length >= 174 ? buf.readUInt16BE(172) : 0;
  const swOut = [];
  for (let i = 0; i < Math.min(numPorts, 4); i++) {
    // Adresse de port complète = Net (18) + Sub-Net (19, poids fort) + SwOut (190+i)
    swOut.push(portAddress(buf[18], buf[19] >> 4, buf[190 + i] & 0x0f));
  }

  return {
    ip: `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`,
    port: buf.readUInt16LE(14),
    shortName: readCString(buf, 26, 18),
    longName: readCString(buf, 44, 64),
    nodeReport: readCString(buf, 108, 64),
    net: buf[18],
    subNet: buf[19] >> 4,
    numPorts,
    outputs: swOut
  };
}

/**
 * Émetteur Art-Net : encapsule la socket UDP, les numéros de séquence
 * et la table des nodes découverts.
 *
 * Événements :
 *   - 'node'  (node)   : un ArtPollReply a été reçu / rafraîchi
 *   - 'error' (err)    : erreur socket
 *   - 'ready' ({port}) : socket prête
 */
export class ArtNetSender extends EventEmitter {
  constructor({ bindAddress = '0.0.0.0' } = {}) {
    super();
    this.bindAddress = bindAddress;
    this.socket = null;
    this.ready = false;
    /** Numéro de séquence par adresse de port (la spec demande un compteur par univers). */
    this.sequences = new Map();
    /** Nodes découverts, indexés par IP. */
    this.nodes = new Map();
    /** Statistiques d'émission, utilisées par l'indicateur de connexion de l'UI. */
    this.stats = { packetsSent: 0, bytesSent: 0, lastSendAt: 0, lastError: null };
  }

  /**
   * Ouvre la socket UDP. On tente de se lier au port 6454 afin de pouvoir
   * RECEVOIR les ArtPollReply (les nodes répondent sur ce port). Si le port est
   * déjà pris (autre logiciel Art-Net sur la machine), on retombe sur un port
   * éphémère : l'émission fonctionne toujours, seule la découverte est perdue.
   */
  start() {
    return new Promise((resolve) => {
      const bind = (port, isFallback) => {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        socket.on('error', (err) => {
          if (!this.ready && !isFallback && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
            // Port 6454 indisponible : on réessaie sur un port éphémère.
            socket.close();
            bind(0, true);
            return;
          }
          this.stats.lastError = err.message;
          this.emit('error', err);
        });

        socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));

        socket.on('listening', () => {
          socket.setBroadcast(true);
          this.socket = socket;
          this.ready = true;
          const address = socket.address();
          this.discoveryEnabled = !isFallback;
          this.emit('ready', { port: address.port, discovery: !isFallback });
          resolve({ port: address.port, discovery: !isFallback });
        });

        socket.bind(port, this.bindAddress);
      };
      bind(ARTNET_PORT, false);
    });
  }

  /** Ferme la socket (arrêt propre du serveur). */
  stop() {
    this.ready = false;
    if (this.socket) {
      try { this.socket.close(); } catch { /* socket déjà fermée */ }
      this.socket = null;
    }
  }

  _onMessage(msg, rinfo) {
    const reply = parseArtPollReply(msg);
    if (!reply) return;
    const node = { ...reply, ip: reply.ip === '0.0.0.0' ? rinfo.address : reply.ip, lastSeen: Date.now() };
    this.nodes.set(node.ip, node);
    this.emit('node', node);
  }

  /** Liste des nodes vus récemment (fenêtre par défaut : 30 s). */
  listNodes(maxAgeMs = 30000) {
    const now = Date.now();
    return [...this.nodes.values()].filter((n) => now - n.lastSeen < maxAgeMs);
  }

  /** Diffuse un ArtPoll pour découvrir les nodes du réseau. */
  poll(broadcastAddress = '255.255.255.255') {
    if (!this.ready) return;
    const pkt = buildArtPoll();
    this.socket.send(pkt, 0, pkt.length, ARTNET_PORT, broadcastAddress, (err) => {
      if (err) this.stats.lastError = err.message;
    });
  }

  /**
   * Envoie un univers DMX.
   *
   * @param {Object} opts
   * @param {number} opts.net
   * @param {number} opts.subNet
   * @param {number} opts.universe
   * @param {Buffer} opts.data       512 octets
   * @param {string} opts.target     IP de destination (unicast) ou adresse de broadcast
   */
  sendUniverse({ net = 0, subNet = 0, universe = 0, data, target = '255.255.255.255' }) {
    if (!this.ready) return false;

    // Compteur de séquence : 1..255, 0 étant réservé à "séquencement désactivé".
    const addr = portAddress(net, subNet, universe);
    const next = ((this.sequences.get(addr) || 0) % 255) + 1;
    this.sequences.set(addr, next);

    const pkt = buildArtDmx({ net, subNet, universe, sequence: next, data });
    this.socket.send(pkt, 0, pkt.length, ARTNET_PORT, target, (err) => {
      if (err) {
        this.stats.lastError = `${target} : ${err.message}`;
        return;
      }
      this.stats.packetsSent++;
      this.stats.bytesSent += pkt.length;
      this.stats.lastSendAt = Date.now();
      this.stats.lastError = null;
    });
    return true;
  }
}
