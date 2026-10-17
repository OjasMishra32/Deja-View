#!/usr/bin/env bash
# Déjà View avatar stage on HiPerGator: the $TW_ENVS/avatar environment, its weights, and a GPU smoke test.
#
#   bash $HPG_ROOT/repo/hpg/setup-avatar.sh submit   # from a login node: two CPU burst jobs, printed job ids
#                                                    #   A: env build, then prefetch dinov3 + anny + verify
#                                                    #   B: multihmr2.pt, then the Qwen-Image-Edit-2511 snapshot
#   bash $HPG_ROOT/repo/hpg/setup-avatar.sh smoke [VIDEO] [T1,T2]   # one short GPU srun (needs A and the ckpt)
#
# Stages (run inside a job with `--inside <stage>`): env, prefetch, weights, qwen, smoke.
# CPU-only work uses the burst QOS (phz3152-b: CPUs only, no GPUs). Logs: $TW_LOGS/avatar-<stage>-<job>.log.
# Licences of what this installs and fetches are listed in pipeline/requirements-avatar.txt.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpg/env.sh
source "$HERE/env.sh"
REPO="$(cd "$HERE/.." && pwd)"

export AVATAR_ENV="$TW_ENVS/avatar"
export AVATAR_PY="$AVATAR_ENV/bin/python"
export ANNY_CACHE_DIR="${ANNY_CACHE_DIR:-$HPG_ROOT/models/anny}"
export MULTIHMR2_CKPT="${MULTIHMR2_CKPT:-$HPG_ROOT/models/multihmr2/multihmr2.pt}"
AVATAR_PYTHON_VERSION="3.11"
AVATAR_TORCH_SPEC="torch==2.8.0 torchvision==0.23.0"
AVATAR_TORCH_INDEX="https://download.pytorch.org/whl/cu128"
REQS="$REPO/pipeline/requirements-avatar.txt"

BURST_ARGS=(--account="$HPG_ACCOUNT" --qos="${HPG_BURST_QOS:-${HPG_ACCOUNT}-b}")
GPU_ARGS=(--account="$HPG_ACCOUNT" --qos="$HPG_QOS" --partition="${AVATAR_GPU_PARTITION:-hpg-rtx6000}" --gpus=1)

mkdir -p "$TW_LOGS" "$TW_STATE" "$TW_CACHE/tmp" "$ANNY_CACHE_DIR" "$(dirname "$MULTIHMR2_CKPT")"

# ------------------------------------------------------------------------------------------------- stages

stage_env() {
  export TMPDIR="${SLURM_TMPDIR:-$TW_CACHE/tmp}"
  local fp stamp="$TW_STATE/avatar-env.ok"
  fp="$( { echo "$AVATAR_TORCH_SPEC|$AVATAR_TORCH_INDEX|$AVATAR_PYTHON_VERSION"; cat "$REQS"; } | sha256sum | cut -c1-16)"
  if [[ "${FORCE:-0}" != "1" && -f "$stamp" && "$(cat "$stamp")" == "$fp" && -x "$AVATAR_PY" ]]; then
    tw_say "avatar env is up to date ($AVATAR_ENV)"
    return
  fi
  if [[ -x "$AVATAR_PY" ]] && "$AVATAR_PY" -c "import sys; sys.exit(0 if '%d.%d' % sys.version_info[:2] == '$AVATAR_PYTHON_VERSION' else 1)"; then
    tw_say "reusing $AVATAR_ENV ($("$AVATAR_PY" --version))"
  else
    rm -rf "$AVATAR_ENV"
    tw_load_conda || tw_die "no conda module (module load conda)"
    tw_say "creating $AVATAR_ENV: python $AVATAR_PYTHON_VERSION, pip, ffmpeg from conda-forge"
    "$TW_CONDA" create -y -q -p "$AVATAR_ENV" -c conda-forge --override-channels \
      "python=$AVATAR_PYTHON_VERSION" pip ffmpeg
  fi
  local pip=("$AVATAR_PY" -m pip)
  "${pip[@]}" install --quiet --upgrade pip setuptools wheel packaging
  tw_say "torch ($AVATAR_TORCH_SPEC from $AVATAR_TORCH_INDEX)"
  # shellcheck disable=SC2086
  "${pip[@]}" install --quiet $AVATAR_TORCH_SPEC --index-url "$AVATAR_TORCH_INDEX"
  local cons="$TW_STATE/avatar-torch-constraints.txt"
  # shellcheck disable=SC2086
  printf '%s\n' $AVATAR_TORCH_SPEC >"$cons"
  tw_say "requirements-avatar.txt"
  "${pip[@]}" install --quiet -c "$cons" -r "$REQS"
  "$AVATAR_PY" - <<'EOF'
import importlib, sys
mods = ["torch", "torchvision", "multihmr2", "anny", "warp", "roma", "open3d", "trimesh", "pygltflib", "scipy",
        "cv2", "diffusers", "transformers", "accelerate", "huggingface_hub", "PIL", "numpy"]
bad = []
for m in mods:
    try:
        mod = importlib.import_module(m)
        print(f"  {m:16s} {getattr(mod, '__version__', '?')}")
    except Exception as e:  # report every failure, then fail
        bad.append(m)
        print(f"  {m:16s} IMPORT FAILED: {type(e).__name__}: {e}")
import torch
print("  torch cuda build", torch.version.cuda, "arch list", torch.cuda.get_arch_list() if torch.cuda.is_available() else "(no GPU here)")
try:
    from diffusers import QwenImageEditPlusPipeline  # noqa: F401
    print("  QwenImageEditPlusPipeline available")
except Exception as e:
    bad.append("QwenImageEditPlusPipeline")
    print("  QwenImageEditPlusPipeline MISSING:", e)
sys.exit(1 if bad else 0)
EOF
  if "$AVATAR_PY" -m pip freeze | grep -iE '^(smplx|chumpy)' ; then
    tw_die "an SMPL-family package was pulled in; remove it"
  fi
  "$AVATAR_PY" -m pip freeze >"$TW_STATE/avatar-freeze.txt"
  [[ -x "$AVATAR_ENV/bin/ffmpeg" ]] || tw_warn "no ffmpeg in $AVATAR_ENV"
  du -sh "$AVATAR_ENV"
  echo "$fp" >"$stamp"
}

