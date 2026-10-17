#!/bin/bash
# Splat training and the finished scene for a reconstruction work folder on HiPerGator (one RTX PRO 6000).
#   sbatch pipeline/recon/hpg/train.sbatch <job dir> <scene id> "<scene name>" [train_gs.py options]
#SBATCH --job-name=recon-train
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=01:00:00
set -euo pipefail
J=$1; ID=$2; NAME=$3; shift 3
PY=${RECON_PY:-/blue/phz3152/sbernalorta/thirdwheel/envs/flashworld/bin/python}
# caches (HF_HOME for the depth model) and no network on the compute node
source /blue/phz3152/sbernalorta/thirdwheel/repo/hpg/env.sh
export HF_HUB_OFFLINE=1
cd "$J"
"$PY" -u code/pipeline/recon/train_gs.py --work "$J/work" --out "$J/work/train" "$@"
"$PY" -u code/pipeline/recon/frame.py post --work "$J/work" --splats "$J/work/train/splats.ply" \
  --scene-dir "$J/scene/$ID" --id "$ID" --name "$NAME" --evidence "$J/evidence"
