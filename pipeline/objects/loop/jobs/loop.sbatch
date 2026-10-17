#!/bin/bash
#SBATCH --job-name=dv-loop
#SBATCH --gpus=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=80gb
#SBATCH --time=04:00:00
#SBATCH --output=dv-loop-%j.out
#
# The reconstruction loop and the mega evaluation (team/shivin-reconstruction-loop.md).
#   sbatch --account=.. --qos=.. --partition=.. pipeline/objects/loop/jobs/loop.sbatch <scene dir> [eval|stove|all|room]
# PACE ICE (HPG_PROFILE=pace): --account=$PACE_ACCOUNT --qos=$PACE_QOS --partition=$PACE_PARTITION.
#   eval   the evaluator on every object's current GLB (eval.json + eval-sheet.jpg beside each GLB)
#   stove  the loop on the stove (the acceptance run), then the report table
#   all    the loop on every object, two at a time on the GPU
#   room   the loop on the room shell, no ceilings
# Writes <scene>/objects-loop/ and eval files only. Never writes a GLB into <scene>/objects/, never approves, never
# uploads. Set GEMINI_API_KEY in the job's environment (not in the repo) to add the advisory judge to `eval`.
source "${SLURM_SUBMIT_DIR:-.}/pipeline/objects/detail/jobs/common.sh"
SCENE="${1:?usage: loop.sbatch <scene dir> [eval|stove|all|room]}"
WHAT="${2:-stove}"
LOOP="$REPO/pipeline/objects/loop"
EVAL="$REPO/pipeline/objects/eval"
tw_use_env anysplat || { echo "anysplat env missing; run hpg/setup.sh" >&2; exit 1; }
python -c "import cv2" 2>/dev/null || echo "WARNING: no OpenCV in this env: the codes gate will fail closed" >&2
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
t0=$(stamp)
case "$WHAT" in
  eval)  python "$EVAL/evaluate.py" --scene "$SCENE" --object all ${GEMINI_API_KEY:+--judge} ;;
  stove) python "$LOOP/run.py" --scene "$SCENE" --object stove --budget 14 ;;
  all)   python "$LOOP/run.py" --scene "$SCENE" --object all --budget 12 --parallel 2 ;;
  room)  python "$LOOP/run.py" --scene "$SCENE" --room --budget 10 ;;
  *) echo "unknown target $WHAT" >&2; exit 2 ;;
esac
rc=$?
python "$LOOP/report.py" --scene "$SCENE" > "$SCENE/objects-loop/report.md" 2>/dev/null || true
echo "$WHAT finished in $(( $(stamp) - t0 )) s (rc $rc); table: $SCENE/objects-loop/report.md"
exit $rc
