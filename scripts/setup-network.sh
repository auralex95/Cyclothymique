#!/usr/bin/env bash
#
# Réseau autonome pour le Raspberry Pi : point d'accès Wi-Fi pour l'iPad,
# et adresse fixe sur l'Ethernet vers les nodes Art-Net.
#
# Objectif : plus aucun réseau extérieur. Le Pi diffuse son propre Wi-Fi,
# l'iPad s'y connecte, et l'Art-Net part sur le câble Ethernet.
#
#   iPad ──Wi-Fi(Pi)──> Raspberry Pi ──Ethernet──> node Art-Net ──DMX──> projecteurs
#
# Usage :
#   sudo ./scripts/setup-network.sh --ssid ArtNet --password monmotdepasse [options]
#
# Options :
#   --ssid <nom>        Nom du réseau Wi-Fi diffusé par le Pi (obligatoire)
#   --password <mdp>    Mot de passe Wi-Fi, 8 caractères minimum (obligatoire)
#   --ap-ip <ip/masque> Adresse du Pi sur son Wi-Fi (défaut : 192.168.50.1/24)
#   --band <bg|a>       2,4 GHz (bg, plus compatible) ou 5 GHz (a) — défaut : bg
#   --wifi-iface <if>   Interface Wi-Fi (défaut : wlan0)
#   --eth-ip <ip/masque> Adresse fixe sur l'Ethernet, ex. 2.0.0.10/8 (optionnel)
#   --eth-iface <if>    Interface Ethernet (défaut : eth0)
#   --dry-run           Afficher les commandes sans les exécuter
#   -h, --help          Cette aide
#
# Prérequis : Raspberry Pi OS Bookworm ou plus récent (réseau géré par
# NetworkManager) et le pays Wi-Fi renseigné — sinon la radio reste bloquée :
#   sudo raspi-config  →  Localisation Options  →  WLAN Country
#
# ATTENTION : passer le Wi-Fi en point d'accès coupe la connexion au réseau
# Wi-Fi habituel du Pi. Lancez ce script depuis un écran/clavier ou par SSH
# via l'Ethernet, jamais par SSH en Wi-Fi.

set -euo pipefail

SSID=""
PASSWORD=""
AP_IP="192.168.50.1/24"
BAND="bg"
WIFI_IFACE="wlan0"
ETH_IP=""
ETH_IFACE="eth0"
DRY_RUN=0
AP_CONN="artnet-hotspot"

info()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR > 1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [simulation] %s\n' "$*"
  else
    "$@"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ssid)       SSID="${2:-}"; shift 2 ;;
    --password)   PASSWORD="${2:-}"; shift 2 ;;
    --ap-ip)      AP_IP="${2:-}"; shift 2 ;;
    --band)       BAND="${2:-}"; shift 2 ;;
    --wifi-iface) WIFI_IFACE="${2:-}"; shift 2 ;;
    --eth-ip)     ETH_IP="${2:-}"; shift 2 ;;
    --eth-iface)  ETH_IFACE="${2:-}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage ;;
    *)            fail "Option inconnue : $1 (--help pour l'aide)" ;;
  esac
done

# --- vérifications ---------------------------------------------------------
[ -n "$SSID" ] || fail "--ssid est obligatoire (--help pour l'aide)"
[ -n "$PASSWORD" ] || fail "--password est obligatoire"
[ "${#PASSWORD}" -ge 8 ] || fail "Le mot de passe Wi-Fi doit faire au moins 8 caractères (WPA2)"
case "$BAND" in
  bg|a) ;;
  *) fail "--band accepte « bg » (2,4 GHz) ou « a » (5 GHz)" ;;
esac
case "$AP_IP" in
  */*) ;;
  *) fail "--ap-ip doit inclure le masque, ex. 192.168.50.1/24" ;;
esac
if [ -n "$ETH_IP" ]; then
  case "$ETH_IP" in
    */*) ;;
    *) fail "--eth-ip doit inclure le masque, ex. 2.0.0.10/8" ;;
  esac
