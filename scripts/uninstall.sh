#!/usr/bin/env bash
#
# Remove the uptime-sentinel systemd service.
#
#   sudo ./scripts/uninstall.sh            keeps your database and config
#   sudo ./scripts/uninstall.sh --purge    deletes them too
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/uptime-sentinel}"
DATADIR="${DATADIR:-/var/lib/uptime-sentinel}"
CONFDIR="${CONFDIR:-/etc/uptime-sentinel}"
SERVICE_USER="${SERVICE_USER:-uptime-sentinel}"
UNIT="/etc/systemd/system/uptime-sentinel.service"

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo $0 ${1:-}"

if systemctl list-unit-files uptime-sentinel.service >/dev/null 2>&1; then
  say "Stopping and disabling service"
  systemctl disable --now uptime-sentinel >/dev/null 2>&1 || true
fi

rm -f "$UNIT"
systemctl daemon-reload
systemctl reset-failed uptime-sentinel >/dev/null 2>&1 || true

say "Removing $PREFIX"
rm -rf "$PREFIX"

if (( PURGE )); then
  say "Purging database and configuration"
  rm -rf "$DATADIR" "$CONFDIR"
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    say "Removing user $SERVICE_USER"
    userdel "$SERVICE_USER" 2>/dev/null || true
  fi
  say "Done. Nothing left behind."
else
  cat <<EOF

  Service removed. Your data was kept:

    database  $DATADIR
    config    $CONFDIR

  Re-running the installer picks up right where you left off.
  To remove these too:  sudo $0 --purge

EOF
fi
