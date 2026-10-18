#!/bin/sh
# Add the intro's sound: the memory's voices fading with a soft echo as it dissolves, then the room, slowed with the picture.
cd "$(dirname "$0")/../.." || exit 1
A=film/assets/intro
ffmpeg -v error -y -i film/out/intro.mp4 -i $A/pov.wav -i $A/off.wav -filter_complex \
 "[1:a]volume=3.2,afade=t=in:d=0.6,apad=pad_dur=4,aecho=0.8:0.6:220|430:0.3|0.18,afade=t=out:st=5.6:d=3.0,atrim=0:9.7[m]; \
  [2:a]atempo=0.7,volume=0.55,afade=t=in:d=0.8,adelay=9700|9700[r]; \
  [m][r]amix=inputs=2:duration=longest:normalize=0,apad,atrim=0:20[a]" \
 -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest film/out/intro-sound.mp4 && echo "wrote film/out/intro-sound.mp4"
