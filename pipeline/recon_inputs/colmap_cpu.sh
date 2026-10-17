#!/bin/bash
# COLMAP 3.11 poses on CPU (HiPerGator batch job) for a pipeline/recon work folder made from several videos:
#   images/<group>/*.jpg, masks/<group>/*.jpg.png (255 = use), frames.json (one camera group per video).
#
#   sbatch --account=phz3152 --qos=phz3152 --cpus-per-task=16 --mem=64G --time=01:00:00 \
#       pipeline/recon_inputs/colmap_cpu.sh STAGE WORK [VOCAB_TREE]
#
# STAGE
#   match   features per group (one camera per video, RADIAL, no features on masked people), then sequential
#           matching in name order (= time order within a video), then vocabulary-tree matching of every
#           image against its nearest neighbours in the whole set (loop closures within a video and the
#           links between videos).
#           COLMAP 3.11 matches on the CPU by brute force (cost ~ features^2 per pair) and quantizes features
#           for the vocabulary tree on one thread, so the feature count is capped (MAX_FEATURES, one
#           orientation per keypoint): with 8192 keypoints x 2 orientations a 473-image set needed ~8 min
#           to index and ~8 s per image of sequential matching, over an hour in all.
#   map     incremental mapper, then (if it split) model_merger of the pieces, a final global bundle
#           adjustment, the per-model report (colmap/models.txt) and a TXT copy of the best model.
#   all     both, one after the other.
# The SQLite database lives on node-local disk while COLMAP runs (WAL needs shared memory /blue does not
# offer) and is copied to WORK/colmap/database.db after each stage.
set -euo pipefail

STAGE=${1:?stage: match | map | all}
WORK=$(cd "${2:?work folder}" && pwd)
VOCAB=${3:-$WORK/../vocab_tree_flickr100K_words32K.bin}
THREADS=${SLURM_CPUS_PER_TASK:-16}
SIF=${COLMAP_SIF:-/apps/colmap/3.11/container.sif}
CAMERA_MODEL=${CAMERA_MODEL:-RADIAL}
MAX_FEATURES=${MAX_FEATURES:-6000}
LOCAL=${TMPDIR:-/tmp}/tw-colmap-${SLURM_JOB_ID:-$$}
mkdir -p "$LOCAL" "$WORK/colmap/sparse"
DB=$LOCAL/database.db
LOG=$WORK/colmap/colmap.log

if ! command -v apptainer >/dev/null; then
  module load apptainer >/dev/null 2>&1 || true
fi
colmap() {
  echo "\$ colmap $*" | tee -a "$LOG"
  local t0=$SECONDS
  apptainer exec --bind /blue --bind "$LOCAL" "$SIF" colmap "$@" >>"$LOG" 2>&1
  echo "  done in $((SECONDS - t0))s" | tee -a "$LOG"
}
save_db() { cp "$DB" "$WORK/colmap/database.db"; }

stage_match() {
  rm -f "$DB"
  local groups
  groups=$(python3 -c "import json,sys; print(' '.join(json.load(open(sys.argv[1]))['groups']))" "$WORK/frames.json")
  for g in $groups; do
    python3 - "$WORK/frames.json" "$g" >"$LOCAL/list-$g.txt" <<'EOF'
import json, sys
f = json.load(open(sys.argv[1]))
print("\n".join(sorted(im["name"] for im in f["images"] if im["group"] == sys.argv[2])))
EOF
    local w
    w=$(python3 -c "import json,sys; g=json.load(open(sys.argv[1]))['groups'][sys.argv[2]]; print(max(g['width'], g['height']))" "$WORK/frames.json" "$g")
    echo "features $g: $(wc -l <"$LOCAL/list-$g.txt") images" | tee -a "$LOG"
    colmap feature_extractor \
      --database_path "$DB" --image_path "$WORK/images" --image_list_path "$LOCAL/list-$g.txt" \
      --ImageReader.single_camera 1 --ImageReader.camera_model "$CAMERA_MODEL" \
      --ImageReader.mask_path "$WORK/masks" \
      --SiftExtraction.use_gpu 0 --SiftExtraction.num_threads "$THREADS" \
      --SiftExtraction.max_image_size "$w" --SiftExtraction.max_num_features "$MAX_FEATURES" \
      --SiftExtraction.max_num_orientations 1
  done
  save_db
  colmap sequential_matcher --database_path "$DB" \
    --SiftMatching.use_gpu 0 --SiftMatching.num_threads "$THREADS" \
    --SequentialMatching.overlap 10 --SequentialMatching.quadratic_overlap 1 \
    --SequentialMatching.loop_detection 0
  save_db
  colmap vocab_tree_matcher --database_path "$DB" \
    --SiftMatching.use_gpu 0 --SiftMatching.num_threads "$THREADS" \
    --VocabTreeMatching.num_images 30 --VocabTreeMatching.max_num_features 3000 \
    --VocabTreeMatching.vocab_tree_path "$VOCAB"
  save_db
}

