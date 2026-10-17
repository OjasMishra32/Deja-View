#!/bin/bash
# People v2, prototype B on CPU: pipeline.avatar_v2.clean into NEW and OUT, then the yardstick as VARIANT.
#
#   sbatch --export=ALL,NEW=$HPG_ROOT/avatar/v2/work-B,OUT=$HPG_ROOT/avatar/v2/out-B,VARIANT=B[,STEPS=all,FORCE=,ARGS=] \
#          $HPG_ROOT/avatar/v2/snap/pipeline/avatar_v2/clean.sbatch
#
# STEPS / FORCE take colon-separated step names (expo:refine), since --export splits on commas. ARGS: more clean.py
# flags (--no-expo, --no-refine, --no-offsets, --frames-from DIR). BASE (default v2/work-heldout): the held-out work
# folder. Runs from the synced snapshot ($HPG_ROOT/avatar/v2/snap; SNAP overrides it). Results: v2/results/VARIANT.
#SBATCH --job-name=v2-clean
#SBATCH --account=phz3152
#SBATCH --qos=phz3152-b
#SBATCH --partition=hpg-dev,hpg-default,hpg-milan,hpg-turin
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=00:50:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/logs/v2-clean-%j.log
set -eo pipefail
HPG_ROOT=/blue/phz3152/sbernalorta/thirdwheel
# shellcheck source=hpg/env.sh
source "$HPG_ROOT/repo/hpg/env.sh"
export ANNY_CACHE_DIR="$HPG_ROOT/models/anny" HF_HUB_OFFLINE=1 OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-16}"
[[ -d "$HPG_ROOT/avatar/pylib/common" ]] && export AVATAR_PYLIB="$HPG_ROOT/avatar/pylib"
tw_use_env avatar
V2="$HPG_ROOT/avatar/v2"
IN="$HPG_ROOT/avatar/inputs"
: "${NEW:?set NEW}" "${OUT:?set OUT}" "${VARIANT:?set VARIANT}"
STEPS="${STEPS:-all}"; STEPS="${STEPS//:/,}"
FORCE="${FORCE:-}"; FORCE="${FORCE//:/,}"
cd "${SNAP:-$V2/snap}"
tw_say "v2 clean job ${SLURM_JOB_ID:-local} on $(hostname): $VARIANT"
# shellcheck disable=SC2086
python -W ignore -m pipeline.avatar_v2.clean run --base "${BASE:-$V2/work-heldout}" --eval "$V2/eval/IMG_7373" --new "$NEW" \
  --video "$IN/IMG_7373.mov" --poses "$IN/IMG_7373-poses-the-courts-v2.json" --world "$IN/the-courts-world-v2.spz" \
  --out-dir "$OUT" --steps "$STEPS" --force "$FORCE" ${ARGS:-}
if [[ "$STEPS" == "all" || "$STEPS" == *glb* ]]; then
  python -W ignore -m pipeline.avatar_v2.yardstick measure --eval "$V2/eval/IMG_7373" --glb-dir "$OUT" --variant "$VARIANT" \
    --out "$V2/results/$VARIANT" --atlas
  # exposure-matched check: the held-out frames under the same exposure and lens model as the texture
  if [[ -d "$NEW/heldout-frames" && -z "${ARGS:-}" ]]; then
    python -W ignore -m pipeline.avatar_v2.yardstick measure --eval "$V2/eval/IMG_7373" --glb-dir "$OUT" \
      --variant "$VARIANT-expomatched" --out "$V2/results/$VARIANT-expomatched" --frames "$NEW/heldout-frames"
  fi
fi
tw_say "v2 clean job done"
