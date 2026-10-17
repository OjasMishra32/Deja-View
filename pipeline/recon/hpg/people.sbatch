#!/bin/bash
# Stage 2 on HiPerGator: segmentation, monocular depth, per-frame pose refinement and room renders for a handheld clip
# (people.py register). The job folder holds code/pipeline/ (recon/, common/, splat_io.py), work/ (people.py frames)
# and world.spz.
#   sbatch pipeline/recon/hpg/people.sbatch <job dir> [people.py register options]
#SBATCH --job-name=recon-people
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=00:45:00
set -euo pipefail
J=$1; shift
PY=${RECON_PY:-/blue/phz3152/sbernalorta/thirdwheel/envs/flashworld/bin/python}
# caches (HF_HOME and TORCH_HOME for the depth and segmentation weights) and no network on the compute node
source /blue/phz3152/sbernalorta/thirdwheel/repo/hpg/env.sh
export HF_HUB_OFFLINE=1
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
cd "$J"
"$PY" -u code/pipeline/recon/people.py register --work "$J/work" --world "$J/world.spz" "$@"
