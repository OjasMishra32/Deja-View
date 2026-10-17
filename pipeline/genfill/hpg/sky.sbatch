#!/bin/bash
#SBATCH --job-name=genfill-sky
#SBATCH --account=phz3152
#SBATCH --qos=phz3152
#SBATCH --partition=hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=72G
#SBATCH --time=00:29:00
#SBATCH --output=/blue/phz3152/sbernalorta/thirdwheel/jobs/genfill/logs/sky-%j.log
# Sky completion (genfill/sky.py) for one scene:
#   sbatch sky.sbatch <scene-id> <out-name> [--hold]
# Inputs in $J/<scene-id>/sky-in (scene.json, cameras.json, the world file). Starts the model worker (editor only),
# renders the far panorama while the editor loads, fills it, writes the faces and the check views. With --hold the
# allocation stays up after that (until $OUT/queue/stop or the time limit) so more fills can run in it:
#   srun --jobid=<jobid> --overlap bash -c 'source .../sky-env.sh; $PY -m genfill.sky fill --out ... --queue ...'
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; NAME=$2; HOLD=${3:-}
source "$H/repo/hpg/env.sh"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONPATH=$J/code-sky/pipeline
IN=$J/$ID/sky-in
OUT=$J/$ID/$NAME
Q=$OUT/queue
mkdir -p "$Q"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
"$H/envs/avatar/bin/python" -u -m genfill.models serve --queue "$Q" --preload edit --parent $$ > "$OUT/worker.log" 2>&1 &
WPID=$!
PY=$H/envs/flashworld/bin/python
RC=0
PALMS=(); [[ -f "$IN/palms.json" ]] && PALMS=(--palms "$IN/palms.json")
"$PY" -u -m genfill.sky render --scene-dir "$IN" --out "$OUT" "${PALMS[@]}" || RC=$?
if [[ $RC == 0 ]]; then
  "$PY" -u -m genfill.sky fill --out "$OUT" --queue "$Q" --candidates 2 ${FILL_ARGS:-} || RC=$?
fi
if [[ $RC == 0 ]]; then
  "$PY" -u -m genfill.sky faces --out "$OUT" && "$PY" -u -m genfill.sky check --scene-dir "$IN" --out "$OUT" || RC=$?
fi
echo "pipeline rc=$RC"
if [[ "$HOLD" == "--hold" ]]; then
  while kill -0 "$WPID" 2>/dev/null && [[ ! -f "$Q/stop" ]]; do sleep 5; done
fi
touch "$Q/stop"; sleep 3; kill "$WPID" 2>/dev/null || true
exit $RC
