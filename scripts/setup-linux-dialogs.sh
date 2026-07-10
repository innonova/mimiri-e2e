#!/usr/bin/env bash
# One-time provisioning for the native-file-dialog tests on headless Linux.
#
# Installs an X server, a window manager, xdotool, and the xdg-desktop-portal
# stack, and forces the gtk portal backend (headless machines have no
# XDG_CURRENT_DESKTOP, so the portal needs an explicit preference).
#
# Also installs the tooling for the requested package format:
#   flatpak  — flatpak + the flathub remote (runtime dependency resolution)
#   appimage — libfuse2 (AppImages mount themselves via FUSE; running the
#              file directly keeps the $APPIMAGE runtime environment authentic)
#
# Usage: bash scripts/setup-linux-dialogs.sh [targz|flatpak|appimage]
set -euo pipefail

FORMAT="${1:-targz}"

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb openbox xdotool x11-utils \
  xdg-desktop-portal xdg-desktop-portal-gtk

case "$FORMAT" in
  targz) ;;
  flatpak)
    sudo apt-get install -y --no-install-recommends flatpak
    flatpak remote-add --user --if-not-exists flathub \
      https://dl.flathub.org/repo/flathub.flatpakrepo
    ;;
  appimage)
    # ubuntu 24.04 renamed libfuse2 to libfuse2t64; try both for portability
    sudo apt-get install -y --no-install-recommends libfuse2t64 ||
      sudo apt-get install -y --no-install-recommends libfuse2
    ;;
  *)
    echo "unknown format: $FORMAT (expected targz, flatpak or appimage)" >&2
    exit 1
    ;;
esac

mkdir -p ~/.config/xdg-desktop-portal
cat > ~/.config/xdg-desktop-portal/portals.conf <<'EOF'
[preferred]
default=gtk
EOF

echo "setup complete ($FORMAT)"
