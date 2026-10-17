#!/bin/bash
#SBATCH --job-name=genfill-dev
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=72G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/genfill/logs/hold-%j.log
# Holds one GPU with the model worker loaded (queue $J/queue-<jobid>), so several genfill runs reuse the models:
#   srun --jobid=<jobid> --overlap bash $J/code/pipeline/genfill/hpg/in-job.sh <scene-id> <out-name> [genfill.run options]
# Ends when $J/queue-<jobid>/stop exists (the worker exits) or at the time limit.
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
source "$H/repo/hpg/env.sh"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export PYTHONPATH=$J/code/pipeline
Q=$J/queue-$SLURM_JOB_ID
mkdir -p "$Q"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
"$H/envs/avatar/bin/python" -u -m genfill.models serve --queue "$Q" > "$J/logs/worker-$SLURM_JOB_ID.log" 2>&1 &
WPID=$!
while kill -0 "$WPID" 2>/dev/null; do sleep 10; done
echo "worker exited"
