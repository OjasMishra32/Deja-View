#!/bin/sh
# Render shots one after another (one GPU job at a time): film/kit/queue.sh shotA shotB@30 ...  (@fps optional)
cd "$(dirname "$0")/../.." || exit 1
while pgrep -f "bun film/kit/(render|site-rec).ts" >/dev/null; do sleep 5; done
for s in "$@"; do
  name=${s%@*}; fps=60; case "$s" in *@*) fps=${s#*@};; esac
  echo "== $name ($fps fps)"
  bun film/kit/render.ts "$name" --fps=$fps 2>&1 | grep -E "wrote|page error|Error" | tail -3
done
