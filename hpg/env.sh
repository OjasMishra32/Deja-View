# shellcheck shell=bash
# Sourced by every ThirdWheel script on HiPerGator: paths, caches, pinned revisions, module helpers.
# Everything heavy lives under $HPG_ROOT on /blue (home is small); nothing here starts work.

export HPG_ROOT="${HPG_ROOT:-/blue/phz3152/sbernalorta/thirdwheel}"
# Local overrides that survive repo syncs (e.g. HPG_PARTITION=hpg-b200, FLASHWORLD_TRAJECTORY=pan180,
# TW_WORKER_IDLE=1800, CUDA_MODULE=cuda/12.8.1). Plain KEY=value lines.
if [[ -f "$HPG_ROOT/config.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HPG_ROOT/config.env"
  set +a
fi
export HPG_ACCOUNT="${HPG_ACCOUNT:-phz3152}"
export HPG_QOS="${HPG_QOS:-$HPG_ACCOUNT}"
export HPG_PARTITION="${HPG_PARTITION:-hpg-rtx6000}"
# Partition for CPU-only setup steps (empty = the cluster default).
export HPG_CPU_PARTITION="${HPG_CPU_PARTITION:-}"

export TW_REPO="${TW_REPO:-$HPG_ROOT/repo}"
export TW_ENVS="$HPG_ROOT/envs"
export TW_SRC="$HPG_ROOT/src"
export TW_LOGS="$HPG_ROOT/logs"
export TW_STATE="$HPG_ROOT/state"
export TW_CACHE="$HPG_ROOT/cache"
export TW_JOBS="$HPG_ROOT/jobs"

export HF_HOME="$HPG_ROOT/models"
export TORCH_HOME="$HPG_ROOT/models/torch"
export HF_HUB_DISABLE_TELEMETRY=1
export PIP_CACHE_DIR="$TW_CACHE/pip"
export XDG_CACHE_HOME="$TW_CACHE/xdg"
export TRITON_CACHE_DIR="$TW_CACHE/triton"
export TORCH_EXTENSIONS_DIR="$TW_CACHE/torch_extensions"
export CONDA_PKGS_DIRS="$TW_CACHE/conda-pkgs"
export MPLCONFIGDIR="$TW_CACHE/matplotlib"
export PYTHONNOUSERSITE=1
export TOKENIZERS_PARALLELISM=false

export FLASHWORLD_SRC="$TW_SRC/FlashWorld"
export ANYSPLAT_SRC="$TW_SRC/AnySplat"
export TW_PY_FLASHWORLD="$TW_ENVS/flashworld/bin/python"
export TW_PY_ANYSPLAT="$TW_ENVS/anysplat/bin/python"
export TW_PY_VIDEO="$TW_ENVS/video/bin/python"

# GPUs: L4 (sm_89), B200 (sm_100), RTX PRO 6000 Blackwell (sm_120); PTX for anything newer.
export TW_CUDA_ARCHS="${TW_CUDA_ARCHS:-8.9;10.0;12.0+PTX}"

# Pinned upstream revisions.
export FLASHWORLD_REPO_URL="${FLASHWORLD_REPO_URL:-https://github.com/imlixinyang/FlashWorld.git}"
export FLASHWORLD_REV="424db4487de308a39e5137afbe85e7568a96193f"
export ANYSPLAT_REPO_URL="${ANYSPLAT_REPO_URL:-https://github.com/InternRobotics/AnySplat.git}"
export ANYSPLAT_REV="5f5e208a7dd57d52e43ea0d553a95eab526e8775"
export GSPLAT_SPEC="gsplat @ git+https://github.com/nerfstudio-project/gsplat.git@32f2a54d21c7ecb135320bb02b136b7407ae5712"
export TW_TORCH_SPEC="${TW_TORCH_SPEC:-torch==2.8.0 torchvision==0.23.0}"
export TW_TORCH_INDEX="${TW_TORCH_INDEX:-https://download.pytorch.org/whl/cu128}"
export TW_PYTHON_VERSION="${TW_PYTHON_VERSION:-3.11}"

tw_say() { printf '[tw %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
tw_warn() { printf '[tw %s] WARNING: %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
tw_die() { printf '[tw %s] ERROR: %s\n' "$(date '+%H:%M:%S')" "$*" >&2; exit 1; }

# Lmod's `module` misbehaves under `set -u`; run it with nounset off.
tw_module() {
  local had_u=0 rc=0
  [[ $- == *u* ]] && had_u=1
  set +u
  if ! type module >/dev/null 2>&1; then
    local f
    for f in /etc/profile.d/lmod.sh /etc/profile.d/modules.sh /usr/share/lmod/lmod/init/bash /apps/lmod/lmod/init/bash; do
      # shellcheck disable=SC1090
      [[ -f "$f" ]] && source "$f" && break
    done
  fi
  if type module >/dev/null 2>&1; then
    module "$@" >/dev/null 2>&1 || rc=$?
  else
    rc=127
  fi
  ((had_u)) && set -u
  return "$rc"
}

# Loads the first module that exists from the arguments; sets TW_LOADED to its name.
tw_load_first() {
  TW_LOADED=""
  local m
  for m in "$@"; do
    [[ -n "$m" ]] || continue
    if tw_module load "$m"; then
      TW_LOADED="$m"
      return 0
    fi
  done
  return 1
}

# CUDA toolkit for building extensions (gsplat). CUDA_MODULE overrides the search.
tw_load_cuda() {
  if tw_load_first "${CUDA_MODULE:-}" cuda/12.9.1 cuda/12.9.0 cuda/12.8.1 cuda/12.8.0 cuda/12.8 cuda/13.0.1 cuda/13.0.0 cuda/13.0; then
    tw_say "loaded module $TW_LOADED"
  elif command -v nvcc >/dev/null 2>&1; then
    tw_say "using nvcc already on PATH"
  else
    tw_warn "no CUDA module found (tried cuda/12.8+ and cuda/13); set CUDA_MODULE=cuda/<version> (see: module spider cuda)"
    return 1
  fi
  local nvcc
  nvcc="$(command -v nvcc || true)"
  [[ -n "$nvcc" ]] || { tw_warn "nvcc not found after loading CUDA"; return 1; }
  export CUDA_HOME="${CUDA_HOME:-$(dirname "$(dirname "$nvcc")")}"
  tw_say "nvcc: $("$nvcc" --version | tail -n 1)"
}

# A host compiler CUDA 12.8 accepts (GCC 9-14). Optional: the system compiler may already do.
tw_load_gcc() {
  if tw_load_first "${GCC_MODULE:-}" gcc/12.2.0 gcc/13.2.0 gcc/14.2.0 gcc/11.4.1 gcc/11.4.0; then
    tw_say "loaded module $TW_LOADED"
  fi
}

# Conda from the HiPerGator module (exports TW_CONDA, the conda or mamba executable).
tw_load_conda() {
  export TW_CONDA=""
  if tw_load_first "${CONDA_MODULE:-}" conda mamba miniforge anaconda; then
    tw_say "loaded module $TW_LOADED"
  fi
  local c
  for c in "${CONDA_EXE:-}" "$(command -v mamba 2>/dev/null || true)" "$(command -v conda 2>/dev/null || true)"; do
    if [[ -n "$c" && -x "$c" ]]; then
      TW_CONDA="$c"
      return 0
    fi
  done
  return 1
}

# Puts an environment's bin/ (python, ffmpeg) first on PATH.
tw_use_env() {
  local name="$1"
  [[ -x "$TW_ENVS/$name/bin/python" ]] || return 1
  export PATH="$TW_ENVS/$name/bin:$PATH"
}

# Weights are fetched once; after that, keep jobs off the network (no hangs on compute nodes).
tw_offline_if_ready() {
  if [[ -f "$TW_STATE/weights.ok" && "${TW_ALLOW_DOWNLOADS:-0}" != "1" ]]; then
    export HF_HUB_OFFLINE=1
  fi
}
