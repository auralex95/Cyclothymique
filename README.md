# Contrôleur DMX / Art-Net — lyres & LED (iPad / navigateur)

Application autonome et légère pour piloter des lyres asservies et des projecteurs LED
depuis un iPad ou un navigateur, via **Art-Net** sur le réseau local, sans passer par
une console lumière.

- **Backend Node.js** : construit et envoie les trames ArtDMX en UDP (broadcast ou unicast),
  découvre les nodes (ArtPoll / ArtPollReply), expose une API WebSocket temps réel.
- **Frontend web** servi par ce même serveur : interface tactile, utilisable en PWA plein écran
  sur iPad. **Aucune étape de build** — pas de npm run build, pas de bundler.

---

## Démarrage rapide

```bash
npm install
npm start
```

Le serveur affiche les adresses à ouvrir :

```
  Contrôleur Art-Net démarré
    http://localhost:3000
    http://192.168.1.42:3000     ← à ouvrir sur l'iPad (même réseau Wi-Fi)
```

Sur iPad : ouvrir l'adresse dans Safari → **Partager → Sur l'écran d'accueil**.
L'application se lance ensuite en plein écran, sans barre Safari (PWA).

Variables d'environnement :

| Variable      | Défaut    | Rôle |
|---------------|-----------|------|
| `PORT`        | `3000`    | Port HTTP de l'interface web |
| `ARTNET_BIND` | `0.0.0.0` | Interface réseau sur laquelle émettre l'Art-Net |

Tests : `npm test` (paquets Art-Net, rendu DMX, 16 bits, fades, keep-alive).

---

## Prise en main en 4 étapes

1. **Patch** — choisir un profil, un univers, une adresse de départ, une quantité, puis *Patcher*.
   Le bouton *Adresse libre suivante* calcule automatiquement le premier trou disponible ;
   les chevauchements d'adresses sont signalés en rouge.
2. **Réseau** — vérifier l'univers Art-Net (Net / Sub-Net / Universe), choisir broadcast
   ou l'IP d'un node précis, ajuster la fréquence (30 Hz par défaut).
3. **Contrôle** — sélectionner un ou plusieurs projecteurs (ou un groupe), puis régler
   dimmer, pan/tilt, couleur, gobos, zoom…
4. **Presets** — enregistrer un look, le rappeler d'un tap avec le temps de fade voulu.

Un show d'exemple (6 lyres, 4 wash, 4 PAR, groupes et looks) est fourni :
`data/examples/demo-show.json` → onglet **Patch → Importer un show**.

---

## Architecture

```
server/                 Backend Node.js
  index.js              Express + Socket.IO : API temps réel, REST export/import, statut
  artnet.js             Protocole Art-Net : ArtDMX, ArtPoll, ArtPollReply, socket UDP
  engine.js             État du show, rendu DMX, fades, boucle d'émission (keep-alive)
  store.js              Persistance JSON (écriture atomique + différée)

shared/
  attributes.js         Dictionnaire des attributs, partagé serveur ↔ navigateur

public/                 Frontend (modules ES servis tels quels, aucun build)
  index.html            Coquille : bandeau, onglets, voile hors ligne
  style.css             Thème sombre tactile, paysage + portrait, safe-area iPad
  js/
    main.js             Démarrage, navigation, master, blackout, état de connexion
    net.js              Socket.IO client + envoi throttlé (~40 Hz)
    state.js            État local (miroir du serveur) + sélection
    util.js             Helpers DOM, glissé tactile (Pointer Events), toasts
    components/         Faders, pavé XY pan/tilt, color picker
    views/              Contrôle, Presets, Patch, Réseau, Debug
  sw.js                 Service worker (coquille PWA ; jamais le temps réel)

data/
  fixtures/*.json       Bibliothèque de profils (versionnée)
  examples/             Show de démonstration importable
  show/show.json        Show courant : patch, groupes, presets, réseau (généré, non versionné)

test/                   Tests unitaires (node --test)
```

### Pourquoi un backend ?

Un navigateur ne peut pas émettre de paquets UDP bruts. Le serveur Node fait donc le pont :

