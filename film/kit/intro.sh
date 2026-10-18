#!/bin/sh
# The intro, plain: the Quest POV (from 2 s, native framing), a dip to black, the crying clip (if it's in film/in),
# a dip to black, then the headset coming off at real speed. Original picture and sound, nothing added.
cd "$(dirname "$0")/../.." || exit 1
IN=film/in; OUT=film/out; F=0.6
norm="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1"
part() { # in start dur out fade
  F=${5:-0.6}
  ffmpeg -v error -y -ss "$2" -i "$1" -t "$3" -vf "$norm,fade=t=in:st=0:d=$F,fade=t=out:st=$(echo "$3-$F" | bc -l):d=$F" \
    -af "aresample=48000,afade=t=in:d=0.25,afade=t=out:st=$(echo "$3-$F" | bc -l):d=$F" -ac 2 -c:v libx264 -crf 16 -preset medium -c:a aac -b:a 192k "$4"
}
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
P=$(dur $IN/01-pov.mp4)
part $IN/01-pov.mp4 2.0 "$(echo "$P-2.0" | bc -l)" $OUT/_i1.mp4
LIST="file '_i1.mp4'"
if [ -f $IN/03-crying.mov ]; then
  part $IN/03-crying.mov 0 "$(dur $IN/03-crying.mov)" $OUT/_i2.mp4 0.4
  LIST="$LIST
file '_i2.mp4'"
fi
part $IN/02-headset-off.mov 0 "$(dur $IN/02-headset-off.mov)" $OUT/_i3.mp4 0.5
LIST="$LIST
file '_i3.mp4'"
# join with a re-encode so every part keeps its own timing
set --
N=0
for f in _i1 _i2 _i3; do [ -f "$OUT/$f.mp4" ] && { set -- "$@" -i "$OUT/$f.mp4"; N=$((N+1)); }; done
[ -f $IN/03-crying.mov ] || rm -f $OUT/_i2.mp4
MAP=""; i=0; while [ $i -lt $N ]; do MAP="$MAP[$i:v][$i:a]"; i=$((i+1)); done
ffmpeg -v error -y "$@" -filter_complex "${MAP}concat=n=$N:v=1:a=1[v][a]" -map "[v]" -map "[a]" \
  -c:v libx264 -crf 16 -preset medium -pix_fmt yuv420p -r 30 -c:a aac -b:a 192k -movflags +faststart $OUT/01-intro.mp4 && \
  echo "wrote $OUT/01-intro.mp4 ($(dur $OUT/01-intro.mp4) s)"
