#!/bin/bash
# Déjà View avatars, the CPU steps (pipeline/avatar/run.py ground ... fill) between the two GPU jobs of
# hpg/avatar.sbatch (STEPS=hmr before, STEPS=photofit:glb after); same variables, burst QOS, no GPU.
#
#   sbatch --export=ALL,VIDEO=...,POSES=...,WORK=...,OUT=...[,WORLD=world.spz,STEPS=ground:refine:body:offsets:texture:fill,ARGS=] \
#          $HPG_ROOT/repo/hpg/avatar-cpu.sbatch
#
# STEPS / FORCE take colon-separated step names (ground:texture), since --export splits on commas. ARGS: more run.py
# flags (--refine legs, --photofit off, --holdout FILE, ...). SNAP: run from a synced snapshot instead of the repo.
# The group's GPUs are shared, so a long clip runs in three jobs that each stay under 30 minutes:
#   hpg/avatar.sbatch with STEPS=hmr; this script (ground ... fill); hpg/avatar.sbatch with STEPS=photofit:glb.
#
# VIDEO: the clip; POSES: its <clip>-poses.json from pipeline/recon/frame.py post (camera per frame + intrinsics);
# WORK: a work folder on /blue (frames, masks, caches); OUT: where avatar-<k>.glb and avatar.json go.
# WORLD (optional): the scene's world.spz; furniture in it (the foosball table) hides the legs when texturing.
# The GPU runs the pose network (about a minute for 12 s at 30 fps), the photofit (about 15 minutes for two people
# and 12 s) and, only when a person's back was never filmed, Qwen-Image-Edit-2511 for the generated back; the rest is
# CPU (about 15 minutes for two people and 12 s). Steps are cached in WORK.
#SBATCH --job-name=tw-avatar-cpu
#SBATCH --account=phz3152
#SBATCH --qos=phz3152-b
#SBATCH --partition=hpg-dev,hpg-default,hpg-milan,hpg-turin
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=00:50:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/logs/avatar-cpu-%j.log
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
STEPS="${STEPS:-ground:refine:body:offsets:texture:fill}"; STEPS="${STEPS//:/,}"
FORCE="${FORCE:-}"; FORCE="${FORCE//:/,}"
cd "${SNAP:-$HPG_ROOT/repo}"
tw_say "avatar CPU job ${SLURM_JOB_ID:-local} on $(hostname): $STEPS"
python -W ignore -m pipeline.avatar.run --work "$WORK" --video "$VIDEO" --poses "$POSES" --out-dir "$OUT" \
  --people "${PEOPLE:-2}" --backview "${BACKVIEW:-auto}" --fps "${FPS:-30}" --start "${START:-0}" \
  --clip "${CLIP:-play}" --steps "$STEPS" --force "$FORCE" ${WORLD:+--world "$WORLD"} ${ARGS:-}
tw_say "done: $(ls "$OUT")"