fi

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || fail "À lancer avec sudo"
  command -v nmcli >/dev/null 2>&1 || fail "nmcli introuvable : ce script suppose NetworkManager (Raspberry Pi OS Bookworm ou plus récent)"
  systemctl is-active --quiet NetworkManager || warn "NetworkManager ne semble pas actif"
fi

AP_ADDR="${AP_IP%%/*}"

info "Point d'accès : « $SSID » sur $WIFI_IFACE ($([ "$BAND" = a ] && echo "5 GHz" || echo "2,4 GHz"))"
info "Adresse du Pi : $AP_IP"
[ -n "$ETH_IP" ] && info "Ethernet      : $ETH_IP sur $ETH_IFACE"

# --- point d'accès Wi-Fi ---------------------------------------------------
# Un profil NetworkManager dédié, recréé à chaque exécution pour rester idempotent.
if [ "$DRY_RUN" -eq 0 ] && nmcli -g NAME connection show | grep -qx "$AP_CONN"; then
  info "Profil « $AP_CONN » existant : remplacement"
  run nmcli connection delete "$AP_CONN"
fi

run nmcli connection add type wifi ifname "$WIFI_IFACE" con-name "$AP_CONN" \
  autoconnect yes ssid "$SSID"

# mode ap + ipv4 « shared » : NetworkManager fournit le DHCP à l'iPad.
run nmcli connection modify "$AP_CONN" \
  802-11-wireless.mode ap \
  802-11-wireless.band "$BAND" \
  ipv4.method shared \
  ipv4.addresses "$AP_IP" \
  connection.autoconnect-priority 10

run nmcli connection modify "$AP_CONN" \
  wifi-sec.key-mgmt wpa-psk \
  wifi-sec.proto rsn \
  wifi-sec.pairwise ccmp \
  wifi-sec.group ccmp \
  wifi-sec.psk "$PASSWORD"

# --- Ethernet vers les nodes Art-Net ---------------------------------------
if [ -n "$ETH_IP" ]; then
  ETH_CONN=""
  if [ "$DRY_RUN" -eq 0 ]; then
    # On retrouve le profil réellement associé à l'interface Ethernet.
    ETH_CONN="$(nmcli -t -g GENERAL.CONNECTION device show "$ETH_IFACE" 2>/dev/null || true)"
  fi
  if [ -z "$ETH_CONN" ] || [ "$ETH_CONN" = "--" ]; then
    ETH_CONN="artnet-ethernet"
    info "Aucun profil actif sur $ETH_IFACE : création de « $ETH_CONN »"
    if [ "$DRY_RUN" -eq 0 ] && nmcli -g NAME connection show | grep -qx "$ETH_CONN"; then
      run nmcli connection delete "$ETH_CONN"
    fi
    run nmcli connection add type ethernet ifname "$ETH_IFACE" con-name "$ETH_CONN" autoconnect yes
  fi
  # Adresse fixe, sans passerelle : réseau lumière dédié, pas de route par défaut.
  run nmcli connection modify "$ETH_CONN" \
    ipv4.method manual \
    ipv4.addresses "$ETH_IP" \
    ipv4.gateway "" \
    ipv4.never-default yes
  run nmcli connection up "$ETH_CONN"
fi

# --- activation ------------------------------------------------------------
info "Activation du point d'accès…"
run nmcli connection up "$AP_CONN"

echo
ok "Réseau configuré."
echo "  1. Sur l'iPad : Réglages → Wi-Fi → « $SSID »"
echo "  2. Ouvrir Safari sur  http://${AP_ADDR}:3000"
echo "  3. Partager → Sur l'écran d'accueil (pour le plein écran)"
if [ -n "$ETH_IP" ]; then
  echo
  echo "  Dans l'onglet Réseau de l'application, réglez l'adresse de broadcast"
  echo "  sur le réseau lumière (ex. 2.255.255.255 pour un Pi en ${ETH_IP})."
  echo "  Sans cela, la diffusion pourrait partir par le Wi-Fi au lieu du câble."
fi
echo
echo "  Revenir en Wi-Fi client :  sudo nmcli connection down $AP_CONN"
echo "  Supprimer le point d'accès : sudo nmcli connection delete $AP_CONN"
