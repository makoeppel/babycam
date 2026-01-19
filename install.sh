#!/usr/bin/env bash
set -euo pipefail

# -----------------------------
# Config (edit if you want)
# -----------------------------
APP_USER="pi"
APP_GROUP="pi"
APP_NAME="babycam"
APP_DIR="/home/${APP_USER}/${APP_NAME}"
VENV_DIR="${APP_DIR}/venv"
SERVICE_NAME="babycam.service"

# Where the app listens (Caddy will proxy here)
APP_HOST="127.0.0.1"
APP_PORT="8080"

# Caddy site config
# If you want HTTPS with a real cert, set SITE to your domain (e.g. babycam.example.com)
# For LAN-only with internal TLS, you can set: SITE="https://olecam.local"
SITE="${SITE:-olecam.local}"  # can override: SITE=babycam.example.com ./install.sh

# Basic auth user/pass (prompted if not set)
AUTH_USER="${AUTH_USER:-admin}"
AUTH_PASS="${AUTH_PASS:-}"

# Optional: v4l2loopback setup (only if you really use /dev/video10)
ENABLE_V4L2LOOPBACK="${ENABLE_V4L2LOOPBACK:-0}"  # set to 1 to enable

# -----------------------------
# Helpers
# -----------------------------
need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run as root: sudo $0"
    exit 1
  fi
}

echo_step() {
  echo
  echo "==> $*"
}

prompt_password() {
  if [[ -z "${AUTH_PASS}" ]]; then
    read -r -s -p "Set Basic Auth password for ${AUTH_USER}: " AUTH_PASS
    echo
    if [[ -z "${AUTH_PASS}" ]]; then
      echo "Password cannot be empty."
      exit 1
    fi
  fi
}

# -----------------------------
# Start
# -----------------------------
need_root

echo_step "Installing apt packages"
apt-get update
apt-get install -y \
  python3 python3-venv python3-pip \
  ffmpeg \
  caddy \
  alsa-utils \
  v4l-utils

# picamera2 is usually installed via apt on Raspberry Pi OS
# If it's missing, install it:
apt-get install -y python3-picamera2 || true

if [[ "${ENABLE_V4L2LOOPBACK}" == "1" ]]; then
  echo_step "Installing v4l2loopback (optional)"
  apt-get install -y v4l2loopback-dkms v4l2loopback-utils
fi

echo_step "Creating application directory at ${APP_DIR}"
mkdir -p "${APP_DIR}"
mkdir -p "${APP_DIR}/static"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"

echo_step "Copying project files into ${APP_DIR}"
# Copy from the directory where install.sh is located
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Required files
for f in stream.py index.html; do
  if [[ ! -f "${SRC_DIR}/${f}" ]]; then
    echo "Missing ${f} in ${SRC_DIR}. Put install.sh in the same folder as stream.py/index.html."
    exit 1
  fi
done

cp -f "${SRC_DIR}/stream.py" "${APP_DIR}/stream.py"
cp -f "${SRC_DIR}/index.html" "${APP_DIR}/index.html"

# Static folder
if [[ -d "${SRC_DIR}/static" ]]; then
  cp -rf "${SRC_DIR}/static/." "${APP_DIR}/static/"
else
  echo "Missing static/ directory in ${SRC_DIR} (expected static/app.js and static/styles.css)."
  exit 1
fi

chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"

echo_step "Creating Python venv and installing Python dependencies"
if [[ ! -d "${VENV_DIR}" ]]; then
  sudo -u "${APP_USER}" python3 -m venv "${VENV_DIR}"
fi

# Upgrade pip + install deps
sudo -u "${APP_USER}" "${VENV_DIR}/bin/pip" install -U pip wheel setuptools

# Install python deps (prefer wheels; Pi may compile some parts)
# aiortc pulls in av; on Pi OS, python3-av may already exist. This is okay.
sudo -u "${APP_USER}" "${VENV_DIR}/bin/pip" install -U \
  aiohttp aiortc av numpy

echo_step "Writing systemd service ${SERVICE_NAME}"
cat > "/etc/systemd/system/${SERVICE_NAME}" <<EOF
[Unit]
Description=Babycam WebRTC Service
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=PYTHONUNBUFFERED=1

# If you depend on v4l2loopback (/dev/video10), uncomment these:
# ExecStartPre=/usr/sbin/modprobe v4l2loopback devices=1 video_nr=10 card_label=libcamera exclusive_caps=1
# ExecStartPre=/bin/sh -c 'for i in \$(seq 1 20); do [ -e /dev/video10 ] && exit 0; sleep 0.5; done; echo "/dev/video10 not found" >&2; exit 1'
# ExecStartPre=/usr/bin/v4l2-ctl --device /dev/video10 --all

ExecStart=${VENV_DIR}/bin/python ${APP_DIR}/stream.py
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo_step "Checking babycam service status"
systemctl --no-pager --full status "${SERVICE_NAME}" || true

# Optional: set up v4l2loopback to load on boot
if [[ "${ENABLE_V4L2LOOPBACK}" == "1" ]]; then
  echo_step "Configuring v4l2loopback to load on boot (optional)"
  cat > /etc/modules-load.d/v4l2loopback.conf <<EOF
v4l2loopback
EOF
  cat > /etc/modprobe.d/v4l2loopback.conf <<EOF
options v4l2loopback devices=1 video_nr=10 card_label=libcamera exclusive_caps=1
EOF
fi

echo_step "Configuring Caddy reverse proxy + Basic Auth"
prompt_password

# Hash password for Caddy basicauth
AUTH_HASH="$(caddy hash-password --plaintext "${AUTH_PASS}")"

# Create a dedicated Caddyfile for this app
CADDYFILE_PATH="/etc/caddy/Caddyfile"
cp -f "${CADDYFILE_PATH}" "${CADDYFILE_PATH}.bak.$(date +%s)" || true

# If you use a real domain, Caddy will get a public cert automatically.
# For LAN-only (olecam.local), Caddy may need internal TLS:
# We'll enable internal TLS automatically when SITE ends with .local
TLS_LINE=""
if [[ "${SITE}" == *.local ]]; then
  TLS_LINE="tls internal"
fi

cat > "${CADDYFILE_PATH}" <<EOF
${SITE} {
  ${TLS_LINE}

  basicauth {
    ${AUTH_USER} ${AUTH_HASH}
  }

  reverse_proxy ${APP_HOST}:${APP_PORT}
}
EOF

systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

echo_step "Done!"
echo "Babycam service: http://${APP_HOST}:${APP_PORT} (local)"
echo "Via Caddy:        https://${SITE}/  (will prompt for Basic Auth)"
echo
echo "Logs:"
echo "  journalctl -u ${SERVICE_NAME} -f"
echo "  journalctl -u caddy -f"