```
iPad / navigateur  ──WebSocket──►  serveur Node  ──UDP Art-Net──►  nodes / projecteurs
```

L'état complet du show vit **côté serveur** : plusieurs iPad restent synchronisés, et les
presets photographient l'état réel des projecteurs.

---

## Le module Art-Net

`server/artnet.js` implémente le protocole à la main (`dgram`), pour maîtriser le champ
Net / Sub-Net / Universe, le séquencement et le choix broadcast / unicast.

Structure du paquet **ArtDMX** (Art-Net 4) :

| Octets | Contenu |
|--------|---------|
| 0–7    | `Art-Net\0` |
| 8–9    | OpCode `0x5000`, **little-endian** |
| 10–11  | Version de protocole (0, 14) |
| 12     | Séquence (1…255, incrémentée par univers ; 0 = séquencement désactivé) |
| 13     | Port physique |
| 14     | SubUni = `(Sub-Net << 4) | Universe` |
| 15     | Net (7 bits) |
| 16–17  | Longueur des données, **big-endian**, paire, 2…512 |
| 18+    | 512 octets DMX |

L'adresse de port 15 bits vaut `Net × 256 + Sub-Net × 16 + Universe`.

Découverte : un **ArtPoll** est diffusé toutes les 5 s ; les **ArtPollReply** reçus sur le
port 6454 alimentent la liste des nodes (onglet Réseau, bouton *Cibler* pour basculer les
sorties en unicast vers un node).

> Si le port 6454 est déjà occupé par un autre logiciel Art-Net sur la même machine, le
> serveur bascule automatiquement sur un port éphémère : **l'émission continue de
> fonctionner**, seule la réception des réponses de découverte est perdue (message au démarrage).

### Keep-alive

La boucle d'émission tourne en permanence à la fréquence configurée (30 Hz par défaut),
**même sans aucune interaction**. C'est indispensable : de nombreux nodes et projecteurs
coupent la sortie en cas de perte de signal DMX. Elle n'est jamais suspendue, ni par
l'absence de client web, ni par un blackout.

---

## API WebSocket

Le client reçoit `init` à la connexion (show, bibliothèque, valeurs, master, blackout, statut),
puis les mises à jour au fil de l'eau.

**Client → serveur**

| Événement | Charge utile | Effet |
|-----------|--------------|-------|
| `values:set` | `[{ id, attr, value }]` | Valeurs 0…1 (envoi throttlé à ~40 Hz) |
| `master:set` / `blackout:set` | `number` / `boolean` | Master dimmer, blackout général |
| `patch:add` | `{ profileId, universeId, address, count, step, name }` | Patch en série |
| `patch:update` / `patch:remove` | `{ id, changes }` / `id` | Modification / suppression |
| `group:save` / `group:remove` | `{ name, fixtureIds, mirror }` / `id` | Groupes |
| `preset:record` | `{ name, fixtureIds, fadeTime }` | Instantané (tout ou sélection) |
| `preset:recall` | `{ id, fadeTime }` | Rappel avec fondu |
| `preset:update` / `preset:remove` | `{ id, changes }` / `id` | Édition |
| `universes:save` / `settings:save` | tableau / objet | Réseau et fréquence |
| `artnet:poll` | — | ArtPoll immédiat |
| `monitor:subscribe` | `boolean` | Abonnement aux trames DMX (onglet Debug, 10 Hz) |
| `show:reset` | — | Remise à zéro |

**Serveur → client** : `init`, `show`, `values`, `values:full`, `master`, `blackout`,
`status` (1 Hz), `monitor` (10 Hz, sur abonnement), `preset:recalled`.

**REST** : `GET /api/fixtures`, `GET /api/show` (export), `POST /api/show` (import), `GET /api/status`.

---

## Profils de fixtures

Un profil est un fichier JSON dans `data/fixtures/`. Les valeurs internes sont normalisées
entre 0 et 1 ; le profil décrit uniquement le mapping vers les canaux DMX.

