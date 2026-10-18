#!/bin/zsh
# The demo site on this Mac, kept up: the Gemini guide (port 8795), the server (8787 https, 8788 http) and the
# deja-view.photo tunnel, each in its own detached screen session so they outlive the shell that started them.
#
#   scripts/serve-demo.sh          start whatever is not running
#   scripts/serve-demo.sh restart  restart all three
#   scripts/serve-demo.sh watch    start them, keep the Mac awake, and every 30 s restart any piece that stopped
#                                  answering (run it in its own screen: screen -dmS dv-watch scripts/serve-demo.sh watch)
#   scripts/serve-demo.sh status   what is up
#
# Logs: data/tmp/questtest/server.log, data/tmp/guide.log, data/tmp/tunnel.log, data/tmp/watch.log.
# The tunnel token is read from ~/.dejaview-tunnel-token by scripts/tunnel.ts; the guide key from integrations/guide/.env.
set -u
cd "$(dirname "$0")/.."

up() { screen -ls 2>/dev/null | grep -q "\.$1[[:space:]]"; }
quit() { screen -S "$1" -X quit >/dev/null 2>&1; }
# Quitting a screen session does not stop bun, so whatever still listens on the port goes too.
free_port() {
	local p
	p=$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null)
	[ -n "$p" ] && kill $p 2>/dev/null && sleep 1
	p=$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null)
	[ -n "$p" ] && kill -9 $p 2>/dev/null
	return 0
}

start_guide() {
	quit dv-guide
	free_port 8795
	screen -dmS dv-guide zsh -c 'cd integrations/guide && exec node --env-file=.env server.mjs >> ../../data/tmp/guide.log 2>&1'
}
start_server() {
	quit dv-server
	free_port 8787
	free_port 8788
	local gk
	gk=$(grep '^GUIDE_KEY=' integrations/guide/.env | cut -d= -f2)
	screen -dmS dv-server env THIRDWHEEL_UNLISTED=oh-cand- GUIDE_URL=http://127.0.0.1:8795 GUIDE_KEY="$gk" \
		THIRDWHEEL_ALLOWED_ORIGINS=https://deja-view.photo THIRDWHEEL_HTTPS=1 THIRDWHEEL_READONLY=1 THIRDWHEEL_HPG=off PORT=8787 \
		zsh -c 'exec bun server/index.ts >> data/tmp/questtest/server.log 2>&1'
}
start_tunnel() {
	quit dv-tunnel
	pkill -f 'bun scripts/tunnel.ts' 2>/dev/null
	pkill -f 'cloudflared tunnel.* run' 2>/dev/null
	sleep 1
	screen -dmS dv-tunnel env TUNNEL_TOKEN_FILE="$HOME/.dejaview-tunnel-token" TUNNEL_HOSTNAME=deja-view.photo \
		TUNNEL_TARGET=https://localhost:8787 TUNNEL_URL_FILE=data/tmp/domain-url.txt TUNNEL_PROBE=0 TUNNEL_WATCHDOG=0 \
		zsh -c 'exec bun scripts/tunnel.ts >> data/tmp/tunnel.log 2>&1'
}

guide_ok() { curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8795/health | grep -q 200; }
server_ok() { curl -sk -m 8 -o /dev/null -w '%{http_code}' https://localhost:8787/api/scenes | grep -q 200; }
site_ok() { curl -s -m 10 -o /dev/null -w '%{http_code}' https://deja-view.photo/api/scenes | grep -q 200; }

log() { print -r -- "$(date '+%F %T') $*" >> data/tmp/watch.log; }

start_missing() {
	up dv-guide || start_guide
	up dv-server || start_server
	up dv-tunnel || start_tunnel
}

case "${1:-start}" in
start)
	start_missing
	;;
restart)
	start_guide; start_server; start_tunnel
	;;
status)
	for s in dv-guide dv-server dv-tunnel dv-watch; do up $s && echo "$s running" || echo "$s not running"; done
	guide_ok && echo "guide answers" || echo "guide does not answer"
	server_ok && echo "server answers" || echo "server does not answer"
	site_ok && echo "deja-view.photo answers" || echo "deja-view.photo does not answer"
	;;
watch)
	# no idle or system sleep while this runs (on battery the Mac may still sleep; keep it plugged in, lid open)
	caffeinate -dimsu -w $$ &
	start_missing
	log "watch started"
	misses=0
	while true; do
		sleep 30
		if ! guide_ok; then log "guide down: restarting"; start_guide; fi
		if ! server_ok; then log "server down: restarting"; start_server; sleep 8; fi
		if ! up dv-tunnel; then log "tunnel gone: restarting"; start_tunnel; fi
		# the site through the tunnel: restart the tunnel after two misses in a row while the server itself is fine
		if server_ok && ! site_ok; then
			misses=$((misses + 1))
			if [ $misses -ge 2 ]; then log "site unreachable: restarting the tunnel"; start_tunnel; misses=0; fi
		else
			misses=0
		fi
	done
	;;
*)
	echo "usage: scripts/serve-demo.sh [start|restart|watch|status]" >&2
	exit 2
	;;
esac
