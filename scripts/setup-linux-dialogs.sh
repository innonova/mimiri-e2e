#!/usr/bin/env bash
# One-time provisioning for the native-file-dialog tests on headless Linux.
#
# Installs an X server, a window manager, xdotool, and the xdg-desktop-portal
# stack, and forces the gtk portal backend (headless machines have no
# XDG_CURRENT_DESKTOP, so the portal needs an explicit preference).
#
# Usage: bash scripts/setup-linux-dialogs.sh
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb openbox xdotool x11-utils \
  xdg-desktop-portal xdg-desktop-portal-gtk

mkdir -p ~/.config/xdg-desktop-portal
cat > ~/.config/xdg-desktop-portal/portals.conf <<'EOF'
[preferred]
default=gtk
EOF

echo "setup complete"