```jsonc
{
  "id": "generic-moving-head-16",
  "name": "Lyre générique 16 canaux",
  "shortName": "Lyre 16ch",          // nom par défaut au patch
  "manufacturer": "Générique",
  "channelCount": 16,
  "channels": {
    // "channel" et "fine" sont des OFFSETS 1-based dans la fixture,
    // pas des adresses DMX absolues.
    "pan":    { "channel": 1, "fine": 2, "default": 0.5 },   // 16 bits
    "dimmer": { "channel": 6, "default": 0 }
  },
  "wheels": {                         // boutons de sélection d'index (roues physiques)
    "colorWheel": [ { "name": "Rouge", "value": 10 } ]       // "value" = valeur DMX 0…255
  }
}
```

Attributs reconnus (voir `shared/attributes.js`) : `pan`, `tilt`, `ptSpeed`, `dimmer`,
`shutter`, `red`, `green`, `blue`, `white`, `amber`, `uv`, `colorWheel`, `cto`, `gobo`,
`goboRotate`, `prism`, `zoom`, `focus`, `iris`, `frost`, `macro`, `macroSpeed`, `control`.

Profils fournis : lyre générique 16 canaux, lyre wash RGBW 12 canaux, wash LED RGBW 8 canaux,
PAR LED RGB 4 canaux, PAR LED RGB 3 canaux (dimmer virtuel).

Pour ajouter un profil : déposer le fichier JSON dans `data/fixtures/`, puis redémarrer le serveur.

**Pan/tilt 16 bits** : dès qu'un profil déclare `fine`, la valeur est répartie sur les deux
canaux (65 536 pas au lieu de 256) — c'est ce qui rend le mouvement fluide.

**Dimmer virtuel** : un projecteur LED sans canal de dimmer (PAR RGB 3 canaux) reste pilotable
en intensité — le dimmer module alors ses composantes de couleur.

---

## Ergonomie tactile

- **Pavé pan/tilt** : glissé **relatif** (le point ne saute pas sous le doigt, indispensable
  quand plusieurs lyres à des positions différentes sont pilotées ensemble).
  Mode **Fine** (bouton ou **double-tap** sur le pavé) : sensibilité divisée par ~7.
  Les autres projecteurs de la sélection apparaissent en repères gris.
- **Miroir** : une lyre sur deux reçoit l'inverse du pan → mouvement symétrique.
- **Blackout** toujours accessible dans le bandeau (barre d'espace sur desktop).
- **Master dimmer** dans le bandeau, appliqué à toutes les intensités.
- Paysage et portrait ; pas de survol nécessaire ; zones tactiles de 48 px minimum.

**Perte de connexion** : un voile explicite s'affiche sur l'iPad (jamais d'échec silencieux),
la reconnexion est automatique, et un bouton *Réessayer maintenant* force une tentative.
La LED du bandeau passe à l'orange si le serveur répond mais n'émet plus d'Art-Net.

---

## Onglet Debug

Affiche les 512 canaux réellement envoyés, univers par univers, avec les plages patchées
encadrées et le détail projecteur / fonction sur chaque case. Le serveur n'envoie ces
données que si un client regarde cet onglet.

---

## Installation sur Raspberry Pi (démarrage automatique)

```bash
sudo tee /etc/systemd/system/artnet-control.service >/dev/null <<'UNIT'
[Unit]
Description=Controleur Art-Net
After=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/artnet-control
ExecStart=/usr/bin/node server/index.js
Environment=PORT=3000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl enable --now artnet-control
```

Recommandations réseau : IP fixe sur le VLAN technique, Wi-Fi dédié à la régie,
et si le broadcast passe mal, préférer l'**unicast** vers l'IP du node
(onglet Réseau, ou bouton *Cibler* sur un node détecté). Selon les installations,
l'adresse de broadcast peut devoir être `2.255.255.255` ou `10.255.255.255`.

---

## Limites assumées

Outil de contrôle **rapide et manuel** : pas de chases programmables, pas de timeline,
pas de tracking de cues comme sur une console. Les looks et le fade au rappel couvrent
l'usage visé ; le reste reste du domaine de la console principale.
