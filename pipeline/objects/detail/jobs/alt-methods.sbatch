#!/bin/bash
#SBATCH --job-name=dv-detail-alt
#SBATCH --gpus=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64gb
#SBATCH --time=03:00:00
#SBATCH --output=dv-detail-alt-%j.out
#
# Task 5: SuGaR, 2DGS, GOF and Gaussian Grouping on one object vs the TSDF baseline.
#   sbatch --account=.. --qos=.. --partition=.. pipeline/objects/detail/jobs/alt-methods.sbatch <scene dir> stove [methods]
# After setup-alt.sh. Each method trains on the same object-centric export (export_dataset.py) and its mesh lands
# in <scene>/detail-methods/<method>/<object>/mesh.{ply,obj}, where detail.sbatch / evaluate.py --method pick it up.
# Runtime per method is logged to <scene>/detail-methods/runtime.tsv. CLI flags follow each repo's README at the
# pinned commit; if a repo changed its entry points, update the line here, not the repo.
source "$(dirname "$0")/common.sh" 2>/dev/null || source "${SLURM_SUBMIT_DIR:-.}/pipeline/objects/detail/jobs/common.sh"
SCENE="${1:?usage: alt-methods.sbatch <scene dir> <object> [sugar 2dgs gof grouping]}"
OBJ="${2:?object id}"; shift 2
METHODS=("${@:-sugar 2dgs gof grouping}")
# shellcheck disable=SC2206
METHODS=(${METHODS[@]})
DATA="$SCENE/detail-methods/_data/$OBJ"
RUNS="$SCENE/detail-methods/_runs"
mkdir -p "$DATA" "$RUNS"
tw_use_env anysplat || exit 1
[[ -f "$DATA/transforms_train.json" ]] || python "$DETAIL/export_dataset.py" --scene "$SCENE" --object "$OBJ" --out "$DATA" --size 1024 --count 48
tw_load_cuda || true

run() {  # method -> train + extract; leaves the mesh at detail-methods/<method>/<obj>/
  local m="$1" py="$TW_ENVS/detail-$1/bin/python" out="$RUNS/$1-$OBJ" dst="$SCENE/detail-methods/$1/$OBJ"
  mkdir -p "$dst"
  [[ -x "$py" ]] || { echo "$m: env missing, run setup-alt.sh $m" >&2; return 1; }
  case "$m" in
    sugar)
      (cd "$TW_SRC/SuGaR" && "$py" train_full_pipeline.py -s "$DATA" -r dn_consistency --high_poly True --export_obj True \
        --white_background False --gs_output_dir "$out/gs" ) || return 1
      cp "$(ls -t "$TW_SRC"/SuGaR/output/refined_mesh/*/*.obj | head -1)" "$dst/mesh.obj" ;;
    2dgs)
      (cd "$TW_SRC/2dgs" && "$py" train.py -s "$DATA" -m "$out" && \
        "$py" render.py -s "$DATA" -m "$out" --skip_train --skip_test --mesh_res 1024) || return 1
      cp "$out"/train/ours_*/fuse_post.ply "$dst/mesh.ply" ;;
    gof)
      (cd "$TW_SRC/gof" && "$py" train.py -s "$DATA" -m "$out" -r 1 && \
        "$py" extract_mesh.py -m "$out" --iteration 30000) || return 1
      cp "$(ls "$out"/test/ours_30000/fusion/mesh_binary_search_*.ply | tail -1)" "$dst/mesh.ply" ;;
    grouping)
      # Grouping segments Gaussians; it does not mesh. Its object Gaussians go through our TSDF path, so the
      # comparison isolates "better separation" from "better surface".
      (cd "$TW_SRC/grouping" && "$py" train.py -s "$DATA" -m "$out" --object_path object_mask) || return 1
      tw_use_env anysplat
      python "$DETAIL/reconstruct.py" --scene "$SCENE" --object "$OBJ" --out "$SCENE/detail-methods/grouping" \
        --splats "$(ls -t "$out"/point_cloud/iteration_*/point_cloud.ply | head -1)" --no-maps ;;
  esac
}
for m in "${METHODS[@]}"; do
  t0=$(stamp); run "$m"; rc=$?; t1=$(stamp)
  printf '%s\t%s\t%s s\trc=%s\n' "$OBJ" "$m" "$((t1 - t0))" "$rc" | tee -a "$SCENE/detail-methods/runtime.tsv"
done
tw_use_env anysplat
python "$DETAIL/evaluate.py" --scene "$SCENE" --object "$OBJ" --orbit --out "$SCENE/detail-eval" \
  $(for m in "${METHODS[@]}"; do printf -- '--method %s=%s ' "$m" "$SCENE/detail-methods/$m"; done)
