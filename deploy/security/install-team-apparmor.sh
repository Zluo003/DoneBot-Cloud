#!/usr/bin/env bash
set -euo pipefail

# Installs and loads the minimal-privilege AppArmor profile for DoneBot Cloud team containers.
# Derived directly from moby/profiles docker-default: preserves /proc, /sys, obsolete network
# family, signal and ptrace isolation while lifting only mount/pivot_root (and userns/unix on
# AppArmor 4+) required by unprivileged bubblewrap (bot-box) inside CAP_DROP=ALL containers.
# Compatible with Debian 12 (AppArmor 3.0.x) and Ubuntu 24.04+ (AppArmor 4.x).

PROFILE_NAME="donebot-team-container"
PROFILE_PATH="/etc/apparmor.d/${PROFILE_NAME}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

if [[ -f /proc/sys/user/max_user_namespaces ]]; then
  max_userns=$(cat /proc/sys/user/max_user_namespaces)
  if [[ "$max_userns" -le 0 ]]; then
    echo "error: kernel user.max_user_namespaces=${max_userns}; enable unprivileged user namespaces first" >&2
    exit 1
  fi
fi

if [[ -f /proc/sys/kernel/unprivileged_userns_clone ]]; then
  clone_userns=$(cat /proc/sys/kernel/unprivileged_userns_clone)
  if [[ "$clone_userns" != "1" ]]; then
    echo "error: kernel.unprivileged_userns_clone=${clone_userns}; set kernel.unprivileged_userns_clone=1 before enabling teams" >&2
    exit 1
  fi
fi

if [[ ! -f /sys/module/apparmor/parameters/enabled ]] || [[ "$(cat /sys/module/apparmor/parameters/enabled)" != "Y" ]]; then
  echo "AppArmor is not active on this host; only team-seccomp.json is required."
  exit 0
fi

if ! command -v apparmor_parser >/dev/null 2>&1; then
  echo "error: apparmor_parser not found; install it with: apt-get update && apt-get install -y apparmor" >&2
  exit 1
fi

aa_major=$(apparmor_parser --version 2>/dev/null | sed -n 's/.*version \([0-9][0-9]*\)\..*/\1/p' | head -n 1 || true)
aa_major="${aa_major:-3}"

TMP_PROFILE=$(mktemp)
trap 'rm -f "$TMP_PROFILE"' EXIT

{
  echo "# DoneBot Cloud minimal-privilege AppArmor profile for team containers."
  if [[ "$aa_major" -ge 4 ]] && [[ -f /etc/apparmor.d/abi/4.0 ]]; then
    echo "abi <abi/4.0>,"
  elif [[ -f /etc/apparmor.d/abi/3.0 ]]; then
    echo "abi <abi/3.0>,"
  fi

  if [[ -f /etc/apparmor.d/tunables/global ]]; then
    echo "#include <tunables/global>"
  else
    echo "@{PROC}=/proc/"
  fi

  echo ""
  echo "profile \"${PROFILE_NAME}\" flags=(attach_disconnected,mediate_deleted) {"
  if [[ -f /etc/apparmor.d/abstractions/base ]]; then
    echo "  #include <abstractions/base>"
    echo ""
  fi

  cat <<'RULES'
  network,
  # Disallow obsolete socket families, AF_ALG and AF_VSOCK (matching docker-default).
  deny network ax25,
  deny network ipx,
  deny network appletalk,
  deny network netrom,
  deny network rose,
  deny network econet,
  deny network atmsvc,
  deny network irda,
  deny network wanpipe,
  deny network isdn,
  deny network caif,
  deny network alg,
  deny network vsock,
  capability,
  file,
  umount,
  # Required for unprivileged bubblewrap (bot-box) inside team containers.
  mount,
  pivot_root,
RULES

  if [[ "$aa_major" -ge 4 ]] && [[ -f /etc/apparmor.d/abi/4.0 ]]; then
    # AppArmor 4.0 separates unix socket mediation from network, and restricts unprivileged userns.
    echo "  unix,"
    echo "  userns,"
  fi

  cat <<EOF

  # Preserve docker-default /proc and /sys write protections.
  # PID directories (/proc/[1-9]*/**) remain writable by file, so bubblewrap can write uid_map/gid_map/setgroups.
  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,

  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  # Preserve docker-default signal and ptrace boundaries.
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer="${PROFILE_NAME}",
  signal (send,receive) peer="${PROFILE_NAME}//&unconfined",
  ptrace (trace,tracedby,read,readby) peer="${PROFILE_NAME}",
  ptrace (trace,tracedby,read,readby) peer="${PROFILE_NAME}//&unconfined",
}
EOF
} >"$TMP_PROFILE"

install -m 0644 -o root -g root "$TMP_PROFILE" "$PROFILE_PATH"
apparmor_parser -r -W "$PROFILE_PATH"

if ! grep -qx "${PROFILE_NAME} (enforce)" /sys/kernel/security/apparmor/profiles; then
  echo "error: profile ${PROFILE_NAME} did not load in enforce mode" >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files apparmor.service >/dev/null 2>&1; then
  if ! systemctl is-enabled apparmor.service >/dev/null 2>&1; then
    echo "warning: apparmor.service is not enabled; run 'sudo systemctl enable apparmor' so ${PROFILE_NAME} reloads after reboot" >&2
  fi
fi

echo "Loaded AppArmor profile: ${PROFILE_NAME} (enforce, parser major=${aa_major}, path=${PROFILE_PATH})"
