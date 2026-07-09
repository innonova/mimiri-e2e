#!/usr/bin/env bash
# Runs a command inside a self-contained graphical session suitable for
# real-native-dialog tests on headless Linux:
#
#   Xvfb (X server) + openbox (window manager, needed for focus/XTEST input)
#   + a private D-Bus session bus + xdg-desktop-portal + xdg-desktop-portal-gtk
#
# With GTK_USE_PORTAL=1 (set here by default) Electron's GTK file dialogs are
# routed over D-Bus to org.freedesktop.portal.FileChooser and rendered by
# xdg-desktop-portal-gtk in its own process, where xdotool can drive them.
#
# Usage: bash scripts/run-with-dialogs.sh npm test
set -euo pipefail

PORTAL_LIBEXEC=/usr/libexec

if [[ "${1:-}" == "--inner" ]]; then
  shift
  # Inside the private session bus (dbus-run-session below).
  openbox &
  "$PORTAL_LIBEXEC/xdg-desktop-portal-gtk" &
  "$PORTAL_LIBEXEC/xdg-desktop-portal" &
  trap 'kill $(jobs -p) 2>/dev/null || true' EXIT

  # Wait until the FileChooser portal is fully ready. GTK decides
  # portal-vs-in-process once, at the first dialog, and caches it for the
  # process lifetime; if the gtk *backend* implementation isn't registered
  # yet, the first dialog falls back to an in-process chooser. So gate on
  # both the frontend answering AND the gtk backend owning its bus name.
  for _ in $(seq 1 150); do
    frontend_ok=0
    backend_ok=0
    gdbus call --session --dest org.freedesktop.portal.Desktop \
      --object-path /org/freedesktop/portal/desktop \
      --method org.freedesktop.DBus.Properties.Get \
      org.freedesktop.portal.FileChooser version >/dev/null 2>&1 && frontend_ok=1
    gdbus call --session --dest org.freedesktop.DBus \
      --object-path /org/freedesktop/DBus \
      --method org.freedesktop.DBus.GetNameOwner \
      org.freedesktop.impl.portal.desktop.gtk >/dev/null 2>&1 && backend_ok=1
    if [ "$frontend_ok" = 1 ] && [ "$backend_ok" = 1 ]; then
      break
    fi
    sleep 0.1
  done

  "$@"
  exit $?
fi

DISPLAY_NUM="${MIMIRI_DISPLAY_NUM:-99}"
Xvfb ":$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  [[ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]] && break
  sleep 0.1
done

export DISPLAY=":$DISPLAY_NUM"
unset WAYLAND_DISPLAY
# Leaks in from VSCode/Electron parent processes and makes the app under
# test run as plain Node, which rejects Chromium flags with "bad option".
unset ELECTRON_RUN_AS_NODE
export GTK_USE_PORTAL="${GTK_USE_PORTAL:-1}"

# Re-exec via bash so this also works without the executable bit set.
dbus-run-session -- bash "$0" --inner "$@"
