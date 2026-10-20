#!/usr/bin/env python3
"""The film, cut from every piece: each shot is trimmed, sped up where it helps, scaled to 1920x1080 at 30 fps, given
its labels (and Shivin's view in the corner over Tilted Towers), and its own sound only where the sound matters (the
intro, and Gemini answering out loud in the headset). Then the shots are joined with dissolves inside a section and
dips to black between sections.

  python3 film/kit/edit.py            -> film/out/edit/NN-id.mp4 and film/out/dejaview-film.mp4
  python3 film/kit/edit.py --plan     -> print the timeline only
"""
import hashlib, json, os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
OUT = os.path.join(ROOT, 'film/out/edit')
LBL = os.path.join(ROOT, 'film/out/labels')
MOV = os.path.expanduser('~/Movies/DejaView-film')
Q = os.path.join(ROOT, 'film/in/quest')

def p(*a): return os.path.join(ROOT, *a)

INTRO, SITE, POV = p('film/out/01-intro.mp4'), p('film/out/site.mp4'), p('film/in/01-pov.mp4')
SHIVIN = f'{Q}/shivin-view.mov'
CH, FO, KI, TI = f'{Q}/chess.mp4', f'{Q}/foosball.mp4', f'{Q}/kitchen.mp4', f'{Q}/tilted.mp4'

def L(name, a=0.3, b=None, fin=True, fout=True):
    return dict(png=f'{LBL}/{name}.png', a=a, b=b, fin=fin, fout=fout)

# x = the transition into this shot: (kind, seconds)
SHOTS = [
    # 1. Why: Shivin's dad, in the headset; the tears; the headset comes off
    dict(id='intro', src=INTRO, a=0, b=16.17, audio='raw'),
    # 2. What: the site explains it in one scroll
    dict(id='site', src=SITE, a=0, b=28.0, speed=1.3, x=('fadeblack', 0.7)),
    # 3. Hop in: the headset goes on; one link
    dict(id='suit-up', src=SHIVIN, a=10.0, b=16.0, x=('fade', 0.5)),
    dict(id='laptop', src=CH, a=1.5, b=8.6, speed=1.25, labels=[L('hopin', 0.4)], x=('fade', 0.4)),
    # 4. Walk in: a use for every place, and Gemini answering out loud
    dict(id='foos-open', src=FO, a=3.0, b=9.8, speed=1.2, x=('fade', 0.4)),
    dict(id='foos-walk', src=FO, a=15.5, b=21.5, audio='low', labels=[L('foosball')], x=('fade', 0.3)),
    dict(id='foos-ask', src=FO, a=42.0, b=44.3, audio='keep', labels=[L('gemini', 0.15, fout=False)], x=('fade', 0.3)),
    dict(id='foos-answer', src=FO, a=52.6, b=59.6, audio='keep', labels=[L('gemini', 0, fin=False)], x=('fade', 0.2)),
    dict(id='kitchen-walk', src=KI, a=31.5, b=39.5, speed=1.15, audio='low', labels=[L('kitchen')], x=('fade', 0.4)),
    dict(id='kitchen-ask', src=KI, a=56.9, b=59.7, audio='keep', labels=[L('gemini', 0.15, fout=False)], x=('fade', 0.3)),
    dict(id='kitchen-answer', src=KI, a=67.2, b=73.4, audio='keep', labels=[L('gemini', 0, fin=False)], x=('fade', 0.2)),
    dict(id='tilted-welcome', src=TI, a=11.3, b=20.0, audio='keep', labels=[L('tilted', 0.3, 4.8), L('pip', 0.5, fout=False)],
         pip=dict(src=SHIVIN, a=16.5, fin=True), x=('fade', 0.4)),
    dict(id='tilted-ask', src=TI, a=25.3, b=27.0, audio='keep', labels=[L('gemini', 0.1, fout=False), L('pip', 0, fin=False, fout=False)],
         pip=dict(src=SHIVIN, a=25.2), x=('fade', 0.2)),
    dict(id='tilted-answer', src=TI, a=33.5, b=37.6, audio='keep', labels=[L('gemini', 0, fin=False), L('pip', 0, fin=False)],
         pip=dict(src=SHIVIN, a=26.9, fout=True), x=('fade', 0.2)),
    dict(id='old-house', src=p('film/out/fly-oldhouse-clean.mp4'), a=0.6, b=5.8, labels=[L('oldhouse', 0.3)], x=('fade', 0.4)),
    dict(id='chess-open', src=CH, a=10.5, b=16.2, audio='low', labels=[L('chess')], x=('fade', 0.4)),
    dict(id='chess-answer', src=CH, a=36.8, b=44.6, audio='keep', labels=[L('gemini', 0.2)], x=('fade', 0.3)),
    dict(id='red-figure', src=CH, a=20.3, b=24.0, audio='low', labels=[L('crossplay', 0.2)], x=('fade', 0.4)),
    # 5. Playable: the splat becomes a Roblox room; one table, two worlds
    dict(id='to-roblox', src=p('film/out/toroblox.mp4'), a=0, b=11, x=('fadeblack', 0.5)),
    dict(id='physics', src=p('film/out/physics.mp4'), a=0.6, b=7.2, x=('fade', 0.4)),
    dict(id='rally', src=p('film/out/roblox-pingpong.mp4'), a=0.3, b=10.3, labels=[L('roblox', 0.4)], x=('fade', 0.4)),
    # 6. Honest: what was really there
    dict(id='reality', src=p('film/out/reality.mp4'), a=0.3, b=10.8, x=('fadeblack', 0.6)),
    # 7. Yours: what it's for; add a memory at the link; how it travels
    dict(id='use-cases', src=p('film/out/usecases.mp4'), a=0, b=9.5, x=('fadeblack', 0.6)),
    dict(id='upload', src=p('film/out/upload.mp4'), a=0.8, b=15.2, speed=1.5, labels=[L('url', 0.3)], x=('fadeblack', 0.5)),
    dict(id='flow', src=p('film/out/flow.mp4'), a=0, b=10, x=('fadeblack', 0.5)),
    # 8. Under the hood
    dict(id='cameras', src=f'{MOV}/32a Cameras.mp4', a=0, b=6.2, x=('fadeblack', 0.6)),
    dict(id='training', src=f'{MOV}/32b Training.mp4', a=0, b=6.2, x=('fade', 0.4)),
    dict(id='splats', src=f'{MOV}/30 Splats.mp4', a=0, b=8.4, x=('fade', 0.4)),
    dict(id='one-photo', src=f'{MOV}/31 One photo.mp4', a=0, b=8.2, x=('fade', 0.4)),
    dict(id='gaps', src=f'{MOV}/33 Gaps.mp4', a=0, b=8.0, x=('fade', 0.4)),
    dict(id='people', src=f'{MOV}/34 People.mp4', a=0, b=8.0, x=('fade', 0.4)),
    # 9. Back to him
    dict(id='dad', src=POV, a=3.0, b=9.0, speed=0.8, audio='low', x=('fadeblack', 0.8)),
    dict(id='end-card', src=f'{MOV}/42 End card.mp4', a=0.6, b=9.0, x=('fadeblack', 0.8)),
]

