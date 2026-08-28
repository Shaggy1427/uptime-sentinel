#!/usr/bin/env bash
#
# Install uptime-sentinel as a systemd service.
#
# Safe to re-run: upgrading is just `git pull && sudo ./scripts/install.sh`.
# Your configuration and database are never overwritten.
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/uptime-sentinel}"
DATADIR="${DATADIR:-/var/lib/uptime-sentinel}"
CONFDIR="${CONFDIR:-/etc/uptime-sentinel}"
SERVICE_USER="${SERVICE_USER:-uptime-sentinel}"
UNIT="/etc/systemd/system/uptime-sentinel.service"
MIN_NODE_MAJOR=24

START_SERVICE=1
[[ "${1:-}" == "--no-start" ]] && START_SERVICE=0

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

[[ $EUID -eq 0 ]] || die "Run as root: sudo $0"
command -v systemctl >/dev/null || die "systemd not found. Use the manual setup in the README instead."

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "node not found on PATH. Install Node ${MIN_NODE_MAJOR}+ first."
NODE_BIN="$(readlink -f "$NODE_BIN")"

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < MIN_NODE_MAJOR )); then
  die "Node ${MIN_NODE_MAJOR}+ required, found $("$NODE_BIN" -v).
     Debian/Raspberry Pi OS ship Node 18. Install a current one:
       curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
       sudo apt-get install -y nodejs"
fi
say "Using $NODE_BIN ($("$NODE_BIN" -v))"

# ProtectHome=yes hides /home from the service. If node lives there (nvm, mise,
# fnm, asdf) the unit could not exec it, so relax that one setting to read-only.
PROTECT_HOME=yes
case "$NODE_BIN" in
  /home/*|/root/*)
    PROTECT_HOME=read-only
    warn "node lives under a home directory."
    warn "Setting ProtectHome=read-only so the service can still exec it."
    warn "A system-wide Node (nodesource, or your distro's) is more robust for a service."
    ;;
esac

# ------------------------------------------------------------------ account

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating system user $SERVICE_USER"
  useradd --system --no-create-home --home-dir "$DATADIR" --shell /usr/sbin/nologin "$SERVICE_USER" \
    2>/dev/null || useradd --system --no-create-home --home-dir "$DATADIR" --shell /sbin/nologin "$SERVICE_USER"
else
  say "System user $SERVICE_USER already exists"
fi

# -------------------------------------------------------------------- files

say "Installing application to $PREFIX"
install -d -m 755 "$PREFIX"

# Stage a build in a temp dir, then swap it in, so a failed build never leaves
# a half-installed service behind.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for item in package.json package-lock.json tsconfig.json src public; do
  cp -r "$SRC/$item" "$STAGE/"
done

say "Installing dependencies and building (this takes a minute on a Pi)"
( cd "$STAGE" && npm ci --no-audit --no-fund >/dev/null )
( cd "$STAGE" && npm run build >/dev/null )
( cd "$STAGE" && npm prune --omit=dev --no-audit --no-fund >/dev/null )

rm -rf "$PREFIX/dist" "$PREFIX/node_modules" "$PREFIX/public"
cp -r "$STAGE/dist" "$STAGE/node_modules" "$STAGE/public" "$STAGE/package.json" "$PREFIX/"
chown -R root:root "$PREFIX"
chmod -R go-w "$PREFIX"

# --------------------------------------------------------------------- data

say "Preparing $DATADIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATADIR"

# ------------------------------------------------------------------- config

install -d -m 755 "$CONFDIR"
ENV_FILE="$CONFDIR/uptime-sentinel.env"

if [[ -f "$ENV_FILE" ]]; then
  say "Keeping existing config at $ENV_FILE"
else
  say "Creating $ENV_FILE"
  sed -e "s|^DATA_DIR=.*|DATA_DIR=$DATADIR|" \
      -e "s|^NTFY_TOPIC=.*|NTFY_TOPIC=|" \
      "$SRC/.env.example" > "$ENV_FILE"
  NEW_CONFIG=1
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ------------------------------------------------------------------ service

say "Installing systemd unit"
sed -e "s|__PREFIX__|$PREFIX|g" \
    -e "s|__DATADIR__|$DATADIR|g" \
    -e "s|__CONFDIR__|$CONFDIR|g" \
    -e "s|__USER__|$SERVICE_USER|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__PROTECT_HOME__|$PROTECT_HOME|g" \
    "$SRC/packaging/uptime-sentinel.service" > "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload

if [[ "${NEW_CONFIG:-0}" == "1" ]]; then
  cat <<EOF

  Installed, but not started yet.

  1. Set your ntfy topic (and anything else you want):
       sudoedit $ENV_FILE

  2. Start it:
       sudo systemctl enable --now uptime-sentinel

  3. Watch it come up:
       journalctl -u uptime-sentinel -f

EOF
  exit 0
fi

if (( START_SERVICE )); then
  systemctl enable uptime-sentinel >/dev/null 2>&1 || true
  if systemctl is-active --quiet uptime-sentinel; then
    say "Restarting service"
    systemctl restart uptime-sentinel
  else
    say "Starting service"
    systemctl start uptime-sentinel
  fi
  sleep 2
  if systemctl is-active --quiet uptime-sentinel; then
    PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)"
    say "Running at http://$(hostname -f 2>/dev/null || hostname):${PORT:-8080}"
  else
    warn "Service is not running. Recent log:"
    journalctl -u uptime-sentinel -n 20 --no-pager >&2 || true
    exit 1
  fi
else
  say "Installed. Start with: sudo systemctl enable --now uptime-sentinel"
fi
