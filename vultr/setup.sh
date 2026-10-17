#!/usr/bin/env bash
# Déjà View on a rented GPU box (Vultr Cloud GPU, NVIDIA A40 48 GB, Ubuntu 22.04 or 24.04): idempotent setup.
# Run it on the box as root, after vultr/push.sh copied the code to $HPG_ROOT/repo (default /root/dejaview/repo):
#
#   bash /root/dejaview/repo/vultr/setup.sh                 # every stage, in order (about an hour; use tmux)
#   bash /root/dejaview/repo/vultr/setup.sh envs weights    # chosen stages: system dirs src envs weights smoke
#   FORCE=1 bash /root/dejaview/repo/vultr/setup.sh envs    # rebuild the environments even if they look current
#
# `system` is the part only this box needs: it checks the GPU, the driver and the disk, installs ffmpeg, build tools
# and rsync, the CUDA toolkit that matches the torch wheels (nvcc, to build gsplat) and Miniforge (conda, which
# HiPerGator gets from a module), and writes $HPG_ROOT/config.env. Every other stage is hpg/setup.sh's own, run here
# directly instead of through srun, so environments, pinned revisions and weights are exactly HiPerGator's. The one
# difference is TORCH_CUDA_ARCH_LIST: 8.6, the A40's compute capability (config.env, TW_CUDA_ARCHS).
#
# The NVIDIA driver is never touched. Vultr's GPU images ship a vGPU driver that has to match their host (the card
# shows up as "NVIDIA A40-48Q", often with a CUDA 12.4 driver); the CUDA 12.8 wheels run on any CUDA 12 driver
# through CUDA's minor version compatibility, because torch and gsplat carry ready-made kernels for 8.6.
#
# Each stage logs to $HPG_ROOT/logs/setup-<stage>-<time>.log and the first failure stops the run with what to do.
# Re-running is safe: every step checks what is already there. A plain re-run skips a smoke test that passed before.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
export HPG_ROOT="${HPG_ROOT:-/root/dejaview}"
# shellcheck source=hpg/env.sh
source "$REPO/hpg/env.sh"
ALL_STAGES=(system dirs src envs weights smoke)
CONF="$HPG_ROOT/config.env"
CONDA_PREFIX_DIR="$HPG_ROOT/miniforge3"
# The CUDA toolkit for building gsplat matches the torch wheels: .../whl/cu128 -> 12.8.
TORCH_CU="${TW_TORCH_INDEX##*/cu}"
[[ "$TORCH_CU" =~ ^[0-9]{3}$ ]] || tw_die "TW_TORCH_INDEX ($TW_TORCH_INDEX) does not end in /cuNNN, so the CUDA toolkit version is unknown"
CUDA_WANT="${TORCH_CU:0:2}.${TORCH_CU:2}"
CUDA_DIR="/usr/local/cuda-$CUDA_WANT"
MIN_FREE_GB=130  # models about 71 GB, three environments about 30 GB, the CUDA toolkit, caches

# sort -V: is $2 at least $1?
version_ge() { printf '%s\n%s\n' "$1" "$2" | sort -V -C; }

apt_get() { apt-get -o DPkg::Lock::Timeout=600 -q "$@"; }

# Variables config.env sets for later runs (CUDA_HOME, CONDA_EXE, MAX_JOBS) and nvcc on PATH.
load_box_env() {
  if [[ -f "$CONF" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$CONF"
    set +a
  fi
  if [[ -n "${CUDA_HOME:-}" && -d "$CUDA_HOME/bin" ]]; then
    export PATH="$CUDA_HOME/bin:$PATH"
  fi
}

# ------------------------------------------------------------------------------------------------- system

check_box() {
  [[ "$(id -u)" -eq 0 ]] || tw_die "run as root (Vultr logs you in as root; otherwise: sudo -i)"
  [[ "$(uname -m)" == x86_64 ]] || tw_die "this script knows x86_64 boxes only (got $(uname -m))"
  local os
  # shellcheck disable=SC1091
  os="$(. /etc/os-release && echo "${ID:-?} ${VERSION_ID:-?}")"
  case "$os" in
    "ubuntu 22.04" | "ubuntu 24.04") tw_say "OS: $os" ;;
    *) tw_warn "tested on Ubuntu 22.04 and 24.04, this is $os: carrying on" ;;
  esac
  [[ -d "$REPO/pipeline" && -d "$REPO/hpg" ]] || tw_die "pipeline/ or hpg/ is missing next to $HERE: on the Mac run vultr/push.sh <ip> first"
  mkdir -p "$HPG_ROOT"
  local free
  free="$(df -Pk "$HPG_ROOT" | awk 'NR == 2 { print int($4 / 1048576) }')"
  ((free >= MIN_FREE_GB)) || tw_die "only $free GB free under $HPG_ROOT; setup needs about $MIN_FREE_GB GB (pick a plan with a bigger disk)"
  tw_say "disk: $free GB free under $HPG_ROOT"
}