PIP_W, PIP_H, PIP_X, PIP_Y, R = 560, 315, 1920 - 96 - 560, 150, 22

def has_audio(src):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', src],
                       capture_output=True, text=True)
    return bool(r.stdout.strip())

def dur(s): return (s['b'] - s['a']) / s.get('speed', 1.0)

def key(s):
    blob = json.dumps(s, sort_keys=True, default=str)
    for lb in s.get('labels', []): blob += str(os.path.getmtime(lb['png']))
    for f in [s['src']] + ([s['pip']['src']] if 'pip' in s else []): blob += str(os.path.getmtime(f))
    return hashlib.sha1(blob.encode()).hexdigest()[:8]

def seg_file(s): return f'{OUT}/{s["id"]}-{key(s)}.mp4'

def render(i, s):
    out = seg_file(s)
    D, sp = dur(s), s.get('speed', 1.0)
    args = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-err_detect', 'ignore_err', '-fflags', '+discardcorrupt',
            '-ss', f'{s["a"]}', '-t', f'{s["b"] - s["a"]}', '-i', s['src']]
    g = [f'[0:v]setpts=(PTS-STARTPTS)/{sp},scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,'
         f'fps=30,format=yuv420p,setsar=1[v0]']
    cur, n = 'v0', 1
    if 'pip' in s:
        pp = s['pip']
        args += ['-err_detect', 'ignore_err', '-ss', f'{pp["a"]}', '-t', f'{D + 0.2}', '-i', pp['src']]
        a = (f'[{n}:v]setpts=PTS-STARTPTS,scale={PIP_W}:{PIP_H}:force_original_aspect_ratio=increase,crop={PIP_W}:{PIP_H},fps=30,'
             f"format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
             f"a='255*lte(hypot(max(0,abs(X-W/2)-(W/2-{R})),max(0,abs(Y-H/2)-(H/2-{R}))),{R})'")
        if pp.get('fin'): a += ',fade=t=in:st=0.4:d=0.5:alpha=1'
        if pp.get('fout'): a += f',fade=t=out:st={D - 0.6:.3f}:d=0.5:alpha=1'
        g.append(a + '[pip]')
        g.append(f'[{cur}][pip]overlay={PIP_X}:{PIP_Y}:shortest=0:eof_action=pass[vp]')
        cur, n = 'vp', n + 1
    for k, lb in enumerate(s.get('labels', [])):
        args += ['-loop', '1', '-t', f'{D}', '-i', lb['png']]
        b = lb['b'] if lb['b'] is not None else D
        f = f'[{n}:v]format=rgba'
        if lb['fin']: f += f',fade=t=in:st={lb["a"]}:d=0.35:alpha=1'
        if lb['fout']: f += f',fade=t=out:st={max(0, b - 0.35):.3f}:d=0.35:alpha=1'
        g.append(f + f'[l{k}]')
        g.append(f'[{cur}][l{k}]overlay=0:0:format=auto[v{k + 10}]')
        cur, n = f'v{k + 10}', n + 1
    g.append(f'[{cur}]format=yuv420p[v]')
    mode = s.get('audio', 'mute')
    if mode != 'mute' and has_audio(s['src']):
        chain = f'[0:a:0]asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo'
        if sp != 1.0: chain += f',atempo={sp}'
        if mode in ('keep', 'low'): chain += ',loudnorm=I=-18:TP=-2:LRA=11,aresample=48000'
        if mode == 'low': chain += ',volume=0.3'
        chain += f',aresample=48000,apad,atrim=0:{D:.3f},afade=t=in:d=0.12,afade=t=out:st={max(0, D - 0.15):.3f}:d=0.15[a]'
        g.append(chain)
    else:
        args += ['-f', 'lavfi', '-t', f'{D}', '-i', 'anullsrc=r=48000:cl=stereo']
        g.append(f'[{n}:a]anull[a]')
    args += ['-filter_complex', ';'.join(g), '-map', '[v]', '-map', '[a]', '-t', f'{D:.3f}',
             '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '30',
             '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', out]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'{s["id"]}: {r.stderr[-2000:]}')
    return out

