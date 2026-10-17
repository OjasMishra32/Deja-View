#!/bin/bash
#SBATCH --job-name=dv-detail
#SBATCH --gpus=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64gb
#SBATCH --time=02:00:00
#SBATCH --output=dv-detail-%j.out
#
# Rebuild the kitchen objects at high detail and score current vs new (team/shivin-object-detail.md tasks 2-4).
#   sbatch --account=$HPG_ACCOUNT --qos=$HPG_QOS --partition=$HPG_PARTITION \
#       pipeline/objects/detail/jobs/detail.sbatch <scene dir> [object ...]
# PACE ICE (HPG_PROFILE=pace): --account=$PACE_ACCOUNT --qos=$PACE_QOS --partition=$PACE_PARTITION.
# Writes <scene>/objects-detail/ and <scene>/detail-eval/ only. It never touches <scene>/objects/ (the approved
# fridge), never runs review.py --approve and never uploads.
source "$(dirname "$0")/common.sh" 2>/dev/null || source "${SLURM_SUBMIT_DIR:-.}/pipeline/objects/detail/jobs/common.sh"
SCENE="${1:?usage: detail.sbatch <scene dir> [object ...]}"; shift
OBJS=()
for o in "$@"; do OBJS+=(--object "$o"); done
tw_use_env anysplat || { echo "anysplat env missing; run hpg/setup.sh" >&2; exit 1; }
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
t0=$(stamp)
python "$DETAIL/reconstruct.py" --scene "$SCENE" "${OBJS[@]}" --out "$SCENE/objects-detail"; rc=$?
t1=$(stamp)
python "$DETAIL/evaluate.py" --scene "$SCENE" --current "$SCENE/objects" --new "$SCENE/objects-detail" \
  --out "$SCENE/detail-eval" --orbit "${OBJS[@]}" $(for m in "$SCENE"/detail-methods/*/; do [[ -d "$m" ]] &&
  printf -- '--method %s=%s ' "$(basename "$m")" "$m"; done)
t2=$(stamp)
python "$DETAIL/report.py" --eval "$SCENE/detail-eval" > "$SCENE/detail-eval/table.md"
echo "reconstruct $((t1 - t0)) s (rc $rc), evaluate $((t2 - t1)) s; table: $SCENE/detail-eval/table.md"
