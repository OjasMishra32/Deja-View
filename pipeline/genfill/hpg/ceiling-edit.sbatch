#!/bin/bash
#SBATCH --job-name=genfill-ceil-edit
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=72G
#SBATCH --time=00:40:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/genfill/logs/ceiling-edit-%j.log
# Ceiling completion with the edit model filling the texture image:
#   sbatch ceiling-edit.sbatch <scene-id> <out-name> [genfill.ceiling options]   (adds --fill edit --queue ...)
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; NAME=$2; shift 2
source "$H/repo/hpg/env.sh"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONPATH=$J/code/pipeline
OUT=$J/$ID/$NAME
Q=$OUT/queue
mkdir -p "$Q"
"$H/envs/avatar/bin/python" -u -m genfill.models serve --queue "$Q" --preload edit --parent $$ > "$OUT/worker.log" 2>&1 &
WPID=$!
RC=0
"$H/envs/flashworld/bin/python" -u -m genfill.ceiling --scene-dir "$J/$ID/in" --out "$OUT" --fill edit --queue "$Q" "$@" || RC=$?
touch "$Q/stop"; sleep 3; kill "$WPID" 2>/dev/null || true
exit $RC