def plan():
    t, rows = 0.0, []
    for i, s in enumerate(SHOTS):
        xd = s.get('x', (None, 0))[1] if i else 0
        t -= xd
        rows.append((i, s['id'], t, dur(s)))
        t += dur(s)
    return rows, t

def main():
    rows, total = plan()
    for i, sid, st, d in rows:
        print(f'{i:02d} {int(st // 60)}:{st % 60:05.2f}  {d:5.2f}s  {sid}')
    print(f'total {int(total // 60)}:{total % 60:05.2f}')
    if '--plan' in sys.argv:
        return
    os.makedirs(OUT, exist_ok=True)
    only = [a for a in sys.argv[1:] if not a.startswith('--')]
    files = []
    for i, s in enumerate(SHOTS):
        f = seg_file(s)
        if (only and s['id'] in only) or not os.path.exists(f):
            render(i, s)
            print('rendered', s['id'], flush=True)
        files.append(f)
    # join: dissolves inside a section, dips to black between sections
    args = ['ffmpeg', '-nostdin', '-v', 'error', '-y']
    for f in files: args += ['-i', f]
    g, vcur, acur, off = [], '0:v', '0:a', dur(SHOTS[0])
    for i in range(1, len(SHOTS)):
        kind, xd = SHOTS[i]['x']
        g.append(f'[{vcur}][{i}:v]xfade=transition={kind}:duration={xd}:offset={off - xd:.3f}[xv{i}]')
        g.append(f'[{acur}][{i}:a]acrossfade=d={xd}:c1=tri:c2=tri[xa{i}]')
        vcur, acur = f'xv{i}', f'xa{i}'
        off += dur(SHOTS[i]) - xd
    master = p('film/out/dejaview-film.mp4')
    args += ['-filter_complex', ';'.join(g), '-map', f'[{vcur}]', '-map', f'[{acur}]',
             '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-r', '30',
             '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', master]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode:
        sys.exit(r.stderr[-3000:])
    json.dump([dict(id=sid, start=round(st, 2), dur=round(d, 2)) for _, sid, st, d in rows],
              open(p('film/out/edit/timeline.json'), 'w'), indent=1)
    print('wrote', master)

if __name__ == '__main__':
    main()
