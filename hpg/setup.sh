#!/usr/bin/env bash
# ThirdWheel on HiPerGator: idempotent setup. Run it from a login node:
#
#   bash $HPG_ROOT/repo/hpg/setup.sh                 # every stage, in order
#   bash $HPG_ROOT/repo/hpg/setup.sh envs weights    # chosen stages: dirs src envs weights smoke
#   FORCE=1 bash $HPG_ROOT/repo/hpg/setup.sh smoke   # redo a stage that is already stamped done
#
# dirs and src are light (mkdir, git clone) and run where you are. envs and weights run through
# `srun --account=$HPG_ACCOUNT --qos=$HPG_QOS` on a CPU node (SETUP_ON_GPU=1 runs them on the GPU partition
# instead, if CPU jobs are not allowed), and smoke runs on one GPU. Nothing heavy runs on the login node.
#
# Each stage logs to $HPG_ROOT/logs/setup-<stage>-<time>.log and leaves $HPG_ROOT/state/<stage>.ok holding a
# fingerprint of its inputs (requirements files, pinned revisions). Re-running skips finished stages and redoes a
# stage whose inputs changed, so it is safe to run again after a failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpg/env.sh
source "$HERE/env.sh"
REPO="$(cd "$HERE/.." && pwd)"
ALL_STAGES=(dirs src envs weights smoke)

fingerprint() {
  local st="$1"
  {
    echo "$st"
    case "$st" in
      dirs) echo "$HPG_ROOT" ;;
      src) echo "$FLASHWORLD_REV $ANYSPLAT_REV" ;;
      envs)
        echo "$TW_TORCH_SPEC|$GSPLAT_SPEC|$TW_CUDA_ARCHS|$TW_PYTHON_VERSION"
        cat "$REPO/pipeline/requirements-flashworld.txt" "$REPO/pipeline/requirements-anysplat.txt"
        cat "$REPO/pipeline/requirements-video-gpu.txt" 2>/dev/null || echo "no video requirements"
        ;;
      weights)
        # Re-run the stage when the weight list changes or when the video env appears (its prefetch adds weights).
        cat "$HERE/fetch_weights.py"
        cat "$REPO/pipeline/common/models.py" 2>/dev/null || echo "no models.py"
        [[ -x "$TW_PY_VIDEO" ]] && echo "video env present" || echo "no video env"
        ;;
      smoke) date +%s ;;  # always re-runs when asked
    esac
  } | sha256sum | cut -c1-16
}

is_done() {
  local st="$1"
  [[ "${FORCE:-0}" != "1" && -f "$TW_STATE/$st.ok" && "$(cat "$TW_STATE/$st.ok")" == "$(fingerprint "$st")" ]]
}

mark_done() { mkdir -p "$TW_STATE"; fingerprint "$1" >"$TW_STATE/$1.ok"; }

run_logged() {
  local st="$1" log rc
  mkdir -p "$TW_LOGS" "$TW_STATE"
  log="$TW_LOGS/setup-$st-$(date +%Y%m%d-%H%M%S).log"
  tw_say "stage $st on $(hostname) (log: $log)"
  # Not inside an `if`: errexit must stay active in the stage's subshell.
  set +e
  (
    set -e
    "stage_$st"
  ) 2>&1 | tee -a "$log"
  rc=${PIPESTATUS[0]}
  set -e
  if ((rc != 0)); then
    tw_die "stage $st failed (exit $rc); see $log (fix and re-run: bash $HERE/setup.sh $st)"
  fi
  if [[ "$st" == "smoke" ]]; then
    date '+%F %T' >"$TW_STATE/smoke.ok"
  else
    mark_done "$st"
  fi
  tw_say "stage $st done"
}

