#!/bin/bash
#SBATCH --job-name=genfill-ceil
#SBATCH --account=phz3152
#SBATCH --qos=phz3152-b
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=00:50:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/genfill/logs/ceiling-%j.log
# Ceiling completion in texture space (CPU only):  sbatch ceiling.sbatch <scene-id> <out-name> [genfill.ceiling options]
# Inputs: $J/<scene-id>/in/{scene.json, world.spz, cameras.json}; output: $J/<scene-id>/<out-name>/
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; NAME=$2; shift 2
export PYTHONPATH=$J/code/pipeline OMP_NUM_THREADS=4
mkdir -p "$J/$ID/$NAME"
exec "$H/envs/flashworld/bin/python" -u -m genfill.ceiling --scene-dir "$J/$ID/in" --out "$J/$ID/$NAME" "$@"
