#!/bin/bash
#SBATCH --job-name=dv-walkzone
#SBATCH --gpus=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48gb
#SBATCH --time=00:40:00
#SBATCH --output=dv-walkzone-%j.out
#
# Automatic walk zones (team/shivin.md Update 19, job 1) for one or more worlds:
#   sbatch --account=$HPG_ACCOUNT --qos=$HPG_QOS --partition=$HPG_PARTITION hpg/walkzone.sbatch <scene dir> [<scene dir> ...]
# Writes <scene>/walkzone/ (walkzone.json, collider.glb, topdown.png) only. It does not install: look at topdown.png
# and the hand-made comparison in walkzone.json, then run `python pipeline/walkzone_auto.py --scene <dir> --install`
# (archives the old collider under data/archive/colliders/ and sets world.collider and world.spawn).
set -uo pipefail
REPO="${TW_REPO:-${SLURM_SUBMIT_DIR:-.}}"
# shellcheck source=hpg/env.sh
source "$REPO/hpg/env.sh"
tw_use_env anysplat || { echo "anysplat env missing; run hpg/setup.sh" >&2; exit 1; }
[[ $# -ge 1 ]] || { echo "usage: walkzone.sbatch <scene dir> [...]" >&2; exit 2; }
rc=0
for scene in "$@"; do
  t0=$(date +%s)
  python "$REPO/pipeline/walkzone_auto.py" --scene "$scene" --size 320x200 || rc=1
  echo "$scene: $(( $(date +%s) - t0 )) s"
done
exit $rc
