#!/usr/bin/env bash
#
# Mode kiosque : au démarrage, le Raspberry Pi ouvre l'application en plein
# écran sur son écran tactile, directement sur l'écran d'exploitation (Live).
#
# Le Pi devient alors un pupitre autonome : on l'allume, il affiche les looks.
# Aucun clavier, aucune souris, aucun ordinateur.
#
# Usage :
#   ./scripts/setup-kiosk.sh [options]        (sans sudo : configuration de VOTRE session)
#
# Options :
#   --url <url>       Adresse ouverte au démarrage
#                     (défaut : http://localhost:3000/?mode=live)
#   --mode <live|admin>  Écran ouvert au démarrage (défaut : live)
#   --port <port>     Port du serveur, si l'URL par défaut est utilisée (défaut : 3000)
#   --rotate <0|90|180|270>  Rotation à appliquer (dalle officielle 7" : 90 ou 270)
#   --remove          Retirer le démarrage automatique
#   --dry-run         Afficher ce qui serait fait, sans rien modifier
#   -h, --help        Cette aide
#
# Le script écrit un démarrage automatique pour les trois environnements
# rencontrés sur Raspberry Pi OS (XDG/LXDE, wayfire, labwc) : celui qui est
# actif prend la main, les autres sont ignorés.
#
# NON TESTÉ SUR MATÉRIEL : la mise en veille de l'écran et la rotation
# dépendent de la version de Raspberry Pi OS. Vérifiez au premier démarrage,
# et voyez la documentation : docs/raspberry-pi.md

set -euo pipefail

PORT="3000"
MODE="live"
URL=""
ROTATE=""
REMOVE=0
DRY_RUN=0

APP_NAME="artnet-kiosk"

info()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)     URL="${2:-}"; shift 2 ;;
    --mode)    MODE="${2:-}"; shift 2 ;;
    --port)    PORT="${2:-}"; shift 2 ;;
    --rotate)  ROTATE="${2:-}"; shift 2 ;;
    --remove)  REMOVE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *)         fail "Option inconnue : $1 (--help pour l'aide)" ;;
  esac
done

case "$MODE" in
  live|admin) ;;
  *) fail "--mode accepte « live » ou « admin »" ;;
esac
case "${ROTATE:-0}" in
  0|90|180|270) ;;
  *) fail "--rotate accepte 0, 90, 180 ou 270" ;;
esac

[ -n "$URL" ] || URL="http://localhost:${PORT}/?mode=${MODE}"

if [ "$(id -u)" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  fail "À lancer SANS sudo : la configuration s'applique à la session graphique de l'utilisateur."
fi

HOME_DIR="${HOME:?}"
XDG_FILE="${HOME_DIR}/.config/autostart/${APP_NAME}.desktop"
WAYFIRE_INI="${HOME_DIR}/.config/wayfire.ini"
LABWC_AUTOSTART="${HOME_DIR}/.config/labwc/autostart"
LAUNCHER="${HOME_DIR}/.local/bin/${APP_NAME}.sh"

write_file() {   # write_file <chemin> <contenu>
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [simulation] écriture de %s :\n' "$1"
    printf '%s\n' "$2" | sed 's/^/      /'
  else
    mkdir -p "$(dirname "$1")"
    printf '%s\n' "$2" > "$1"
  fi
}

remove_file() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [simulation] suppression de %s\n' "$1"
  elif [ -e "$1" ]; then
    rm -f "$1"
    info "Retiré : $1"
  fi
}

# --- désinstallation --------------------------------------------------------
if [ "$REMOVE" -eq 1 ]; then
  remove_file "$XDG_FILE"
  remove_file "$LAUNCHER"
  remove_file "$LABWC_AUTOSTART"
  if [ -f "$WAYFIRE_INI" ] && [ "$DRY_RUN" -eq 0 ]; then
    sed -i "/^${APP_NAME}[[:space:]]*=/d" "$WAYFIRE_INI"
    info "Entrée retirée de $WAYFIRE_INI"
  fi
  ok "Mode kiosque désactivé. Redémarrez pour revenir au bureau normal."
  exit 0
fi

# --- navigateur -------------------------------------------------------------
BROWSER=""
for candidate in chromium-browser chromium; do
  if command -v "$candidate" >/dev/null 2>&1; then BROWSER="$candidate"; break; fi
