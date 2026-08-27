#!/usr/bin/env bash
#
# Installation du contrôleur Art-Net en service permanent sur Raspberry Pi.
#
# Ce script rend le Pi autonome : le serveur démarre tout seul au boot, se
# relance en cas de problème, et l'iPad n'a plus qu'à ouvrir une page web.
# Aucun ordinateur n'est nécessaire ensuite.
#
# Usage :
#   sudo ./scripts/install-raspberry-pi.sh [options]
#
# Options :
#   --user <nom>     Utilisateur qui exécutera le service (défaut : propriétaire du dossier)
#   --port <port>    Port HTTP de l'interface web (défaut : 3000)
#   --bind <ip>      Interface d'émission Art-Net, ex. 2.0.0.10 (défaut : toutes)
#   --no-start       Installer sans démarrer tout de suite
#   --dry-run        Afficher ce qui serait fait, sans rien modifier
#   -h, --help       Cette aide
#
# Le script est idempotent : on peut le relancer après un « git pull ».

set -euo pipefail

SERVICE_NAME="artnet-control"
PORT="3000"
ARTNET_BIND=""
RUN_USER=""
START_SERVICE=1
DRY_RUN=0

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- sortie lisible --------------------------------------------------------
info()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# L'aide est le bloc de commentaires en tête de fichier.
usage() {
  awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
}

# Exécute une commande, ou l'affiche seulement en mode simulation.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [simulation] %s\n' "$*"
  else
    "$@"
  fi
}

# --- arguments -------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --user)     RUN_USER="${2:-}"; shift 2 ;;
    --port)     PORT="${2:-}"; shift 2 ;;
    --bind)     ARTNET_BIND="${2:-}"; shift 2 ;;
    --no-start) START_SERVICE=0; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage ;;
    *)          fail "Option inconnue : $1 (--help pour l'aide)" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) fail "Port invalide : $PORT" ;;
esac

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  fail "À lancer avec sudo : sudo $0 $*"
fi

# Utilisateur du service : par défaut le propriétaire du dossier du projet,
# pour que le serveur puisse écrire data/show/show.json.
if [ -z "$RUN_USER" ]; then
  RUN_USER="$(stat -c '%U' "$PROJECT_DIR")"
fi
if ! id "$RUN_USER" >/dev/null 2>&1; then
  fail "Utilisateur inconnu : $RUN_USER"
fi

info "Projet      : $PROJECT_DIR"
info "Utilisateur : $RUN_USER"
info "Port HTTP   : $PORT"
[ -n "$ARTNET_BIND" ] && info "Émission    : $ARTNET_BIND"

# --- Node.js ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  info "Node.js absent, installation depuis les dépôts du système…"
  run apt-get update
  run apt-get install -y nodejs npm
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js $NODE_MAJOR détecté, version 18 minimum requise.
     Sur Raspberry Pi OS ancien : installez une version récente via https://deb.nodesource.com"
  fi
  ok "Node.js $(node -v)"
fi

# --- dépendances du projet -------------------------------------------------
info "Installation des dépendances (sans les outils de développement)…"
if [ -f "$PROJECT_DIR/package-lock.json" ]; then
  run sudo -u "$RUN_USER" npm --prefix "$PROJECT_DIR" ci --omit=dev
else
  run sudo -u "$RUN_USER" npm --prefix "$PROJECT_DIR" install --omit=dev
fi

# --- service systemd -------------------------------------------------------
NODE_BIN="$(command -v node || echo /usr/bin/node)"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
info "Écriture du service $UNIT_PATH"

UNIT_CONTENT="[Unit]
Description=Controleur DMX / Art-Net (interface web pour iPad)
Documentation=https://github.com/auralex95/Cyclothymique
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} ${PROJECT_DIR}/server/index.js
Environment=NODE_ENV=production
Environment=PORT=${PORT}"

if [ -n "$ARTNET_BIND" ]; then
  UNIT_CONTENT="${UNIT_CONTENT}
Environment=ARTNET_BIND=${ARTNET_BIND}"
fi

UNIT_CONTENT="${UNIT_CONTENT}
# Redémarrage automatique : en régie, le serveur doit toujours revenir.
Restart=always
RestartSec=3
# L'arrêt propre sauvegarde le show en cours.
KillSignal=SIGINT
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '    [simulation] contenu du service :\n'
  printf '%s\n' "$UNIT_CONTENT" | sed 's/^/      /'
else
  printf '%s\n' "$UNIT_CONTENT" > "$UNIT_PATH"
fi

run systemctl daemon-reload
run systemctl enable "$SERVICE_NAME"

if [ "$START_SERVICE" -eq 1 ]; then
  info "Démarrage du service…"
  run systemctl restart "$SERVICE_NAME"
  if [ "$DRY_RUN" -eq 0 ]; then
    sleep 2
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      ok "Service actif"
    else
      warn "Le service n'a pas démarré. Journal :"
      journalctl -u "$SERVICE_NAME" -n 20 --no-pager >&2 || true
      exit 1
    fi
  fi
fi

# --- adresses d'accès ------------------------------------------------------
echo
ok "Installation terminée."
echo "  Ouvrez l'interface depuis l'iPad :"
if [ "$DRY_RUN" -eq 0 ]; then
  # shellcheck disable=SC2312  # la liste d'IP est indicative, un échec n'est pas bloquant
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | while read -r ip; do
    echo "    http://${ip}:${PORT}"
  done
  echo "    http://$(hostname).local:${PORT}   (si Bonjour/mDNS est disponible)"
fi
echo
echo "  Commandes utiles :"
echo "    sudo systemctl status ${SERVICE_NAME}     état du service"
echo "    sudo journalctl -u ${SERVICE_NAME} -f     journal en direct"
echo "    sudo systemctl restart ${SERVICE_NAME}    après un git pull"