# Backbone code, Anny caches, and a CPU load of the checkpoint (needs the env; the ckpt step may still be running).
stage_prefetch() {
  [[ -x "$AVATAR_PY" ]] || tw_die "build the env first"
  cd "$TW_REPO"
  "$AVATAR_PY" -m pipeline.avatar.prefetch dinov3 anny
  local i
  for i in $(seq 1 60); do
    [[ -f "$MULTIHMR2_CKPT" ]] && break
    tw_say "waiting for $MULTIHMR2_CKPT (job B) ..."
    sleep 20
  done
  "$AVATAR_PY" -m pipeline.avatar.prefetch verify
  du -sh "$ANNY_CACHE_DIR" "$TORCH_HOME/hub"/facebookresearch_dinov3_* 2>/dev/null || true
}

# Only needs huggingface_hub and the standard library: runs with the avatar env when present, else the video env.
weights_python() {
  if [[ -x "$AVATAR_PY" ]] && "$AVATAR_PY" -c "import huggingface_hub" 2>/dev/null; then
    echo "$AVATAR_PY"
  else
    echo "$TW_PY_VIDEO"
  fi
}

stage_weights() {
  cd "$TW_REPO"
  "$(weights_python)" -m pipeline.avatar.prefetch ckpt
}

stage_qwen() {
  cd "$TW_REPO"
  export HF_HUB_ENABLE_HF_TRANSFER=0
  "$(weights_python)" -m pipeline.avatar.prefetch qwen
}

stage_smoke() {
  [[ -x "$AVATAR_PY" ]] || tw_die "build the env first"
  cd "$TW_REPO"
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
  local out="$HPG_ROOT/avatar/smoke/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$out"
  PATH="$AVATAR_ENV/bin:$PATH" "$AVATAR_PY" -m pipeline.avatar.smoke \
    --video "${SMOKE_VIDEO:?}" --times "${SMOKE_TIMES:-2.0,8.0}" --out "$out"
  tw_say "smoke outputs: $out"
}

# ------------------------------------------------------------------------------------------------- main

run_inside() {
  local st="$1"
  tw_say "avatar stage $st on $(hostname) (job ${SLURM_JOB_ID:-none})"
  "stage_$st"
  tw_say "avatar stage $st done"
}

case "${1:-}" in
  --inside)
    run_inside "${2:?stage}"
    ;;
  submit)
    jb=$(sbatch --parsable "${BURST_ARGS[@]}" --job-name=tw-avatar-weights --cpus-per-task=8 --mem=16gb \
      --time=08:00:00 --output="$TW_LOGS/avatar-weights-%j.log" \
      --wrap="bash '$HERE/setup-avatar.sh' --inside weights && bash '$HERE/setup-avatar.sh' --inside qwen")
    ja=$(sbatch --parsable "${BURST_ARGS[@]}" --job-name=tw-avatar-env --cpus-per-task=16 --mem=48gb \
      --time=02:00:00 --output="$TW_LOGS/avatar-env-%j.log" \
      --wrap="bash '$HERE/setup-avatar.sh' --inside env && bash '$HERE/setup-avatar.sh' --inside prefetch")
    echo "env+prefetch job: $ja   (log $TW_LOGS/avatar-env-$ja.log)"
    echo "ckpt+qwen job:    $jb   (log $TW_LOGS/avatar-weights-$jb.log)"
    ;;
  smoke)
    export SMOKE_VIDEO="${2:-${SMOKE_VIDEO:-}}" SMOKE_TIMES="${3:-${SMOKE_TIMES:-2.0,8.0}}"
    [[ -n "$SMOKE_VIDEO" ]] || tw_die "usage: setup-avatar.sh smoke VIDEO [T1,T2]"
    srun "${GPU_ARGS[@]}" --job-name=tw-avatar-smoke --cpus-per-task=8 --mem=48gb --time=00:20:00 \
      bash "$HERE/setup-avatar.sh" --inside smoke
    ;;
  env | prefetch | weights | qwen)
    if [[ -n "${SLURM_JOB_ID:-}" ]]; then
      run_inside "$1"
    else
      srun "${BURST_ARGS[@]}" --job-name="tw-avatar-$1" --cpus-per-task=16 --mem=48gb --time=02:00:00 \
        bash "$HERE/setup-avatar.sh" --inside "$1"
    fi
    ;;
  *)
    sed -n '2,12p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