on_compute() {
  local kind="$1" st="$2"
  if [[ -n "${SLURM_JOB_ID:-}" ]]; then
    run_logged "$st"
    return
  fi
  command -v srun >/dev/null 2>&1 || tw_die "srun not found; run this on HiPerGator"
  local args=(--account="$HPG_ACCOUNT" --qos="$HPG_QOS" --job-name="tw-setup-$st" --ntasks=1 --cpus-per-task="${SETUP_CPUS:-8}")
  if [[ "$kind" == "gpu" || "${SETUP_ON_GPU:-0}" == "1" ]]; then
    args+=(--partition="$HPG_PARTITION" --gpus=1 --mem="${SETUP_MEM:-80gb}" --time="${SETUP_TIME:-01:00:00}")
  else
    [[ -n "$HPG_CPU_PARTITION" ]] && args+=(--partition="$HPG_CPU_PARTITION")
    args+=(--mem="${SETUP_MEM:-32gb}" --time="${SETUP_TIME:-03:00:00}")
  fi
  tw_say "srun ${args[*]} bash setup.sh --inside $st"
  srun "${args[@]}" bash "$HERE/setup.sh" --inside "$st"
  [[ -f "$TW_STATE/$st.ok" ]] || tw_die "stage $st did not complete"
}

# ------------------------------------------------------------------------------------------------- stages

stage_dirs() {
  mkdir -p "$HPG_ROOT"/{repo,envs,models/torch,src,logs,state,smoke} \
    "$TW_CACHE"/{pip,xdg,triton,torch_extensions,conda-pkgs,matplotlib,tmp} \
    "$TW_JOBS"/{incoming,queue,running,done,batch,fw-requests}
  for d in pipeline hpg; do
    [[ -d "$TW_REPO/$d" ]] || tw_warn "$TW_REPO/$d is missing: sync the repo from the Mac first (docs/HPG.md, step 2)"
  done
  df -h "$HPG_ROOT" | tail -n 1
  tw_say "layout ready under $HPG_ROOT"
}

