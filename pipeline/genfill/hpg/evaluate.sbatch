#!/bin/bash
#SBATCH --job-name=genfill-eval
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=00:30:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/genfill/logs/eval-%j.log
# Training-view check of filled worlds:  sbatch evaluate.sbatch <scene-id> <out-name> [genfill.evaluate options]
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; NAME=$2; shift 2
source "$H/repo/hpg/env.sh"
export PYTHONPATH=$J/code/pipeline
mkdir -p "$J/$ID/$NAME"
exec "$H/envs/flashworld/bin/python" -u -m genfill.evaluate --scene-dir "$J/$ID/in" --out "$J/$ID/$NAME" "$@"
