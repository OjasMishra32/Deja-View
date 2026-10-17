import numpy as np

from tw import mask as M
from tw.plate import build_plate, fill_holes, masked_temporal_median, mirror_fill_rows


def _scene(n=21, h=40, w=60, seed=0):
    rng = np.random.default_rng(seed)
    bg = rng.integers(40, 200, (h, w, 3), dtype=np.uint8)
    frames = np.repeat(bg[None], n, 0).copy()
    return bg, frames


def test_masked_median_matches_bruteforce():
    rng = np.random.default_rng(1)
    f = rng.integers(0, 255, (15, 9, 11, 3), dtype=np.uint8)
    ex = rng.random((15, 9, 11)) < 0.4
    med, cnt = masked_temporal_median(f, ex, chunk_rows=4)
    for y in range(9):
        for x in range(11):
            ok = ~ex[:, y, x]
            assert cnt[y, x] == ok.sum()
            if ok.any():
                v = np.sort(f[ok, y, x], axis=0)[(ok.sum() - 1) // 2]
                assert np.array_equal(med[y, x], v)


def test_median_removes_moving_object():
    bg, frames = _scene()
    for i in range(len(frames)):  # a box sweeping across, covering each pixel < half the time
        x = 2 * i
        frames[i, 10:30, x : x + 8] = (255, 0, 0)
    med, _ = masked_temporal_median(frames)
    assert np.abs(med.astype(int) - bg).max() <= 1


def test_person_standing_still_is_excluded_and_hole_filled():
    bg, frames = _scene(n=12)
    person = np.zeros(frames.shape[:3], np.float32)
    frames[:, 5:35, 20:30] = (250, 10, 10)  # never moves: a plain median would keep it
    person[:, 5:35, 20:30] = 1.0
    plate, holes, stats = build_plate(frames, person, person_dilate_frac=0.02)
    assert holes[20, 25] and stats["holeFrac"] > 0.05
    assert plate[20, 25, 0] < 240 or plate[20, 25, 1] > 30  # the red person is gone
    assert np.abs(plate[2, 2].astype(int) - bg[2, 2]).max() <= 1  # untouched elsewhere


def test_person_moving_reveals_background():
    bg, frames = _scene(n=20)
    person = np.zeros(frames.shape[:3], np.float32)
    for i in range(20):
        x = 2 + (i % 10) * 5
        frames[i, 5:35, x : x + 6] = (250, 10, 10)
        person[i, 5:35, x : x + 6] = 1.0
    plate, holes, _ = build_plate(frames, person, person_dilate_frac=0.0)
    assert not holes.any()
    assert np.abs(plate.astype(int) - bg).max() <= 1


def test_mirror_fill_continues_stripes():
    h, w = 10, 40
    img = np.zeros((h, w, 3), np.uint8)
    img[:, ::4] = 255  # vertical stripes every 4 px
    holes = np.zeros((h, w), bool)
    holes[:, 18:22] = True
    out = mirror_fill_rows(img, holes)
    assert not np.array_equal(out[:, 18:22], np.zeros((h, 4, 3), np.uint8))
    filled = fill_holes(img, holes)
    assert filled.shape == img.shape and filled.dtype == np.uint8


def test_diff_soft_finds_change_and_ignores_exposure():
    rng = np.random.default_rng(2)
    plate = rng.integers(60, 180, (60, 80, 3), dtype=np.uint8)
    frame = np.clip(plate.astype(np.float32) * 1.12, 0, 255).astype(np.uint8)  # auto exposure
    frame[20:40, 30:50] = (255, 255, 0)
    d, thr = M.diff_soft(frame, plate)
    assert d[30, 40] > 0.9
    assert (d > 0.5).mean() < 0.12  # exposure change alone is not foreground
    assert d[5, 5] < 0.5


def test_cleanup_keeps_utensil_attached_to_person_and_drops_specks():
    h, w = 120, 160
    person = np.zeros((h, w), np.float32)
    person[30:100, 60:90] = 1.0
    b = person > 0.5
    b = b.copy()
    b[60:62, 90:130] = True  # thin spatula held out from the body (2 px wide)
    b[10, 10] = True  # isolated speck
    b[50:55, 70:75] = False  # hole inside the body
    out = M.cleanup(b, person)
    assert out[61, 120]  # spatula kept
    assert not out[10, 10]  # speck removed
    assert out[52, 72]  # hole filled


def test_temporal_decide_fills_dropout_and_keeps_fast_motion():
    a = np.zeros((10, 10), np.float32)
    on = np.ones((10, 10), np.float32)
    # a one-frame dropout in the middle of an otherwise present region is filled
    out = M.temporal_decide(a, [on, on, a, on, on], [1, 2, 3, 2, 1])
    assert out.all()
    # something seen only in the current frame (a fast hand) is kept
    fast = np.zeros((10, 10), np.float32)
    fast[2:4, 2:4] = 1
    out = M.temporal_decide(fast, [a, a, fast, a, a], [1, 2, 3, 2, 1])
    assert out[3, 3] and not out[8, 8]


def test_feather_is_opaque_inside_and_soft_outside():
    b = np.zeros((30, 30), bool)
    b[10:20, 10:20] = True
    f = M.feather(b, sigma=1.0)
    assert f.dtype == np.uint8
    assert (f[b] == 255).all()
    assert 0 < f[9, 15] < 255 and f[0, 0] == 0
