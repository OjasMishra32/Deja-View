#!/bin/bash
#SBATCH --job-name=genfill-palms
#SBATCH --account=phz3152
#SBATCH --qos=phz3152-b
#SBATCH --cpus-per-task=2
#SBATCH --mem=12G
#SBATCH --time=00:15:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/genfill/logs/palms-%j.log
# Palm crowns (CPU):  sbatch palms.sbatch <scene-id> <out-name> [genfill.palms options, e.g. --world <ceiling run>/world-filled.spz]
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; NAME=$2; shift 2
export PYTHONPATH=$J/code/pipeline
mkdir -p "$J/$ID/$NAME"
exec "$H/envs/flashworld/bin/python" -u -m genfill.palms --scene-dir "$J/$ID/in" --out "$J/$ID/$NAME" "$@"
