#!/bin/bash
# Small looping clips for the use-case grid, all 640x360, 9 s, every frame a keyframe so the shot can seek them.
set -e
D=film/out/uc; mkdir -p $D
E="-nostdin -v error -y -err_detect ignore_err"; O="-an -c:v libx264 -crf 19 -pix_fmt yuv420p -r 30 -g 1"
ffmpeg $E -ss 1.5 -t 9 -i film/in/01-pov.mp4 -vf "scale=640:360" $O $D/love.mp4
ffmpeg $E -ss 0 -t 9 -i film/out/fly-oldhouse-clean.mp4 -vf "scale=640:360" $O $D/home.mp4
ffmpeg $E -ss 0 -t 8 -i film/out/fly-kitchen.mp4 -vf "crop=1600:900:160:0,scale=640:360" $O $D/listing.mp4
ffmpeg $E -ss 15 -t 9 -i film/in/quest/tilted.mp4 -vf "scale=640:360" $O $D/childhood.mp4
ffmpeg $E -ss 15.5 -t 9 -i film/in/quest/foosball.mp4 -vf "scale=640:360" $O $D/gamenight.mp4
ffmpeg $E -ss 0.5 -t 9 -i film/out/roblox-pingpong.mp4 -vf "scale=640:360" $O $D/fun.mp4
