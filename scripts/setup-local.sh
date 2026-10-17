#!/usr/bin/env bash
# Creates the local Python environment (.venv at the repo root) for the pipelines and
# prefetches the model weights into data/models. Safe to run repeatedly.
#
#   scripts/setup-local.sh              install / update and prefetch weights
#   SKIP_MODELS=1 scripts/setup-local.sh   install only
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
REQ="$ROOT/pipeline/requirements-local.txt"

say() { printf '\033[1m[setup]\033[0m %s\n' "$*"; }

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi
for tool in ffmpeg ffprobe; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required (macOS: brew install ffmpeg)." >&2
    exit 1
  fi
done

# Recreate the venv only when it is missing or not Python 3.12.
if [ -x "$PY" ] && "$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null; then
  say ".venv exists ($("$PY" --version))"
else
  say "creating .venv with Python 3.12"
  rm -rf "$VENV"
  uv venv --python 3.12 "$VENV"
fi

say "installing $(basename "$REQ")"
uv pip install --python "$PY" -r "$REQ"

mkdir -p "$ROOT/data/models/hf" "$ROOT/data/models/torch"
export HF_HOME="${HF_HOME:-$ROOT/data/models/hf}"
export TORCH_HOME="${TORCH_HOME:-$ROOT/data/models/torch}"

say "checking torch devices"
"$PY" - <<'EOF'
import torch
mps = getattr(torch.backends, "mps", None)
print(f"torch {torch.__version__}  cuda={torch.cuda.is_available()}  mps={bool(mps and mps.is_available())}")
EOF

if [ "${SKIP_MODELS:-0}" != "1" ]; then
  say "prefetching model weights into data/models (HF_HOME=$HF_HOME)"
  "$PY" "$ROOT/pipeline/common/models.py" --prefetch
fi

say "done. Run a job with: .venv/bin/python pipeline/run_job.py <jobdir>"
