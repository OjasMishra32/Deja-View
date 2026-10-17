#!/usr/bin/env bash
# ThirdWheel on HiPerGator: one command for the teammate who holds the login.
#
#   hpg/tw.sh status              worker heartbeat, our Slurm jobs, queue counts, GPU use in the group
#   hpg/tw.sh start [HOURS]       start the warm worker (one GPU; refuses if one is already queued or running)
#   hpg/tw.sh stop [--now]        ask the worker to exit after its current job (--now: scancel it)
#   hpg/tw.sh queue               jobs waiting, running and recently done
#   hpg/tw.sh logs [N]            last N lines of the newest worker log (default 60)
#   hpg/tw.sh submit <jobdir>     run one job as a batch GPU job (hpg/job.sbatch)
#   hpg/tw.sh setup [stages...]   hpg/setup.sh
#   hpg/tw.sh smoke               the one-GPU smoke test (hpg/setup.sh smoke)
#   hpg/tw.sh clean [DAYS]        delete finished job directories older than DAYS (default 3)
#
# Partition: HPG_PARTITION (default hpg-rtx6000). This is a class allocation with two GPUs for everyone:
# run at most one GPU job at a time and stop the worker when you are done.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpg/env.sh
source "$HERE/env.sh"
REPO="$(cd "$HERE/.." && pwd)"
WJ="$TW_JOBS/worker.json"

worker_jobs() { squeue -h -u "$USER" -n tw-worker -o '%i %T %M %l %P %R' 2>/dev/null || true; }

heartbeat_age() {
  python3 - "$WJ" <<'EOF'
import json, sys, time
from datetime import datetime
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("none"); sys.exit(0)
t = d.get("time", "")
try:
    ts = datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
except Exception:
    print("unknown"); sys.exit(0)
age = time.time() - ts
state = "alive" if age <= 90 else "STALE"
print(f"{state} ({age:.0f}s ago) host={d.get('host')} gpu={d.get('gpu')} status={d.get('status')} job={d.get('job')} jobsDone={d.get('jobsDone')}")
EOF
}

cmd_status() {
  echo "HPG_ROOT  $HPG_ROOT"
  echo "worker    $(heartbeat_age)"
  if [[ -f "$TW_JOBS/worker.last.json" ]]; then
    echo "last exit $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("time"), d.get("status"), d.get("error") or "")' "$TW_JOBS/worker.last.json" 2>/dev/null || true)"
  fi
  echo "our jobs:"
  squeue -h -u "$USER" -o '  %i %j %T %M/%l %P %R' 2>/dev/null || echo "  (squeue unavailable)"
  echo "queue: $(find "$TW_JOBS/queue" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | wc -l) waiting, $(find "$TW_JOBS/running" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | wc -l) running"
  echo "GPU jobs in account $HPG_ACCOUNT:"
  squeue -h -A "$HPG_ACCOUNT" -o '  %u %i %j %T %b %P' 2>/dev/null | grep -i gpu || echo "  none"
  local st state
  for st in dirs src envs weights smoke; do
    if [[ -f "$TW_STATE/$st.ok" ]]; then state="done"; else state="-"; fi
    printf '  setup %-8s %s\n' "$st" "$state"
  done
}

cmd_start() {
  local hours="${1:-4}"
  [[ -x "$TW_PY_FLASHWORLD" ]] || tw_die "the flashworld environment is missing; run: bash $HERE/setup.sh"
  local existing
  existing="$(worker_jobs)"
  if [[ -n "$existing" ]]; then
    echo "a worker is already queued or running:"
    echo "  $existing"
    exit 0
  fi
  local busy
  busy="$(squeue -h -A "$HPG_ACCOUNT" -t RUNNING,PENDING -o '%u %b' 2>/dev/null | grep -ci gpu || true)"
  if [[ "${busy:-0}" -ge 2 ]]; then
    tw_warn "the group already has $busy GPU jobs queued or running; yours will wait (the allocation has 2 GPUs)"
  fi
  mkdir -p "$TW_LOGS"
  rm -f "$TW_JOBS/worker.stop"
  local id
  id="$(cd "$REPO" && sbatch --parsable --account="$HPG_ACCOUNT" --qos="$HPG_QOS" --partition="$HPG_PARTITION" \
    --time="$(printf '%02d:00:00' "$hours")" --output="$TW_LOGS/worker-%j.out" hpg/worker.sbatch)"
  echo "submitted worker job $id on $HPG_PARTITION for up to ${hours}h (idle exit after ${TW_WORKER_IDLE:-1200}s)"
  echo "log: $TW_LOGS/worker-${id%%;*}.out   status: hpg/tw.sh status"
}

cmd_stop() {
  mkdir -p "$TW_JOBS"
  touch "$TW_JOBS/worker.stop"
  echo "asked the worker to exit after its current job"
  if [[ "${1:-}" == "--now" ]]; then
    local ids
    ids="$(squeue -h -u "$USER" -n tw-worker -o '%i' 2>/dev/null || true)"
    if [[ -n "$ids" ]]; then
      # shellcheck disable=SC2086
      scancel $ids && echo "cancelled $ids"
    fi
  fi
}

cmd_queue() {
  local d
  for s in queue running; do
    echo "$s:"
    for d in "$TW_JOBS/$s"/*/; do
      [[ -d "$d" ]] || continue
      printf '  %s  %s\n' "$(basename "$d")" "$(cat "$d/progress.json" 2>/dev/null | tr -d '\n' | cut -c1-120)"
    done
  done
  echo "done (newest 10):"
  find "$TW_JOBS/done" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 10 | while read -r _ d; do
    if [[ -f "$d/DONE" ]]; then
      printf '  %s  DONE\n' "$(basename "$d")"
    else
      printf '  %s  FAILED: %s\n' "$(basename "$d")" "$(head -c 160 "$d/FAILED" 2>/dev/null | tr '\n' ' ')"
    fi
  done
}

cmd_logs() {
  local n="${1:-60}" f
  f="$(find "$TW_LOGS" -maxdepth 1 -name 'worker-*.out' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)"
  [[ -n "$f" ]] || tw_die "no worker logs in $TW_LOGS"
  echo "== $f"
  tail -n "$n" "$f"
}

cmd_submit() {
  local jd="${1:?usage: tw.sh submit <jobdir>}"
  jd="$(cd "$jd" && pwd)"
  cd "$REPO"
  sbatch --parsable --account="$HPG_ACCOUNT" --qos="$HPG_QOS" --partition="$HPG_PARTITION" \
    --job-name="tw-$(basename "$jd" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-40)" --output="$jd/slurm-%j.out" hpg/job.sbatch "$jd"
}

cmd_clean() {
  local days="${1:-3}"
  find "$TW_JOBS/done" "$TW_JOBS/batch" "$TW_JOBS/fw-requests" -mindepth 1 -maxdepth 1 -type d -mtime +"$days" -print -exec rm -rf {} + 2>/dev/null || true
}

case "${1:-status}" in
  status) cmd_status ;;
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  queue) cmd_queue ;;
  logs) shift; cmd_logs "$@" ;;
  submit) shift; cmd_submit "$@" ;;
  setup) shift; exec bash "$HERE/setup.sh" "$@" ;;
  smoke) exec bash "$HERE/setup.sh" smoke ;;
  clean) shift; cmd_clean "$@" ;;
  -h | --help | help) sed -n '2,16p' "$0" ;;
  *) tw_die "unknown command '$1' (try: hpg/tw.sh help)" ;;
esac