stage_map() {
  # MAP_TAG=x writes colmap/sparse-x, final-x, final_txt-x, models-x.txt, colmap-x.log, so a second mapper run
  # with other settings (MAPPER_EXTRA="--Mapper.ba_global_images_ratio 1.3 ...") can run beside the first.
  # MAP_KEYS_FIRST=1 maps only the keyframes (frames.json roles "key") and then registers the rest (the
  # players clip: ~150 frames from an almost still camera, which make the global bundle adjustment
  # ill-conditioned while the map grows) into the finished model with image_registrator.
  local sfx=${MAP_TAG:+-$MAP_TAG}
  local C=$WORK/colmap
  [[ -n "$sfx" ]] && LOG=$C/colmap$sfx.log
  [[ -f "$DB" ]] || cp "$C/database.db" "$DB"
  rm -rf "$C/sparse$sfx" "$C/merged$sfx" "$C/registered$sfx" && mkdir -p "$C/sparse$sfx"
  local list_args=()
  if [[ "${MAP_KEYS_FIRST:-0}" == 1 ]]; then
    python3 - "$WORK/frames.json" >"$LOCAL/keys.txt" <<'EOF'
import json, sys
print("\n".join(sorted(im["name"] for im in json.load(open(sys.argv[1]))["images"] if "key" in im.get("roles", ["key"]))))
EOF
    echo "mapping $(wc -l <"$LOCAL/keys.txt") keyframes first" | tee -a "$LOG"
    list_args=(--image_list_path "$LOCAL/keys.txt")
  fi
  # shellcheck disable=SC2086
  colmap mapper --database_path "$DB" --image_path "$WORK/images" --output_path "$C/sparse$sfx" \
    "${list_args[@]}" \
    --Mapper.num_threads "$THREADS" --Mapper.ba_refine_focal_length 1 --Mapper.ba_refine_extra_params 1 \
    --Mapper.ba_refine_principal_point 0 ${MAPPER_EXTRA:-}
  : >"$C/models$sfx.txt"
  for m in "$C/sparse$sfx"/*/; do
    echo "== $(basename "$m")" >>"$C/models$sfx.txt"
    apptainer exec --bind /blue "$SIF" colmap model_analyzer --path "$m" >>"$C/models$sfx.txt" 2>&1
  done
  local n
  n=$(find "$C/sparse$sfx" -mindepth 1 -maxdepth 1 -type d | wc -l)
  local best="$C/sparse$sfx/0"
  if [[ $n -gt 1 ]]; then
    # Merge every other model into the largest (models share images when the mapper split late).
    best=$(python3 - "$C/models$sfx.txt" "$C/sparse$sfx" <<'EOF'
import re, sys
txt = open(sys.argv[1]).read()
best, n = None, -1
for name, body in re.findall(r"== (\S+)\n(.*?)(?=\n== |\Z)", txt, re.S):
    m = re.search(r"Registered images:\s*(\d+)", body)
    if m and int(m.group(1)) > n:
        best, n = name, int(m.group(1))
print(f"{sys.argv[2]}/{best}")
EOF
)
    cp -r "$best" "$C/merged$sfx"
    for m in "$C/sparse$sfx"/*/; do
      m=${m%/}
      [[ "$m" == "$best" ]] && continue
      if apptainer exec --bind /blue "$SIF" colmap model_merger --input_path1 "$C/merged$sfx" \
           --input_path2 "$m" --output_path "$C/merged$sfx" >>"$LOG" 2>&1; then
        echo "merged $(basename "$m") into the largest model" | tee -a "$LOG"
      else
        echo "could not merge $(basename "$m") (no shared images or too few)" | tee -a "$LOG"
      fi
    done
    best="$C/merged$sfx"
  fi
  if [[ "${MAP_KEYS_FIRST:-0}" == 1 ]]; then
    mkdir -p "$C/registered$sfx"
    colmap image_registrator --database_path "$DB" --input_path "$best" --output_path "$C/registered$sfx" \
      --Mapper.num_threads "$THREADS" --Mapper.ba_refine_focal_length 1 --Mapper.ba_refine_extra_params 1 \
      --Mapper.ba_refine_principal_point 0
    best="$C/registered$sfx"
  fi
  rm -rf "$C/final$sfx" && mkdir -p "$C/final$sfx"
  colmap bundle_adjuster --input_path "$best" --output_path "$C/final$sfx" \
    --BundleAdjustment.refine_focal_length 1 --BundleAdjustment.refine_extra_params 1 \
    --BundleAdjustment.refine_principal_point 0
  echo "== final" >>"$C/models$sfx.txt"
  apptainer exec --bind /blue "$SIF" colmap model_analyzer --path "$C/final$sfx" >>"$C/models$sfx.txt" 2>&1
  rm -rf "$C/final_txt$sfx" && mkdir -p "$C/final_txt$sfx"
  colmap model_converter --input_path "$C/final$sfx" --output_path "$C/final_txt$sfx" --output_type TXT
}

echo "[$(date +%H:%M:%S)] stage $STAGE on $(hostname), $THREADS threads, work $WORK" | tee -a "$LOG"
case "$STAGE" in
  match) stage_match ;;
  map) stage_map ;;
  all) stage_match; stage_map ;;
  *) echo "unknown stage $STAGE" >&2; exit 2 ;;
esac
rm -rf "$LOCAL"
echo "[$(date +%H:%M:%S)] stage $STAGE finished" | tee -a "$LOG"
