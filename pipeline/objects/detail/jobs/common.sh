# shellcheck shell=bash
# Sourced by the object-detail jobs. Uses the team's hpg/env.sh (paths, caches, module helpers) so the same scripts
# run on HiPerGator or, with HPG_PROFILE=pace and HPG_ROOT pointing at the PACE scratch root, on PACE ICE.
set -uo pipefail
REPO=""
for cand in "${TW_REPO:-}" "${SLURM_SUBMIT_DIR:-}" "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." 2>/dev/null && pwd)"; do
  if [[ -n "$cand" && -f "$cand/hpg/env.sh" ]]; then REPO="$cand"; break; fi
done
[[ -n "$REPO" ]] || { echo "hpg/env.sh not found; submit from the repo root" >&2; exit 2; }
# shellcheck source=/dev/null
source "$REPO/hpg/env.sh"
export TW_REPO="$REPO"
export PYTHONPATH="$REPO/pipeline${PYTHONPATH:+:$PYTHONPATH}"
DETAIL="$REPO/pipeline/objects/detail"

# External surface methods: cloned at these commits under $TW_SRC, never vendored into this repo.
# SuGaR, 2DGS and GOF are under the Inria Gaussian-Splatting License (non-commercial research and evaluation only);
# Gaussian Grouping is Apache-2.0 but builds Inria's diff-gaussian-rasterization. See docs/object-detail.md.
export SUGAR_URL="https://github.com/Anttwo/SuGaR.git"
export SUGAR_REV="${SUGAR_REV:-7c10c4ae4a267dece512f5c7f40ed212a0a2ab44}"
export TWODGS_URL="https://github.com/hbb1/2d-gaussian-splatting.git"
export TWODGS_REV="${TWODGS_REV:-f3e3b9fa67bbd1c75e05167ff37391d8dab2a678}"
export GOF_URL="https://github.com/autonomousvision/gaussian-opacity-fields.git"
export GOF_REV="${GOF_REV:-5245b20e5d11acd6d1ff5af4b890dc2bedd99693}"
export GROUPING_URL="https://github.com/lkeab/gaussian-grouping.git"
export GROUPING_REV="${GROUPING_REV:-0ab60afed3385b717c985af1d30a20f7b0884c89}"

stamp() { date +%s; }
