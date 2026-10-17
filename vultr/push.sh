#!/usr/bin/env bash
# Copies the code the GPU box needs from this Mac to <host>:/root/dejaview/repo/: pipeline/ and hpg/ (which the
# server also re-syncs before jobs) plus vultr/. Same rsync excludes as the server's repo sync (REPO_EXCLUDES in
# server/hpg.ts) and the same ssh options as its key login, so both share one connection. Installs rsync on the box
# first if the image lacks it.
#
#   vultr/push.sh <host>     e.g. vultr/push.sh 203.0.113.7 (without <host>: $VULTR_HOST)
#
# VULTR_USER (default root), VULTR_ROOT (/root/dejaview), VULTR_SSH_KEY, VULTR_SSH_OPTS and VULTR_SOCKET mean what
# they mean for the server (vultr/README.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
host="${1:-${VULTR_HOST:-}}"
if [[ -z "$host" ]]; then
  sed -n '2,10p' "$0"
  exit 2
fi
user="${VULTR_USER:-root}"
root="${VULTR_ROOT:-/root/dejaview}"
root="${root%/}"
if [[ ! "$root" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo "VULTR_ROOT must be an absolute path of plain characters (got: $root)" >&2
  exit 2
fi
sock="${VULTR_SOCKET:-~/.ssh/cm-vultr-%C}"
sock="${sock/#\~/$HOME}"

ssh_cmd=(ssh -o BatchMode=yes -o ControlMaster=auto -o "ControlPath=$sock" -o ControlPersist=10m
  -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ConnectTimeout=10)
if [[ -n "${VULTR_SSH_KEY:-}" ]]; then
  ssh_cmd+=(-i "${VULTR_SSH_KEY/#\~/$HOME}" -o IdentitiesOnly=yes)
fi
read -r -a extra <<<"${VULTR_SSH_OPTS:-}"
ssh_cmd+=(${extra[@]+"${extra[@]}"})

# rsync splits -e on whitespace: quote the words that contain some (a key path, say).
rsh=""
for w in "${ssh_cmd[@]}"; do
  [[ "$w" =~ [[:space:]] ]] && w="\"$w\""
  rsh+="${rsh:+ }$w"
done

echo "connecting to $user@$host"
# One round trip: the folder, and rsync on the box (the copy below needs it at both ends; setup.sh comes after).
prep="mkdir -p $root/repo && { command -v rsync >/dev/null || { echo 'installing rsync on the box' >&2;"
prep+=" DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -qq update >/dev/null &&"
prep+=" DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -qq install -y rsync >/dev/null; }; }"
rc=0
"${ssh_cmd[@]}" "$user@$host" "$prep" || rc=$?
if ((rc == 255)); then
  echo "could not log in as $user@$host. Check the IP, that this Mac's public key was added when the instance was created" >&2
  echo "(ssh $user@$host should work), and VULTR_SSH_KEY. A reused IP with a new box: ssh-keygen -R $host, then try again." >&2
  exit 1
elif ((rc != 0)); then
  echo "logged in, but could not create $root/repo or install rsync on the box (exit $rc, see above)." >&2
  echo "On the box: mkdir -p $root/repo; apt-get install -y rsync. Then push again." >&2
  exit 1
fi
rsync -a --partial --delete \
  --exclude=__pycache__ --exclude='*.pyc' --exclude=.DS_Store --exclude=.ipynb_checkpoints --exclude=jobs/ \
  -e "$rsh" "$REPO/pipeline" "$REPO/hpg" "$REPO/vultr" "$user@$host:$root/repo/"
echo "pushed pipeline/, hpg/ and vultr/ to $user@$host:$root/repo/"
env_prefix=""
[[ "$root" == /root/dejaview ]] || env_prefix="HPG_ROOT=$root "
echo "next, on the box (the first setup takes about an hour; tmux keeps it going if ssh drops):"
echo "  ssh $user@$host"
echo "  tmux new -s dv"
echo "  ${env_prefix}bash $root/repo/vultr/setup.sh"
