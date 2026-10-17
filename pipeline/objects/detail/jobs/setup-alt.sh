#!/bin/bash
# One-time: clone the external surface methods at the pinned commits into $TW_SRC and build one env each in
# $TW_ENVS. Needs a GPU node for the CUDA extensions:
#   srun --account=$HPG_ACCOUNT --qos=$HPG_QOS --partition=$HPG_PARTITION --gpus=1 --cpus-per-task=8 --mem=32gb \
#       --time=01:30:00 bash pipeline/objects/detail/jobs/setup-alt.sh [sugar|2dgs|gof|grouping ...]
# Install cost is logged per method to $TW_LOGS/detail-setup.tsv (seconds, env size) for the report.
source "$(dirname "$0")/common.sh"
tw_load_cuda || true
tw_load_gcc || true
tw_load_conda || true
mkdir -p "$TW_SRC" "$TW_ENVS" "$TW_LOGS"
want=("${@:-sugar 2dgs gof grouping}")
# shellcheck disable=SC2206
want=(${want[@]})

clone() {  # name url rev
  local dir="$TW_SRC/$1"
  [[ -d "$dir/.git" ]] || git clone --recursive "$2" "$dir"
  git -C "$dir" fetch -q origin && git -C "$dir" checkout -q "$3" && git -C "$dir" submodule update --init --recursive
  cp "$dir"/LICENSE* "$TW_LOGS/$1.LICENSE" 2>/dev/null || true
}
venv() {  # name
  local env="$TW_ENVS/detail-$1"
  [[ -x "$env/bin/python" ]] || python3 -m venv "$env"
  "$env/bin/pip" install -q --upgrade pip wheel
  "$env/bin/pip" install -q $TW_TORCH_SPEC --index-url "$TW_TORCH_INDEX"
  echo "$env"
}
for m in "${want[@]}"; do
  t0=$(stamp)
  case "$m" in
    sugar)
      clone SuGaR "$SUGAR_URL" "$SUGAR_REV"; env=$(venv sugar)
      "$env/bin/pip" install -q plyfile tqdm open3d trimesh "pytorch3d @ git+https://github.com/facebookresearch/pytorch3d.git@v0.7.8" nvdiffrast
      "$env/bin/pip" install -q "$TW_SRC/SuGaR/gaussian_splatting/submodules/diff-gaussian-rasterization" \
        "$TW_SRC/SuGaR/gaussian_splatting/submodules/simple-knn" ;;
    2dgs)
      clone 2dgs "$TWODGS_URL" "$TWODGS_REV"; env=$(venv 2dgs)
      "$env/bin/pip" install -q plyfile tqdm open3d trimesh opencv-python-headless mediapy lpips
      "$env/bin/pip" install -q "$TW_SRC/2dgs/submodules/diff-surfel-rasterization" "$TW_SRC/2dgs/submodules/simple-knn" ;;
    gof)
      clone gof "$GOF_URL" "$GOF_REV"; env=$(venv gof)
      "$env/bin/pip" install -q plyfile tqdm open3d trimesh opencv-python-headless
      "$env/bin/pip" install -q "$TW_SRC/gof/submodules/diff-gaussian-rasterization" "$TW_SRC/gof/submodules/simple-knn"
      (cd "$TW_SRC/gof/submodules/tetra-triangulation" && cmake . && make -j8 && "$env/bin/pip" install -q -e .) ;;
    grouping)
      clone grouping "$GROUPING_URL" "$GROUPING_REV"; env=$(venv grouping)
      "$env/bin/pip" install -q plyfile tqdm opencv-python-headless scipy
      "$env/bin/pip" install -q "$TW_SRC/grouping/submodules/diff-gaussian-rasterization" \
        "$TW_SRC/grouping/submodules/simple-knn" ;;
    *) echo "unknown method $m" >&2; continue ;;
  esac
  t1=$(stamp)
  printf '%s\t%s s\t%s\n' "$m" "$((t1 - t0))" "$(du -sh "$TW_ENVS/detail-$m" 2>/dev/null | cut -f1)" | tee -a "$TW_LOGS/detail-setup.tsv"
done
