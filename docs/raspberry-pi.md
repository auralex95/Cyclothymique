# Pupitre autonome sur Raspberry Pi

Objectif : un boîtier qu'on allume et qui affiche l'écran d'exploitation sur son
écran tactile. Aucun ordinateur, aucun clavier, aucune souris.

```
[ Écran tactile ]──DSI──[ Raspberry Pi ]──Ethernet──[ node Art-Net ]──DMX──[ projecteurs ]
                                 └────Wi-Fi (optionnel)────[ iPad ]
```

---

## 1. Matériel

**Raspberry Pi 5** (4 Go suffisent) ou **Raspberry Pi 4**. Prévoir un
refroidissement passif si le boîtier est fermé, et une alimentation officielle :
les coupures de courant sont la première cause de carte SD corrompue.

**Écran officiel Raspberry Pi Touch Display 2** — se branche en DSI (nappe) plus
deux fils d'alimentation sur le GPIO, sans HDMI ni USB :

| Taille | Résolution | Tactile | Compatibilité |
|---|---|---|---|
| 5 pouces | — | 5 points | Pi 4, Pi 5 |
| 7 pouces | 720 × 1280 (portrait natif) | 5 points | Pi 4, Pi 5 |
| 10 pouces | 1200 × 1920 | 10 points | **Pi 5 uniquement** |

Le 7 pouces est le bon compromis pour une régie : lisible, compact, compatible
Pi 4 comme Pi 5. La dalle est **portrait par défaut** : posée en paysage, il faut
la faire pivoter (voir l'option `--rotate` plus bas).

Un écran HDMI tactile tiers fonctionne aussi (souvent 10,1 pouces en 1280 × 800) :
il occupe alors le port HDMI et un port USB pour le tactile, et ne demande aucune
configuration particulière.

**Stockage** : une carte microSD de qualité (A2), ou mieux un SSD USB — une carte
bas de gamme finit toujours par lâcher sur un appareil qui reste allumé.

---

## 2. Installation du logiciel

Sur le Pi, une fois Raspberry Pi OS installé et connecté à Internet :

```bash
git clone https://github.com/auralex95/Cyclothymique.git artnet-control
cd artnet-control
sudo ./scripts/install-raspberry-pi.sh
```

Le script installe Node.js si besoin, les dépendances, et crée un service
systemd qui démarre au boot et se relance tout seul. Il est rejouable après
chaque `git pull`.

Options utiles :

```bash
# Émettre l'Art-Net par une interface précise (adresse fixe côté Ethernet)
sudo ./scripts/install-raspberry-pi.sh --bind 2.0.0.10

# Voir ce que ferait le script sans rien modifier
./scripts/install-raspberry-pi.sh --dry-run
```

Commandes de suivi :

```bash
sudo systemctl status artnet-control      # état
sudo journalctl -u artnet-control -f      # journal en direct
sudo systemctl restart artnet-control     # après un git pull
```

---

## 3. Mode kiosque : l'écran s'ouvre tout seul

À lancer **sans sudo**, en tant qu'utilisateur de la session graphique :

```bash
./scripts/setup-kiosk.sh                 # écran tactile en portrait
./scripts/setup-kiosk.sh --rotate 90     # dalle officielle posée en paysage
```

Au démarrage suivant, le Pi ouvre Chromium en plein écran sur
`http://localhost:3000/?mode=live`, après avoir attendu que le serveur réponde.

- Essayer sans redémarrer : `~/.local/bin/artnet-kiosk.sh`
- Désactiver : `./scripts/setup-kiosk.sh --remove`
- Quitter le plein écran : `Alt+F4` (clavier branché)

**Mise en veille de l'écran** — à couper, sinon l'écran s'éteint en plein show :
`sudo raspi-config` → *Display Options* → *Screen Blanking* → *No*.

> Le démarrage automatique est écrit pour les trois environnements de bureau
> rencontrés sur Raspberry Pi OS (XDG/LXDE, wayfire, labwc) : celui qui est actif
> prend la main. Selon la version installée, la rotation et la veille peuvent
> demander un ajustement — vérifiez au premier démarrage.

---

## 4. Réseau

### Cas simple : tout sur le réseau de la salle

Rien à faire : le Pi prend son adresse en DHCP, l'application émet en broadcast.

### Cas recommandé : le Pi crée son propre réseau

Le Pi diffuse son Wi-Fi (pour un iPad en second écran) et garde l'Ethernet pour
les nodes Art-Net :

```bash
sudo ./scripts/setup-network.sh \
  --ssid Regie-Lumiere --password monmotdepasse \
  --eth-ip 2.0.0.10/8
```

L'iPad rejoint alors le réseau `Regie-Lumiere` et ouvre `http://192.168.50.1:3000`.

> **À lancer depuis l'écran du Pi ou par SSH en Ethernet**, jamais par SSH en
> Wi-Fi : le passage en point d'accès coupe la connexion Wi-Fi en cours.
>
> Le pays Wi-Fi doit être renseigné, sinon la radio reste bloquée :
> `sudo raspi-config` → *Localisation Options* → *WLAN Country*.

**Adresse de broadcast avec deux interfaces** : si le Pi a un Wi-Fi *et* un
Ethernet, une diffusion vers `255.255.255.255` ne part que par une seule
interface, choisie par la table de routage — pas forcément la bonne. Réglez donc
l'adresse de broadcast sur le réseau lumière dans l'onglet **Réseau** de
l'application (par exemple `2.255.255.255` pour un Pi en `2.0.0.10/8`), ou
lancez le serveur avec `--bind 2.0.0.10`.

---

## 5. Modes Live et Régie

L'application s'ouvre en **mode Live** : uniquement les looks en grandes tuiles,
les effets à mettre en pause, le master et le blackout. Rien ne peut être
déprogrammé par erreur pendant un spectacle.

Le bouton **Régie** donne accès à la programmation complète (patch, profils,
presets, effets, réseau, debug).

Pour verrouiller la régie : onglet **Réseau** → *Accès à la régie* → *Définir un
code*. Le code est demandé sur un pavé numérique tactile — pas besoin de clavier.
Une fois défini, le serveur refuse toute action de programmation venant d'une
connexion non authentifiée, y compris depuis un autre appareil du réseau.

> C'est un garde-fou contre les fausses manœuvres, **pas une sécurité réseau** :
> la liaison n'est pas chiffrée. Réservez l'application à un réseau technique de
> confiance.

---

## 6. Vérifications au premier démarrage

1. `sudo systemctl status artnet-control` → *active (running)*
2. L'écran tactile affiche les tuiles de looks après le boot
3. L'onglet **Debug** montre des valeurs qui bougent quand on rappelle un look
4. Un projecteur répond réellement (dimmer à 100 %, shutter ouvert)
5. Couper l'alimentation, rallumer : tout doit revenir seul, sans intervention
