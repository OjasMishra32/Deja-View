#!/bin/bash
#SBATCH --job-name=tw-worker
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=96gb
#SBATCH --time=04:00:00
#SBATCH --signal=B:USR1@120
#SBATCH --output=tw-worker-%j.out
#
# The warm GPU worker (hpg/worker.py). Start it with `hpg/tw.sh start`, which picks the partition from
# HPG_PARTITION and writes the log to $HPG_ROOT/logs/worker-<jobid>.out.
# The worker exits by itself after TW_WORKER_IDLE seconds without work (default 1200), on `hpg/tw.sh stop`,
# or two minutes before the time limit (USR1), putting an unfinished job back in the queue.
set -uo pipefail

REPO=""
for cand in "${TW_REPO:-}" "${SLURM_SUBMIT_DIR:-}" "${HPG_ROOT:-/blue/phz3152/sbernalorta/thirdwheel}/repo"; do
  if [[ -n "$cand" && -f "$cand/hpg/env.sh" ]]; then
    REPO="$cand"
    break
  fi
done
[[ -n "$REPO" ]] || { echo "hpg/env.sh not found (submit from \$HPG_ROOT/repo)" >&2; exit 2; }
# shellcheck source=hpg/env.sh
source "$REPO/hpg/env.sh"
export TW_REPO="$REPO"
tw_use_env flashworld || { echo "the flashworld environment is missing; run hpg/setup.sh" >&2; exit 2; }
tw_offline_if_ready

echo "[tw-worker] $(date '+%F %T') host=$(hostname) slurm=${SLURM_JOB_ID:-none} partition=${SLURM_JOB_PARTITION:-?}"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true
exec "$TW_PY_FLASHWORLD" -u "$REPO/hpg/worker.py" --root "$HPG_ROOT" --idle-timeout "${TW_WORKER_IDLE:-1200}"