clone_at() {
  local url="$1" dir="$2" rev="$3"
  if [[ -d "$dir/.git" ]] && [[ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" == "$rev" ]]; then
    tw_say "$(basename "$dir") already at ${rev:0:10}"
    return
  fi
  if [[ ! -d "$dir/.git" ]]; then
    rm -rf "$dir"
    git clone --quiet "$url" "$dir"
  else
    git -C "$dir" fetch --quiet origin || true
  fi
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$rev" || {
    git -C "$dir" fetch --quiet --depth 1 origin "$rev"
    git -C "$dir" -c advice.detachedHead=false checkout --quiet "$rev"
  }
  tw_say "$(basename "$dir") at $(git -C "$dir" rev-parse --short HEAD)"
}

stage_src() {
  mkdir -p "$TW_SRC"
  clone_at "$FLASHWORLD_REPO_URL" "$FLASHWORLD_SRC" "$FLASHWORLD_REV"
  clone_at "$ANYSPLAT_REPO_URL" "$ANYSPLAT_SRC" "$ANYSPLAT_REV"
}

make_env() {
  local name="$1" prefix="$TW_ENVS/$1" py="$TW_ENVS/$1/bin/python"
  if [[ -x "$py" ]] && "$py" -c "import sys; sys.exit(0 if '%d.%d' % sys.version_info[:2] == '$TW_PYTHON_VERSION' else 1)"; then
    tw_say "env $name exists ($("$py" --version))"
    return
  fi
  rm -rf "$prefix"
  if [[ -n "${TW_CONDA:-}" ]]; then
    tw_say "creating conda env $name (python $TW_PYTHON_VERSION)"
    "$TW_CONDA" create -y -q -p "$prefix" -c conda-forge --override-channels "python=$TW_PYTHON_VERSION" pip
  else
    local sys_py
    tw_load_first "python/$TW_PYTHON_VERSION" python3 python || true
    sys_py="$(command -v "python$TW_PYTHON_VERSION" || command -v python3)"
    tw_say "creating venv $name with $sys_py"
    "$sys_py" -m venv "$prefix"
  fi
}

pip_in() {
  local name="$1"
  shift
  "$TW_ENVS/$name/bin/python" -m pip "$@"
}

gsplat_commit_ok() {
  "$TW_ENVS/$1/bin/python" - "$GSPLAT_SPEC" <<'EOF'
import json, sys
from importlib import metadata
want = sys.argv[1].rsplit("@", 1)[-1]
try:
    d = metadata.distribution("gsplat")
    info = json.loads(d.read_text("direct_url.json") or "{}")
    ok = info.get("vcs_info", {}).get("commit_id") == want
except Exception:
    ok = False
sys.exit(0 if ok else 1)
EOF
}

build_env() {
  local name="$1" reqs="$2" with_gsplat="${3:-}"
  local stamp="$TW_STATE/env-$name.ok" fp
  fp="$( { echo "$TW_TORCH_SPEC|$GSPLAT_SPEC|$TW_CUDA_ARCHS|$TW_PYTHON_VERSION|$with_gsplat"; cat "$reqs"; } | sha256sum | cut -c1-16)"
  if [[ "${FORCE:-0}" != "1" && -f "$stamp" && "$(cat "$stamp")" == "$fp" && -x "$TW_ENVS/$name/bin/python" ]]; then
    tw_say "env $name is up to date"
    return
  fi
  make_env "$name"
  pip_in "$name" install --quiet --upgrade pip setuptools wheel ninja packaging
  tw_say "[$name] torch ($TW_TORCH_SPEC, $TW_TORCH_INDEX)"
  # shellcheck disable=SC2086
  pip_in "$name" install --quiet $TW_TORCH_SPEC --index-url "$TW_TORCH_INDEX"
  tw_say "[$name] $(basename "$reqs")"
  pip_in "$name" install --quiet -c "$CONSTRAINTS" -r "$reqs"
  if [[ "$with_gsplat" == "gsplat" ]]; then
    if gsplat_commit_ok "$name"; then
      tw_say "[$name] gsplat already built at the pinned commit"
    else
      tw_say "[$name] building gsplat for TORCH_CUDA_ARCH_LIST=$TW_CUDA_ARCHS (several minutes)"
      TORCH_CUDA_ARCH_LIST="$TW_CUDA_ARCHS" MAX_JOBS="${MAX_JOBS:-${SLURM_CPUS_PER_TASK:-8}}" \
        pip_in "$name" install --no-build-isolation --no-cache-dir -c "$CONSTRAINTS" "$GSPLAT_SPEC"
    fi
  fi
  if [[ -n "${TW_CONDA:-}" && ! -x "$TW_ENVS/$name/bin/ffprobe" ]]; then
    tw_say "[$name] ffmpeg from conda-forge"
    "$TW_CONDA" install -y -q -p "$TW_ENVS/$name" -c conda-forge --override-channels ffmpeg || tw_warn "ffmpeg install failed in $name"
  fi
  "$TW_ENVS/$name/bin/python" "$HERE/smoke/check_env.py" "$name"
  echo "$fp" >"$stamp"
}

stage_envs() {
  mkdir -p "$TW_ENVS" "$TW_CACHE/tmp" "$TW_STATE"
  export TMPDIR="${SLURM_TMPDIR:-$TW_CACHE/tmp}"
  tw_load_conda || tw_warn "no conda module; using python -m venv (ffmpeg must then come from a module)"
  tw_load_gcc || true
  tw_load_cuda || tw_die "a CUDA 12.8+ toolkit is needed to build gsplat for Blackwell"
  export TORCH_CUDA_ARCH_LIST="$TW_CUDA_ARCHS"
  CONSTRAINTS="$TW_STATE/torch-constraints.txt"
  # shellcheck disable=SC2086
  printf '%s\n' $TW_TORCH_SPEC >"$CONSTRAINTS"
  export CONSTRAINTS

  build_env flashworld "$REPO/pipeline/requirements-flashworld.txt" gsplat
  pip_in flashworld uninstall -y -q spaces >/dev/null 2>&1 || true

  build_env anysplat "$REPO/pipeline/requirements-anysplat.txt" gsplat
  # Optional speed-ups for AnySplat; anysplat_run.py falls back to PyTorch when they are missing.
  pip_in anysplat install --quiet -c "$CONSTRAINTS" torch_scatter -f "https://data.pyg.org/whl/torch-2.8.0+cu128.html" \
    || tw_warn "torch_scatter wheel unavailable; AnySplat will use the PyTorch scatter fallback"
  pip_in anysplat install --quiet -c "$CONSTRAINTS" xformers --index-url "$TW_TORCH_INDEX" \
    || tw_warn "xformers unavailable; AnySplat will use PyTorch SDPA"

  if [[ -f "$REPO/pipeline/requirements-video-gpu.txt" ]]; then
    build_env video "$REPO/pipeline/requirements-video-gpu.txt"
  else
    tw_warn "pipeline/requirements-video-gpu.txt not synced yet; the video env is skipped (re-run envs later)"
  fi
  du -sh "$TW_ENVS"/* 2>/dev/null || true
}

stage_weights() {
  tw_use_env flashworld || tw_die "run the envs stage first"
  # shellcheck disable=SC2086  # WEIGHTS is a space-separated list of groups
  "$TW_PY_FLASHWORLD" "$HERE/fetch_weights.py" ${WEIGHTS:-flashworld wan captioner anysplat video}
  if [[ -x "$TW_PY_VIDEO" && -f "$REPO/pipeline/common/models.py" ]]; then
    tw_say "video pipeline weights (pipeline/common/models.py --prefetch)"
    # A failed prefetch fails the stage: weights.ok switches jobs to HF_HUB_OFFLINE=1, and without these weights
    # every video job would fail to load its depth model.
    (cd "$REPO/pipeline" && "$TW_PY_VIDEO" common/models.py --prefetch) || tw_die "video weight prefetch failed"
  else
    tw_warn "no video env yet: the depth weights came from fetch_weights.py; re-run setup.sh after envs to prefetch the rest"
  fi
  du -sh "$HF_HOME" 2>/dev/null || true
}

stage_smoke() {
  tw_use_env flashworld || tw_die "run the envs stage first"
  tw_offline_if_ready
  local out
  out="$HPG_ROOT/smoke/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$out"
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
  "$TW_PY_FLASHWORLD" "$HERE/smoke/smoke_gpu.py" --out "$out/gpu"
  "$TW_PY_FLASHWORLD" "$HERE/smoke/smoke_flashworld.py" --out "$out/flashworld"
  if [[ -x "$TW_PY_ANYSPLAT" ]]; then
    PATH="$TW_ENVS/anysplat/bin:$PATH" "$TW_PY_ANYSPLAT" "$HERE/smoke/smoke_anysplat.py" --out "$out/anysplat"
  fi
  tw_say "smoke outputs: $out (look at flashworld/*/sheet.jpg and summary.json)"
}