check_gpu() {
  command -v nvidia-smi >/dev/null 2>&1 \
    || tw_die "nvidia-smi not found, so there is no NVIDIA driver. Deploy a Cloud GPU instance (its images include the driver) and run this again"
  local q name mem driver cuda
  q="$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>&1)" \
    || tw_die "nvidia-smi failed: $q (after a driver upgrade the box needs a reboot)"
  IFS=',' read -r name mem driver <<<"$(head -n 1 <<<"$q")"
  name="$(xargs <<<"$name")"
  mem="$(xargs <<<"$mem")"
  driver="$(xargs <<<"$driver")"
  cuda="$(nvidia-smi | sed -n 's/.*CUDA Version: *\([0-9][0-9.]*\).*/\1/p' | head -n 1)"
  GPU_CAP="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n 1 | xargs || true)"
  if [[ ! "$GPU_CAP" =~ ^[0-9]+\.[0-9]+$ ]]; then
    [[ "$name" == *A40* ]] || tw_die "could not read the GPU's compute capability; put TW_CUDA_ARCHS=\"<major.minor>\" in $CONF and run again"
    GPU_CAP=8.6
  fi
  tw_say "GPU: $name, $mem MiB, compute capability $GPU_CAP, driver $driver (CUDA $cuda)"
  # Minor version compatibility: wheels built for CUDA 12.x run on any CUDA 12 driver (525 or newer) when they carry
  # kernels for the GPU, as torch's and gsplat's do for 8.6. Only a CUDA 11 driver is a real stop.
  if ! version_ge "${CUDA_WANT%%.*}.0" "${cuda:-0}"; then
    if [[ "${ALLOW_OLD_DRIVER:-0}" == "1" ]]; then
      tw_warn "driver CUDA $cuda is older than CUDA ${CUDA_WANT%%.*}; carrying on (ALLOW_OLD_DRIVER=1)"
    else
      tw_die "the driver supports CUDA ${cuda:-?}, the torch wheels need a CUDA ${CUDA_WANT%%.*} driver (525 or newer). Do not install another driver over Vultr's vGPU one: update it with Vultr's /opt/nvidia/update.sh, or redeploy from a current Vultr GPU image. ALLOW_OLD_DRIVER=1 tries anyway"
    fi
  elif ! version_ge "$CUDA_WANT" "$cuda"; then
    tw_say "driver CUDA $cuda is older than the wheels' CUDA $CUDA_WANT: fine through CUDA's minor version compatibility (leave the driver as it is; the smoke stage proves it)"
  fi
  [[ "$name" == *A40* ]] || tw_warn "this is not an A40: gsplat is built for this GPU's compute capability $GPU_CAP instead"
  if [[ "$mem" =~ ^[0-9]+$ ]] && ((mem < 40000)); then
    tw_warn "$mem MiB of GPU memory: FlashWorld needs about 30 GB even with T5 offload"
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
  local pkgs=(build-essential git curl ca-certificates rsync ffmpeg tmux python3) missing=() p
  for p in "${pkgs[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'install ok installed' || missing+=("$p")
  done
  tw_say "apt-get update"
  apt_get update >/dev/null || tw_die "apt-get update failed (the output is above; a broken list in /etc/apt/sources.list.d/ is the usual cause)"
  if ((${#missing[@]})); then
    tw_say "installing ${missing[*]}"
    apt_get install -y --no-install-recommends "${missing[@]}" || tw_die "apt-get install ${missing[*]} failed (see above)"
  else
    tw_say "system packages already installed"
  fi
  tw_say "$(ffmpeg -hide_banner -version | head -n 1)"
}

install_cuda() {
  if [[ -x "$CUDA_DIR/bin/nvcc" ]]; then
    tw_say "CUDA toolkit $CUDA_WANT already at $CUDA_DIR"
  else
    local pkg="cuda-toolkit-${CUDA_WANT/./-}"
    if ! apt-cache show "$pkg" >/dev/null 2>&1; then
      local repo tmp
      # shellcheck disable=SC1091
      repo="ubuntu$(. /etc/os-release && echo "${VERSION_ID//./}")"
      tmp="$(mktemp -d)"
      tw_say "adding NVIDIA's CUDA apt repository ($repo)"
      curl -fsSL -o "$tmp/cuda-keyring.deb" "https://developer.download.nvidia.com/compute/cuda/repos/$repo/x86_64/cuda-keyring_1.1-1_all.deb" \
        || tw_die "could not download NVIDIA's repository key for $repo (no CUDA repository for this OS?)"
      dpkg -i "$tmp/cuda-keyring.deb" >/dev/null || tw_die "could not install NVIDIA's repository key (see above)"
      rm -rf "$tmp"
      apt_get update >/dev/null || tw_die "apt-get update failed after adding the CUDA repository (see above)"
    fi
    tw_say "installing $pkg (nvcc, headers and libraries to build gsplat; it leaves the driver alone; a few GB)"
    apt_get install -y --no-install-recommends "$pkg" || tw_die "apt-get install $pkg failed (see above)"
  fi
  [[ -x "$CUDA_DIR/bin/nvcc" ]] || tw_die "nvcc is not at $CUDA_DIR/bin/nvcc after installing the CUDA toolkit"
  export CUDA_HOME="$CUDA_DIR" PATH="$CUDA_DIR/bin:$PATH"
  tw_say "nvcc: $(nvcc --version | tail -n 1)"
}

install_conda() {
  local conda="$CONDA_PREFIX_DIR/bin/conda"
  if [[ -x "$conda" ]]; then
    tw_say "conda already at $CONDA_PREFIX_DIR ($("$conda" --version))"
    return
  fi
  local tmp url
  tmp="$(mktemp -d)"
  url="https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-$(uname -m).sh"
  tw_say "installing Miniforge into $CONDA_PREFIX_DIR"
  curl -fsSL -o "$tmp/miniforge.sh" "$url" || tw_die "could not download $url"
  rm -rf "$CONDA_PREFIX_DIR"  # a half-finished earlier install
  bash "$tmp/miniforge.sh" -b -p "$CONDA_PREFIX_DIR" >/dev/null || tw_die "the Miniforge installer failed (see above)"
  rm -rf "$tmp"
  tw_say "$("$conda" --version)"
}

# Adds KEY="value" to config.env unless the file already sets KEY (your own edits win).
set_conf() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$CONF" 2>/dev/null; then
    tw_say "config.env keeps $(grep "^$key=" "$CONF" | tail -n 1)"
  else
    printf '%s="%s"\n' "$key" "$value" >>"$CONF"
    tw_say "config.env: $key=\"$value\""
  fi
}

write_config() {
  if [[ ! -f "$CONF" ]]; then
    cat >"$CONF" <<'EOF'
# Déjà View on this GPU box: KEY=value overrides read by hpg/env.sh, the same file HiPerGator keeps at $HPG_ROOT.
# Written by vultr/setup.sh, which only ever adds keys that are missing, so your own lines stay.
# Optional:
#   TW_WORKER_IDLE=1200            seconds without work before the worker exits (the box bills either way)
#   FLASHWORLD_TRAJECTORY=spin360  the camera path FlashWorld renders (docs/HPG.md, after the smoke test)
EOF
  fi
  local cpus mem_gb njobs
  cpus="$(nproc)"
  mem_gb="$(awk '/^MemTotal:/ { print int($2 / 1048576) }' /proc/meminfo)"
  # A gsplat compile job takes up to about 4 GB of memory.
  njobs=$((mem_gb / 4 < cpus ? mem_gb / 4 : cpus))
  ((njobs >= 1)) || njobs=1
  set_conf TW_CUDA_ARCHS "$GPU_CAP"
  set_conf CUDA_HOME "$CUDA_DIR"
  set_conf CONDA_EXE "$CONDA_PREFIX_DIR/bin/conda"
  set_conf MAX_JOBS "$njobs"
}

stage_system() {
  check_box
  check_gpu
  install_packages
  install_cuda
  install_conda
  write_config
}

run_system() {
  local log rc
  mkdir -p "$TW_LOGS" "$TW_STATE"
  log="$TW_LOGS/setup-system-$(date +%Y%m%d-%H%M%S).log"
  tw_say "stage system on $(hostname) (log: $log)"
  # Not inside an `if`: errexit must stay active in the stage's subshell.
  set +e
  (
    set -e
    stage_system
  ) 2>&1 | tee -a "$log"
  rc=${PIPESTATUS[0]}
  set -e
  ((rc == 0)) || tw_die "stage system failed (exit $rc); see $log (fix and re-run: bash $HERE/setup.sh system)"
  date '+%F %T' >"$TW_STATE/system.ok"
  tw_say "stage system done"
}

# ------------------------------------------------------------------------------------------------- hpg stages

# One of hpg/setup.sh's stages, run on this box directly (its --inside entry is what srun calls on HiPerGator).
hpg_stage() {
  local st="$1"
  if [[ ! -f "$TW_STATE/system.ok" ]]; then
    tw_die "run the system stage first: bash $HERE/setup.sh system"
  fi
  case "$st" in
    envs)
      command -v nvcc >/dev/null 2>&1 || tw_die "nvcc is not on PATH; run: bash $HERE/setup.sh system"
      tw_say "building for TORCH_CUDA_ARCH_LIST=$TW_CUDA_ARCHS with MAX_JOBS=${MAX_JOBS:-8}"
      ;;
    smoke)
      # The smoke test loads FlashWorld itself; next to a running worker it would not fit in 48 GB.
      if [[ -n "$(find "$TW_JOBS/worker.json" -mmin -2 2>/dev/null)" ]]; then
        tw_die "the worker is running; stop it first (bash $HERE/worker.sh stop), then run the smoke test"
      fi
      ;;
  esac
  # On failure hpg/setup.sh names its log and its own re-run command, which needs srun: the line after it is the one
  # for this box.
  bash "$REPO/hpg/setup.sh" --inside "$st" \
    || tw_die "stage $st failed (its log is named above). On this box, fix it and re-run with: bash $HERE/setup.sh $st (not hpg/setup.sh, which needs Slurm)"
}

# ------------------------------------------------------------------------------------------------- main

[[ "$(uname -s)" == Linux ]] || tw_die "run this on the GPU box, not here (from the Mac: vultr/push.sh <ip>, then ssh in)"
stages=("$@")
explicit=1
if [[ ${#stages[@]} -eq 0 ]]; then
  stages=("${ALL_STAGES[@]}")
  explicit=0
fi
for st in "${stages[@]}"; do
  case "$st" in
    system | dirs | src | envs | weights | smoke) ;;
    *) tw_die "unknown stage '$st' (stages: ${ALL_STAGES[*]})" ;;
  esac
done
load_box_env
for st in "${stages[@]}"; do
  case "$st" in
    system)
      run_system
      load_box_env
      ;;
    smoke)
      # The smoke test holds the GPU for 10-15 minutes: in a plain re-run, only once.
      if ((explicit == 0)) && [[ -f "$TW_STATE/smoke.ok" && "${FORCE:-0}" != "1" ]]; then
        tw_say "smoke test passed before ($(cat "$TW_STATE/smoke.ok")); run 'vultr/setup.sh smoke' to repeat it"
        continue
      fi
      hpg_stage smoke
      ;;
    *) hpg_stage "$st" ;;
  esac
done
tw_say "setup finished: ${stages[*]}"
if ((explicit == 0)); then
  tw_say "next: bash $HERE/worker.sh start 8   (then: bash $HERE/worker.sh status)"
fi