done
if [ -z "$BROWSER" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    BROWSER="chromium-browser"
    warn "Chromium introuvable ici : la simulation utilise « chromium-browser »"
  else
    fail "Chromium introuvable. Installez-le : sudo apt install -y chromium-browser"
  fi
fi

info "Navigateur : $BROWSER"
info "Adresse    : $URL"
[ -n "$ROTATE" ] && [ "$ROTATE" != "0" ] && info "Rotation   : ${ROTATE}°"

# --- script de lancement ----------------------------------------------------
# Il attend que le serveur réponde : au démarrage, le service et la session
# graphique se lancent en parallèle, et Chromium serait sinon plus rapide.
LAUNCHER_CONTENT="#!/usr/bin/env bash
# Lancement du contrôleur Art-Net en plein écran. Généré par scripts/setup-kiosk.sh
set -u

URL='${URL}'

# On patiente jusqu'à 60 s que le serveur réponde.
for _ in \$(seq 1 60); do
  if curl -fsS --max-time 1 -o /dev/null \"\$URL\"; then break; fi
  sleep 1
done
"

if [ -n "$ROTATE" ] && [ "$ROTATE" != "0" ]; then
  # Les valeurs de rotation sont résolues ici : le lanceur généré reste simple.
  case "$ROTATE" in
    90)  WLR_TRANSFORM="90";  X_ROT="right" ;;
    180) WLR_TRANSFORM="180"; X_ROT="inverted" ;;
    270) WLR_TRANSFORM="270"; X_ROT="left" ;;
    *)   WLR_TRANSFORM="normal"; X_ROT="normal" ;;
  esac

  LAUNCHER_CONTENT="${LAUNCHER_CONTENT}
# Rotation de l'écran (Wayland : wlr-randr ; X11 : xrandr). Les deux sont
# tentées, celle qui ne s'applique pas échoue sans conséquence.
if command -v wlr-randr >/dev/null 2>&1; then
  OUTPUT=\$(wlr-randr 2>/dev/null | awk 'NR==1{print \$1}')
  [ -n \"\$OUTPUT\" ] && wlr-randr --output \"\$OUTPUT\" --transform ${WLR_TRANSFORM} || true
fi
if command -v xrandr >/dev/null 2>&1 && [ -n \"\${DISPLAY:-}\" ]; then
  OUTPUT=\$(xrandr --query 2>/dev/null | awk '/ connected/{print \$1; exit}')
  [ -n \"\$OUTPUT\" ] && xrandr --output \"\$OUTPUT\" --rotate ${X_ROT} || true
fi
"
fi

LAUNCHER_CONTENT="${LAUNCHER_CONTENT}
# Extinction de l'économiseur et de la mise en veille (X11 uniquement ;
# sous Wayland, passez par raspi-config → Display Options → Screen Blanking).
if command -v xset >/dev/null 2>&1 && [ -n \"\${DISPLAY:-}\" ]; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi

exec ${BROWSER} \\
  --kiosk \\
  --app=\"\$URL\" \\
  --noerrdialogs \\
  --disable-infobars \\
  --disable-session-crashed-bubble \\
  --disable-features=TranslateUI \\
  --check-for-update-interval=31536000 \\
  --overscroll-history-navigation=0 \\
  --autoplay-policy=no-user-gesture-required"

write_file "$LAUNCHER" "$LAUNCHER_CONTENT"
run_chmod() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [simulation] chmod +x %s\n' "$1"
  else
    chmod +x "$1"
  fi
}
run_chmod "$LAUNCHER"

# --- démarrages automatiques ------------------------------------------------
write_file "$XDG_FILE" "[Desktop Entry]
Type=Application
Name=Controleur Art-Net (kiosque)
Comment=Ouvre l'interface de contrôle en plein écran au démarrage
Exec=${LAUNCHER}
X-GNOME-Autostart-enabled=true"

# labwc (Raspberry Pi OS récent)
if [ -d "${HOME_DIR}/.config/labwc" ] || command -v labwc >/dev/null 2>&1 || [ "$DRY_RUN" -eq 1 ]; then
  write_file "$LABWC_AUTOSTART" "${LAUNCHER} &"
  run_chmod "$LABWC_AUTOSTART"
fi

# wayfire (Raspberry Pi OS Bookworm sur Pi 4)
if [ -f "$WAYFIRE_INI" ] || [ "$DRY_RUN" -eq 1 ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [simulation] ajout de « %s = %s » dans la section [autostart] de %s\n' "$APP_NAME" "$LAUNCHER" "$WAYFIRE_INI"
  else
    if ! grep -q '^\[autostart\]' "$WAYFIRE_INI"; then
      printf '\n[autostart]\n' >> "$WAYFIRE_INI"
    fi
    sed -i "/^${APP_NAME}[[:space:]]*=/d" "$WAYFIRE_INI"
    sed -i "/^\[autostart\]/a ${APP_NAME} = ${LAUNCHER}" "$WAYFIRE_INI"
    info "Entrée ajoutée dans $WAYFIRE_INI"
  fi
fi

echo
ok "Mode kiosque configuré."
echo "  Essayer tout de suite  : ${LAUNCHER}"
echo "  Quitter le plein écran : Alt+F4, ou brancher un clavier et faire Ctrl+W"
echo "  Désactiver             : ./scripts/setup-kiosk.sh --remove"
echo
echo "  Au prochain démarrage, le Pi ouvrira ${URL}"
[ "$MODE" = "live" ] && echo "  L'écran s'ouvre en mode Live ; le bouton « Régie » donne accès à la programmation."