# ------------------------------------------------------------------------------------------------- main

if [[ "${1:-}" == "--inside" ]]; then
  run_logged "${2:?stage}"
  exit 0
fi

stages=("$@")
explicit=1
if [[ ${#stages[@]} -eq 0 ]]; then
  stages=("${ALL_STAGES[@]}")
  explicit=0
fi
for st in "${stages[@]}"; do
  case "$st" in
    dirs | src | envs | weights | smoke) ;;
    *) tw_die "unknown stage '$st' (stages: ${ALL_STAGES[*]})" ;;
  esac
done
for st in "${stages[@]}"; do
  if [[ "$st" == "smoke" ]]; then
    # The smoke test holds a GPU for a few minutes: in a plain re-run, only once.
    if ((explicit == 0)) && [[ -f "$TW_STATE/smoke.ok" && "${FORCE:-0}" != "1" ]]; then
      tw_say "smoke test passed before ($(cat "$TW_STATE/smoke.ok")); run 'setup.sh smoke' to repeat it"
      continue
    fi
  elif is_done "$st"; then
    tw_say "stage $st already done (FORCE=1 to redo)"
    continue
  fi
  case "$st" in
    dirs | src) run_logged "$st" ;;
    envs | weights) on_compute cpu "$st" ;;
    smoke) on_compute gpu "$st" ;;
  esac
done
tw_say "setup finished: ${stages[*]}"
