#!/bin/bash
#SBATCH --job-name=genfill
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=72G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/genfill/logs/genfill-%j.log
# Generative fill of one world on one GPU: the model worker (avatar env: Qwen2.5-VL, Qwen-Image-Edit-2511, depth, LaMa)
# and the gsplat side (flashworld env) run side by side and talk through a file queue.
#
#   sbatch genfill.sbatch <scene-id> [genfill.run options...]
#
# Inputs:  $J/<scene-id>/in/{scene.json, world*.spz, cameras.json}   (a copy of data/scenes/<scene-id>)
# Outputs: $J/<scene-id>/out-<jobid>/{world-filled.spz, genfill.json, gaps.json, evidence/, work/}
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; shift
source "$H/repo/hpg/env.sh"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export PYTHONPATH=$J/code/pipeline
OUT=$J/$ID/out-${SLURM_JOB_ID:-local}
Q=$OUT/queue
mkdir -p "$Q"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
WPID=""
if [[ " $* " != *" --gaps-only "* ]]; then
  "$H/envs/avatar/bin/python" -u -m genfill.models serve --queue "$Q" --parent $$ > "$OUT/worker.log" 2>&1 &
  WPID=$!
fi
RC=0
"$H/envs/flashworld/bin/python" -u -m genfill.run --scene-dir "$J/$ID/in" --out "$OUT" --queue "$Q" "$@" || RC=$?
if [[ -n "$WPID" ]]; then
  touch "$Q/stop"
  sleep 3
  kill "$WPID" 2>/dev/null || true
fi
nvidia-smi --query-gpu=memory.used --format=csv,noheader || true
exit $RC
