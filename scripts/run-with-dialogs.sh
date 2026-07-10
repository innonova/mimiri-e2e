#!/usr/bin/env bash
# Runs a command inside a self-contained graphical session suitable for
# real-native-dialog tests on headless Linux:
#
#   Xvfb (X server) + openbox (window manager, needed for focus/XTEST input)
#   + a D-Bus session bus + xdg-desktop-portal + xdg-desktop-portal-gtk
#
# With GTK_USE_PORTAL=1 (set here by default) Electron's GTK file dialogs are
# routed over D-Bus to org.freedesktop.portal.FileChooser and rendered by
# xdg-desktop-portal-gtk in its own process, where xdotool can drive them.
#
# The session bus is normally a private one (dbus-run-session), so nothing
# leaks into the machine's real session. Exception: APP_FORMAT=snap uses the
# REAL user session bus, because a strictly confined snap cannot reach a
# private bus (its socket lives in the host /tmp, which the snap namespace
# hides, and AppArmor only allows the standard /run/user/<uid>/bus), and
# `snap run` itself needs the user systemd on that bus to create its
# tracking scope. The portals are then started on the real bus for the
# duration of the run.
#
# Usage: bash scripts/run-with-dialogs.sh npm test
set -euo pipefail

PORTAL_LIBEXEC=/usr/libexec

# Starts openbox + both portal processes as jobs of this shell and waits
# until the FileChooser portal is fully ready. GTK decides portal-vs-in-
# process once, at the first dialog, and caches it for the process lifetime;
# if the gtk *backend* implementation isn't registered yet, the first dialog
# falls back to an in-process chooser. So gate on both the frontend
# answering AND the gtk backend owning its bus name.
start_session_services() {
  openbox &
  "$PORTAL_LIBEXEC/xdg-desktop-portal-gtk" &
  "$PORTAL_LIBEXEC/xdg-desktop-portal" &

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
}

if [[ "${1:-}" == "--inner" ]]; then
  shift
  # Inside the private session bus (dbus-run-session below).
  trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
  start_session_services
  "$@"
  exit $?
fi

DISPLAY_NUM="${MIMIRI_DISPLAY_NUM:-99}"
Xvfb ":$DISPLAY_NUM" -screen 0 1600x1000x24 -nolisten tcp &
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
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

session_name_owned() {
  gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetNameOwner "$1" >/dev/null 2>&1
}

if [[ "${APP_FORMAT:-}" == "snap" ]]; then
  # Real-session-bus mode (see header). Reuse the portals only if a working
  # pair (frontend AND gtk backend) already owns the bus — i.e. a real
  # desktop session, which we must not kill; its dialogs may then render on
  # the session's display rather than the Xvfb one. A frontend WITHOUT the
  # gtk backend is a headless leftover: D-Bus activation resurrects
  # xdg-desktop-portal via the systemd user manager (whose environment has
  # no DISPLAY, so portal-gtk fails), it survives our EXIT trap because it
  # is not our child, and reusing it leaves every dialog request hanging.
  # Stop it and start our own portals bound to the Xvfb display.
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus}"
  if session_name_owned org.freedesktop.portal.Desktop &&
    session_name_owned org.freedesktop.impl.portal.desktop.gtk; then
    echo "[run-with-dialogs] working portals already on the session bus; reusing them" >&2
    openbox &
  else
    systemctl --user stop xdg-desktop-portal.service xdg-desktop-portal-gtk.service 2>/dev/null || true
    systemctl --user reset-failed xdg-desktop-portal.service xdg-desktop-portal-gtk.service 2>/dev/null || true
    pkill -x xdg-desktop-portal 2>/dev/null || true
    pkill -x xdg-desktop-portal-gtk 2>/dev/null || true
    for _ in $(seq 1 50); do
      session_name_owned org.freedesktop.portal.Desktop || break
      sleep 0.1
    done
    start_session_services
  fi
  "$@"
  exit $?
fi

# Re-exec via bash so this also works without the executable bit set.
dbus-run-session -- bash "$0" --inner "$@"
