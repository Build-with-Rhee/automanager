#!/usr/bin/env bash
set -euo pipefail

# Userland-only Debian packages. APT verifies signed indexes and archive hashes;
# packages are extracted into this prefix and never installed into the host.
AUTOMANAGER_UI_PREFIX=${AUTOMANAGER_UI_PREFIX:-/workspace/.cache/automanager-ui}
case "$AUTOMANAGER_UI_PREFIX" in *'"'*|*$'\n'*) printf 'Invalid UI prefix.\n' >&2; exit 1;; esac
APT_ROOT="$AUTOMANAGER_UI_PREFIX/apt"
mkdir -p "$APT_ROOT/state/lists/partial" "$APT_ROOT/cache/archives/partial" "$APT_ROOT/log" "$APT_ROOT/etc/sources.list.d" "$APT_ROOT/etc/apt.conf.d" "$AUTOMANAGER_UI_PREFIX/root"

if [[ ! -x "$AUTOMANAGER_UI_PREFIX/root/usr/bin/Xvfb" || ! -x "$AUTOMANAGER_UI_PREFIX/root/usr/bin/openbox" ]]; then
  source /etc/os-release
  [[ "${ID:-}" == debian && "${VERSION_CODENAME:-}" =~ ^[a-z]+$ ]] || { printf 'This helper requires Debian with its archive keyring.\n' >&2; exit 1; }
  [[ -r /usr/share/keyrings/debian-archive-keyring.pgp ]] || { printf 'Debian archive keyring is unavailable.\n' >&2; exit 1; }
  cat > "$APT_ROOT/etc/sources.list" <<SOURCES
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.pgp] https://deb.debian.org/debian $VERSION_CODENAME main
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.pgp] https://deb.debian.org/debian-security $VERSION_CODENAME-security main
SOURCES
  cat > "$APT_ROOT/apt.conf" <<CONFIG
Dir::Etc::main "$APT_ROOT/etc/apt.conf";
Dir::Etc::parts "$APT_ROOT/etc/apt.conf.d";
Dir::Etc::sourcelist "$APT_ROOT/etc/sources.list";
Dir::Etc::sourceparts "$APT_ROOT/etc/sources.list.d";
Dir::State "$APT_ROOT/state";
Dir::State::status "/var/lib/dpkg/status";
Dir::Cache "$APT_ROOT/cache";
Dir::Log "$APT_ROOT/log";
APT::Sandbox::User "$(id -un)";
Acquire::Languages "none";
Acquire::Retries "2";
CONFIG
  APT_CONFIG="$APT_ROOT/apt.conf" /usr/bin/apt-get update
  # Real "install --download-only" still acquires the host dpkg frontend lock.
  # Simulation reads installed-package state without locking or modifying it.
  APT_CONFIG="$APT_ROOT/apt.conf" /usr/bin/apt-get --simulate --no-install-recommends install xvfb openbox > "$APT_ROOT/plan.txt"
  if rg -q '^Remv ' "$APT_ROOT/plan.txt"; then printf 'Userland setup cannot apply host removals.\n' >&2; exit 1; fi
  mapfile -t packages < <(sed -nE 's/^Inst ([^ ]+).*\(([^ ]+).*/\1=\2/p' "$APT_ROOT/plan.txt")
  # An installed host Xvfb still needs to be copied into our retained prefix.
  if [[ ${#packages[@]} == 0 ]]; then packages=(xvfb openbox); fi
  ( cd "$APT_ROOT/cache/archives"; APT_CONFIG="$APT_ROOT/apt.conf" /usr/bin/apt-get download "${packages[@]}" )
  for archive in "$APT_ROOT/cache/archives/"*.deb; do
    [[ -f "$archive" ]] || continue
    # Preserve the binary of an already running X server.
    if [[ "$(dpkg-deb -f "$archive" Package)" == xvfb && -x "$AUTOMANAGER_UI_PREFIX/root/usr/bin/Xvfb" ]]; then continue; fi
    dpkg-deb --extract "$archive" "$AUTOMANAGER_UI_PREFIX/root"
  done
fi

[[ -x "$AUTOMANAGER_UI_PREFIX/root/usr/bin/Xvfb" ]] || { printf 'Xvfb extraction did not complete.\n' >&2; exit 1; }
printf 'Xvfb: %s\n' "$AUTOMANAGER_UI_PREFIX/root/usr/bin/Xvfb"

if [[ "${1:-}" == --start ]]; then
  mkdir -p /tmp/.X11-unix
  if ! DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
    # The server is local-only; TCP listeners are disabled. No privileged host paths.
    nohup env LD_LIBRARY_PATH="$AUTOMANAGER_UI_PREFIX/root/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH):${LD_LIBRARY_PATH:-}" \
      "$AUTOMANAGER_UI_PREFIX/root/usr/bin/Xvfb" :99 -screen 0 1440x1000x24 -nolisten tcp -ac \
      > "$AUTOMANAGER_UI_PREFIX/xvfb.log" 2>&1 < /dev/null &
    printf '%s\n' "$!" > "$AUTOMANAGER_UI_PREFIX/xvfb.pid"
  fi
  for attempt in {1..30}; do
    if DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
      if ! DISPLAY=:99 xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | rg -q '0x[1-9a-f]'; then
        mkdir -p "$AUTOMANAGER_UI_PREFIX/runtime/config" "$AUTOMANAGER_UI_PREFIX/runtime/cache"
        nohup env DISPLAY=:99 \
          LD_LIBRARY_PATH="$AUTOMANAGER_UI_PREFIX/root/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH):${LD_LIBRARY_PATH:-}" \
          XDG_CONFIG_HOME="$AUTOMANAGER_UI_PREFIX/runtime/config" XDG_CACHE_HOME="$AUTOMANAGER_UI_PREFIX/runtime/cache" \
          XDG_DATA_DIRS="$AUTOMANAGER_UI_PREFIX/root/usr/share:/usr/local/share:/usr/share" \
          "$AUTOMANAGER_UI_PREFIX/root/usr/bin/openbox" --config-file "$AUTOMANAGER_UI_PREFIX/root/etc/xdg/openbox/rc.xml" \
          > "$AUTOMANAGER_UI_PREFIX/openbox.log" 2>&1 < /dev/null &
        printf '%s\n' "$!" > "$AUTOMANAGER_UI_PREFIX/openbox.pid"
      fi
      for wm_attempt in {1..30}; do
        if DISPLAY=:99 xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | rg -q '0x[1-9a-f]'; then printf 'Virtual display and window manager ready: DISPLAY=:99\n'; exit 0; fi
        sleep 0.2
      done
      printf 'Openbox failed its window-manager readiness check.\n' >&2
      tail -n 30 "$AUTOMANAGER_UI_PREFIX/openbox.log" >&2
      exit 1
    fi
    sleep 0.2
  done
  printf 'Xvfb failed its display readiness check.\n' >&2
  tail -n 30 "$AUTOMANAGER_UI_PREFIX/xvfb.log" >&2
  exit 1
fi
