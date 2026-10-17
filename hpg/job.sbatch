#!/bin/bash
#SBATCH --job-name=tw-job
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=80gb
#SBATCH --time=00:45:00
#SBATCH --output=tw-job-%j.out
#
# One ThirdWheel job on one GPU:  sbatch hpg/job.sbatch <jobdir>
#
# Options on the sbatch command line override the lines above. The server runs
#   cd $HPG_ROOT/repo && sbatch --account=.. --qos=.. --partition=$HPG_PARTITION --output=<jobdir>/slurm-%j.out hpg/job.sbatch <jobdir>
# and by hand `hpg/tw.sh submit <jobdir>` does the same. The job runs pipeline/run_job.py in the environment that
# matches job.json's mode and makes sure DONE or FAILED exists when it ends.
set -uo pipefail

JOBDIR="${1:?usage: sbatch hpg/job.sbatch <jobdir>}"
JOBDIR="$(cd "$JOBDIR" && pwd)" || exit 2

# Slurm runs a spooled copy of this file, so find the repo from the submit directory or HPG_ROOT.
REPO=""
for cand in "${TW_REPO:-}" "${SLURM_SUBMIT_DIR:-}" "${HPG_ROOT:-/blue/phz3152/sbernalorta/thirdwheel}/repo"; do
  if [[ -n "$cand" && -f "$cand/hpg/env.sh" ]]; then
    REPO="$cand"
    break
  fi
done
fail() {
  echo "$1" >"$JOBDIR/FAILED"
  echo "FAILED: $1" >&2
  exit "${2:-1}"
}
[[ -n "$REPO" ]] || fail "hpg/env.sh not found (submit from \$HPG_ROOT/repo)"
# shellcheck source=hpg/env.sh
source "$REPO/hpg/env.sh"
export TW_REPO="$REPO"

MODE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mode",""))' "$JOBDIR/job.json" 2>/dev/null || true)"
case "$MODE" in
  rentfree) ENV_NAME=flashworld ;;
  reconstruct) ENV_NAME=anysplat ;;
  thirdwheel) ENV_NAME=video ;;
  *) fail "unknown or missing mode in $JOBDIR/job.json ('$MODE')" ;;
esac
tw_use_env "$ENV_NAME" || fail "the $ENV_NAME environment is missing on HiPerGator; run: bash $REPO/hpg/setup.sh"
tw_offline_if_ready
rm -f "$JOBDIR/DONE" "$JOBDIR/FAILED"

echo "[tw-job] $(date '+%F %T') job $(basename "$JOBDIR") mode=$MODE env=$ENV_NAME host=$(hostname) slurm=${SLURM_JOB_ID:-none}"
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader 2>/dev/null || true

"$TW_ENVS/$ENV_NAME/bin/python" -u "$REPO/pipeline/run_job.py" "$JOBDIR"
rc=$?

if [[ ! -f "$JOBDIR/DONE" && ! -f "$JOBDIR/FAILED" ]]; then
  fail "run_job.py exited with code $rc without writing DONE or FAILED (see slurm-${SLURM_JOB_ID:-}.out)" "$((rc == 0 ? 1 : rc))"
fi
echo "[tw-job] $(date '+%F %T') finished with code $rc ($([[ -f "$JOBDIR/DONE" ]] && echo DONE || echo FAILED))"
exit "$rc"
