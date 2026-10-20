#!/bin/bash
# The four clips for the splat-to-Roblox comparison: the same two rooms as our splat and as the Roblox game.
set -e
D=film/out/s2r; mkdir -p $D
E="-nostdin -v error -y"; O="-an -c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 -g 1"
ffmpeg $E -ss 0.5 -t 6 -i film/out/fly-courts.mp4 -vf "scale=960:540" $O $D/lawn-splat.mp4
ffmpeg $E -ss 1.0 -t 6 -i film/in/roblox/pingpong-take1.mov -vf "crop=2240:1260:700:420,scale=960:540" $O $D/lawn-rbx.mp4
ffmpeg $E -ss 2 -t 6 -i film/out/fly-chess.mp4 -vf "scale=960:540" $O $D/chess-splat.mp4
ffmpeg $E -ss 3 -t 6 -i film/in/roblox/chess-take2.mov -vf "crop=2738:1540:340:400,scale=960:540" $O $D/chess-rbx.mp4
