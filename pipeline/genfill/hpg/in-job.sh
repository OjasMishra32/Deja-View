#!/bin/bash
# Runs genfill inside a held allocation (hold.sbatch), using its model worker:
#   srun --jobid=<jobid> --overlap bash in-job.sh <scene-id> <out-name> [genfill.run options]
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; NAME=$2; shift 2
source "$H/repo/hpg/env.sh"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export PYTHONPATH=$J/code/pipeline
mkdir -p "$J/$ID/$NAME"
exec "$H/envs/flashworld/bin/python" -u -m genfill.run --scene-dir "$J/$ID/in" --out "$J/$ID/$NAME" --queue "${QUEUE:-$J/queue-$SLURM_JOB_ID}" "$@"
