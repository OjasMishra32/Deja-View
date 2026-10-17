#!/bin/bash
# Déjà View avatars: people in a clip -> avatar-<k>.glb (pipeline/avatar/run.py), one GPU job.
#
#   sbatch --export=ALL,VIDEO=...,POSES=...,WORK=...,OUT=...[,WORLD=world.spz,PEOPLE=2,BACKVIEW=auto,FPS=30,START=0,STEPS=all,FORCE=] \
#          $HPG_ROOT/repo/hpg/avatar.sbatch
#
# STEPS / FORCE take colon-separated step names (ground:texture), since --export splits on commas.
#
# VIDEO: the clip; POSES: its <clip>-poses.json from pipeline/recon/frame.py post (camera per frame + intrinsics);
# WORK: a work folder on /blue (frames, masks, caches); OUT: where avatar-<k>.glb and avatar.json go.
# WORLD (optional): the scene's world.spz; furniture in it (the foosball table) hides the legs when texturing.
# The GPU runs the pose network (about a minute for 12 s at 30 fps) and, only when a person's back was never
# filmed, Qwen-Image-Edit-2511 for the generated back; the rest is CPU. Steps are cached in WORK.
#SBATCH --job-name=tw-avatar
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=96G
#SBATCH --time=00:45:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/logs/avatar-%j.log
set -euo pipefail

HPG_ROOT="${HPG_ROOT:-/blue/phz3152/sbernalorta/thirdwheel}"
# shellcheck source=hpg/env.sh
source "$HPG_ROOT/repo/hpg/env.sh"
export ANNY_CACHE_DIR="${ANNY_CACHE_DIR:-$HPG_ROOT/models/anny}"
export MULTIHMR2_CKPT="${MULTIHMR2_CKPT:-$HPG_ROOT/models/multihmr2/multihmr2.pt}"
# pipeline/common snapshot (decode, HDR LUTs, person segmenter, LaMa) when the repo copy lags behind
[[ -d "$HPG_ROOT/avatar/pylib/common" ]] && export AVATAR_PYLIB="$HPG_ROOT/avatar/pylib"
export HF_HUB_OFFLINE=1
export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-16}"
tw_use_env avatar || tw_die "no avatar env (bash hpg/setup-avatar.sh submit)"

: "${VIDEO:?set VIDEO}" "${POSES:?set POSES}" "${WORK:?set WORK}" "${OUT:?set OUT}"
STEPS="${STEPS:-all}"; STEPS="${STEPS//:/,}"
FORCE="${FORCE:-}"; FORCE="${FORCE//:/,}"
cd "$HPG_ROOT/repo"
tw_say "avatar job ${SLURM_JOB_ID:-local} on $(hostname): $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
python -W ignore -m pipeline.avatar.run --work "$WORK" --video "$VIDEO" --poses "$POSES" --out-dir "$OUT" \
  --people "${PEOPLE:-2}" --backview "${BACKVIEW:-auto}" --fps "${FPS:-30}" --start "${START:-0}" \
  --clip "${CLIP:-play}" --steps "$STEPS" --force "$FORCE" ${WORLD:+--world "$WORLD"}
tw_say "done: $(ls "$OUT")"
