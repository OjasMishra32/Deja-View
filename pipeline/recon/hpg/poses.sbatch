#!/bin/bash
# COLMAP poses for a reconstruction work folder on HiPerGator (SIFT and matching on the GPU, mapper on the CPU).
#   sbatch pipeline/recon/hpg/poses.sbatch <job dir with code/ and work/> [poses.py solve options, e.g. --seq-window 8]
#SBATCH --job-name=recon-poses
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
#SBATCH --time=00:45:00
set -euo pipefail
J=$1; shift
# SQLite cannot keep its write-ahead log on /blue: the working database lives on node-local disk
LOCAL=${TMPDIR:-/tmp}/recon-$SLURM_JOB_ID; mkdir -p "$LOCAL"
PY=${RECON_PY:-/blue/phz3152/sbernalorta/thirdwheel/envs/flashworld/bin/python}
export COLMAP_CMD="apptainer exec --nv --bind /blue --bind $LOCAL /apps/colmap/3.11/container.sif colmap"
cd "$J"
"$PY" -u code/pipeline/recon/poses.py solve --work "$J/work" --threads "${SLURM_CPUS_PER_TASK:-8}" --db "$LOCAL/database.db" "$@"
