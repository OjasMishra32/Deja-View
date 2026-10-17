#!/usr/bin/env bash
# Déjà View on a rented GPU box: the warm GPU worker (hpg/worker.py) without Slurm. Run it on the box.
#
#   vultr/worker.sh start [HOURS]   start the worker in the background for up to HOURS (default 4)
#   vultr/worker.sh stop [--now]    ask it to exit after its current job (--now: stop now; that job goes back to the queue)
#   vultr/worker.sh status          heartbeat, process, queue, GPU, setup stages
#   vultr/worker.sh logs [N]        last N lines of the newest worker log (default 60)
#   vultr/worker.sh run             the worker in the foreground (what start runs)
#
# It is the HiPerGator worker with the same files (docs/HPG.md): jobs/worker.json is rewritten every 30 s, which is
# all the server reads to see it, and it exits by itself after TW_WORKER_IDLE seconds without work (default 1200).
# HOURS stands in for the Slurm time limit: when it is up the worker is asked to stop (an unfinished job goes back
# to the queue) and killed two minutes later if it is still there. The box bills until it is destroyed, worker or not.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
export HPG_ROOT="${HPG_ROOT:-/root/dejaview}"
# shellcheck source=hpg/env.sh
source "$REPO/hpg/env.sh"
WJ="$TW_JOBS/worker.json"
PIDFILE="$TW_STATE/worker.pid"

# The pid start recorded, if that process is still a worker.
worker_pid() {
  local pid args
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  args="$(ps -p "$pid" -o args= 2>/dev/null)" || return 1
  [[ "$args" == *worker.sh* || "$args" == *worker.py* ]] || return 1
  echo "$pid"
}

# "alive (12s ago) host=... status=idle ..." from jobs/worker.json, the way the server judges it (fresh within 90 s).
heartbeat() {
  python3 - "$WJ" <<'EOF'
import json, sys, time
from datetime import datetime
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("none (no jobs/worker.json: not running)"); sys.exit(0)
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

# The pid in jobs/worker.json (0 when there is none).
beat_pid() {
  python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("pid") or 0))' "$WJ" 2>/dev/null || echo 0
}

cmd_start() {
  local hours="${1:-4}" pid log
  [[ "$hours" =~ ^[0-9]+([.][0-9]+)?$ ]] || tw_die "HOURS is a number, e.g. vultr/worker.sh start 8"
  [[ -x "$TW_PY_FLASHWORLD" ]] || tw_die "the flashworld environment is missing; run: bash $HERE/setup.sh"
  pid="$(worker_pid || true)"
  if [[ -n "$pid" ]]; then
    echo "the worker is already running (pid $pid): vultr/worker.sh status"
    exit 0
  fi
  if [[ "$(heartbeat)" == alive* ]]; then
    # A worker killed outright leaves a fresh worker.json behind; the next one only puts that worker's job back in
    # the queue once the heartbeat is stale, so wait rather than start over it.
    local bpid
    bpid="$(beat_pid)"
    if ((bpid <= 0)) || ! kill -0 "$bpid" 2>/dev/null; then
      tw_die "a worker stopped less than 90 s ago and its heartbeat still looks fresh; start again in a minute"
    fi
    tw_die "another worker is sending heartbeats ($(heartbeat)); stop it first (vultr/worker.sh stop)"
  fi
  mkdir -p "$TW_LOGS" "$TW_STATE" "$TW_JOBS"
  rm -f "$TW_JOBS/worker.stop"
  log="$TW_LOGS/worker-$(date +%Y%m%d-%H%M%S).out"
  local cmd=(bash "$HERE/worker.sh" run)
  if command -v timeout >/dev/null 2>&1; then
    cmd=(timeout -s TERM -k 120 "${hours}h" "${cmd[@]}")
  else
    tw_warn "timeout(1) not found: no time limit, the worker runs until it idles out or you stop it"
  fi
  # Its own session: logging out of ssh does not touch it.
  if command -v setsid >/dev/null 2>&1; then
    cmd=(setsid "${cmd[@]}")
  fi
  nohup "${cmd[@]}" >>"$log" 2>&1 </dev/null &
  echo "$!" >"$PIDFILE"
  echo "started the worker (pid $!) for up to ${hours}h (idle exit after ${TW_WORKER_IDLE:-1200}s)"
  echo "log: $log"
  echo "loading the models takes 1-3 min; it is ready when 'vultr/worker.sh status' says status=idle"
}

cmd_stop() {
  local pid
  pid="$(worker_pid || true)"
  # Also a worker started some other way (`worker.sh run` in tmux): its heartbeat is fresh.
  if [[ -z "$pid" && "$(heartbeat)" != alive* ]]; then
    echo "no worker is running"
    return 0
  fi
  mkdir -p "$TW_JOBS"
  touch "$TW_JOBS/worker.stop"
  echo "asked the worker to exit after its current job"
  if [[ "${1:-}" == "--now" ]]; then
    if [[ -n "$pid" ]]; then
      kill -TERM "$pid"
      echo "stopping pid $pid now (an unfinished job goes back to the queue)"
    else
      echo "no worker process found"
    fi
  fi
}

cmd_status() {
  local pid st state
  echo "HPG_ROOT  $HPG_ROOT"
  echo "worker    $(heartbeat)"
  if [[ -f "$TW_JOBS/worker.last.json" ]]; then
    echo "last exit $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("time"), d.get("status"), d.get("error") or "")' "$TW_JOBS/worker.last.json" 2>/dev/null || true)"
  fi
  pid="$(worker_pid || true)"
  echo "process   ${pid:-none}"
  echo "queue     $(find "$TW_JOBS/queue" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | wc -l | xargs) waiting, $(find "$TW_JOBS/running" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | wc -l | xargs) running"
  echo "gpu       $(nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || echo 'nvidia-smi unavailable')"
  for st in system dirs src envs weights smoke; do
    if [[ -f "$TW_STATE/$st.ok" ]]; then state="done"; else state="-"; fi
    printf '  setup %-8s %s\n' "$st" "$state"
  done
}

cmd_logs() {
  local n="${1:-60}" files
  # worker-<date>-<time>.out: the glob sorts oldest first.
  files=("$TW_LOGS"/worker-*.out)
  [[ -e "${files[0]}" ]] || tw_die "no worker logs in $TW_LOGS"
  echo "== ${files[${#files[@]} - 1]}"
  tail -n "$n" "${files[${#files[@]} - 1]}"
}

# What hpg/worker.sbatch does on HiPerGator, minus Slurm.
cmd_run() {
  tw_use_env flashworld || tw_die "the flashworld environment is missing; run: bash $HERE/setup.sh"
  tw_offline_if_ready
  export TW_REPO="$REPO"
  echo "[worker] $(date '+%F %T') host=$(hostname) root=$HPG_ROOT (no Slurm)"
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true
  exec "$TW_PY_FLASHWORLD" -u "$REPO/hpg/worker.py" --root "$HPG_ROOT" --idle-timeout "${TW_WORKER_IDLE:-1200}"
}

case "${1:-status}" in
  start) shift; cmd_start "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  run) cmd_run ;;
  -h | --help | help) sed -n '2,13p' "$0" ;;
  *) tw_die "unknown command '$1' (try: vultr/worker.sh help)" ;;
esac
