#!/bin/sh
# Render shots one after another (one GPU job at a time): film/kit/queue.sh shotA shotB ...
cd "$(dirname "$0")/../.." || exit 1
while pgrep -f "bun film/kit/render.ts" >/dev/null; do sleep 5; done
for s in "$@"; do
  echo "== $s"
  bun film/kit/render.ts "$s" 2>&1 | grep -E "wrote|page error|Error" | tail -3
done
