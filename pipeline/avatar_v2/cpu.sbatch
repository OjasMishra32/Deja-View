#!/bin/bash
# People v2 on CPU: one pipeline.avatar_v2 module from the synced snapshot ($HPG_ROOT/avatar/v2/snap).
#
#   sbatch $HPG_ROOT/avatar/v2/snap/pipeline/avatar_v2/cpu.sbatch yardstick measure --eval ... --glb-dir ... --variant ...
#
# The snapshot holds pipeline/avatar, pipeline/avatar_v2 and pipeline/common side by side; SNAP overrides it.
#SBATCH --job-name=v2-cpu
#SBATCH --account=phz3152
#SBATCH --qos=phz3152-b
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=00:50:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/logs/v2-cpu-%j.log
set -eo pipefail
HPG_ROOT=/blue/phz3152/sbernalorta/thirdwheel
# shellcheck source=hpg/env.sh
source "$HPG_ROOT/repo/hpg/env.sh"
export ANNY_CACHE_DIR="$HPG_ROOT/models/anny" HF_HUB_OFFLINE=1 OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-16}"
[[ -d "$HPG_ROOT/avatar/pylib/common" ]] && export AVATAR_PYLIB="$HPG_ROOT/avatar/pylib"
tw_use_env avatar
cd "${SNAP:-$HPG_ROOT/avatar/v2/snap}"
tw_say "v2 job ${SLURM_JOB_ID:-local} on $(hostname): $*"
python -W ignore -m "pipeline.avatar_v2.$1" "${@:2}"
tw_say "v2 job done"
