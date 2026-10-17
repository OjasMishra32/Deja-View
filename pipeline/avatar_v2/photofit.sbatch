#!/bin/bash
# People v2, prototype A (pipeline/avatar_v2/photofit.py) on one GPU, from a synced snapshot.
#
#   sbatch $HPG_ROOT/avatar/v2/snap/pipeline/avatar_v2/photofit.sbatch fit --work ... --poses ... --eval ... \
#          --prep ... --out FIT --glb-dir OUT [--base-glb-dir DIR] [--budget-min 10]
#
# The masks come first, on CPU: cpu.sbatch photofit prep ... . The group shares two GPUs with world training, so
# this job stays under 30 minutes (the fit stops itself after --budget-min per person). SNAP overrides the snapshot.
#SBATCH --job-name=v2-photofit
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48G
#SBATCH --time=00:29:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/logs/v2-photofit-%j.log
set -eo pipefail
HPG_ROOT=/blue/phz3152/sbernalorta/thirdwheel
# shellcheck source=hpg/env.sh
source "$HPG_ROOT/repo/hpg/env.sh"
export ANNY_CACHE_DIR="$HPG_ROOT/models/anny" HF_HUB_OFFLINE=1 OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-4}"
[[ -d "$HPG_ROOT/avatar/pylib/common" ]] && export AVATAR_PYLIB="$HPG_ROOT/avatar/pylib"
tw_use_env avatar
cd "${SNAP:-$HPG_ROOT/avatar/v2/snap}"
tw_say "photofit job ${SLURM_JOB_ID:-local} on $(hostname) ($(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)): $*"
python -W ignore -m pipeline.avatar_v2.photofit "$@"
tw_say "photofit job done"
