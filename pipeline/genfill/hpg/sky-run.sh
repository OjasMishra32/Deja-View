#!/bin/bash
# Runs the sky steps inside a held sky.sbatch allocation, reusing its model worker:
#   srun --jobid=<jobid> --overlap bash sky-run.sh <scene-id> <out-name> <worker-queue> [genfill.sky fill options]
# RERENDER=1 renders again even when <out>/render.npz exists.
set -euo pipefail
H=/blue/phz3152/sbernalorta/thirdwheel
J=$H/jobs/genfill
ID=$1; NAME=$2; Q=$3; shift 3
source "$H/repo/hpg/env.sh"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONPATH=$J/code-sky/pipeline
IN=$J/$ID/sky-in
OUT=$J/$ID/$NAME
mkdir -p "$OUT"
PY=$H/envs/flashworld/bin/python
PALMS=(); [[ -f "$IN/palms.json" ]] && PALMS=(--palms "$IN/palms.json")
if [[ ! -f "$OUT/render.npz" || -n "${RERENDER:-}" ]]; then
  "$PY" -u -m genfill.sky render --scene-dir "$IN" --out "$OUT" "${PALMS[@]}"
fi
"$PY" -u -m genfill.sky fill --out "$OUT" --queue "$Q" "$@"
"$PY" -u -m genfill.sky faces --out "$OUT"
"$PY" -u -m genfill.sky check --scene-dir "$IN" --out "$OUT"
echo "sky-run rc=0"
