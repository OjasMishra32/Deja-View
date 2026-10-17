"""genfill ceiling: footprint frame and visibility, texture from views, lattice completion, plane splats (numpy only)."""
import math

import numpy as np

import pipeline_helpers  # noqa: F401  (puts pipeline/ on sys.path)
from genfill import ceiling as C
from genfill import geom as G
from genfill.world import TrainCam


def test_footprint_uv_roundtrip_and_inside():
    fp = C.Footprint(41.0, -8.0, 2.5, -7.2, 0.3)
    xz = np.random.default_rng(0).uniform(-10, 10, (100, 2))
    np.testing.assert_allclose(fp.xz(fp.uv(xz)), xz, atol=1e-9)
    c = fp.xz(np.array([[-3.0, -3.0]]))
    assert fp.inside(c)[0] and not fp.inside(fp.xz(np.array([[3.0, -3.0]])))[0]
    assert not fp.inside(fp.xz(np.array([[-7.95, -3.0]])), inset=0.12)[0]


def test_visibility_through_open_side_only():
    fp = C.Footprint(0.0, 0.0, 10.0, 0.0, 6.0, ("v1",))
    tex = np.array([[5.0, 3.0]])
    assert fp.visible_from([5.0, 3.0], tex)[0]          # inside
    assert fp.visible_from([5.0, 9.0], tex)[0]          # in front of the open side
    assert not fp.visible_from([-4.0, 3.0], tex)[0]     # behind the u0 wall
    assert not fp.visible_from([5.0, -3.0], tex)[0]     # behind the v0 wall
    assert fp.visible_from([12.0, 9.0], np.array([[9.0, 5.5]]))[0]   # enters through v1 near the corner
    assert not fp.visible_from([14.0, 6.5], np.array([[9.0, 1.0]]))[0]  # would cross the u1 wall


def _render_plane(cam_c2w, k, tex_fn, h):
    """Ray-cast a textured plane y = h into an image (synthetic training view)."""
    j, i = G.pixel_grid(k)
    d = G.ray_dirs_world(k, cam_c2w, j, i)
    o = cam_c2w[:3, 3]
    t = (h - o[1]) / np.where(np.abs(d[:, 1]) < 1e-9, 1e-9, d[:, 1])
    p = o[None] + t[:, None] * d
    col = tex_fn(p[:, 0], p[:, 2])
    col[t <= 0] = 0
    return (col.reshape(k.height, k.width, 3) * 255).astype(np.uint8)


def test_projection_recovers_a_seen_texture():
    h = 3.0
    def tex_fn(x, z):
        on = (np.floor(x / 0.5) + np.floor(z / 0.5)) % 2 == 0
        return np.where(on[:, None], [0.9, 0.9, 0.9], [0.3, 0.3, 0.3])

    k = G.intrinsics(320, 240, 70)
    cams = []
    for n, (x, z, yaw) in enumerate([(2, 2, 0), (5, 3, 90), (7, 1, 200)]):
        c2w = G.yaw_pitch_c2w([x, 1.6, z], yaw, 60)
        cams.append((TrainCam(f"c{n}", "t", c2w, k), _render_plane(c2w, k, tex_fn, h)))
    fp = C.Footprint(0.0, 0.0, 10.0, 0.0, 6.0, ("v1",))
    grid = C.TexGrid.make(fp, h, 0.05)
    imgs = {c.name: im for c, im in cams}
    proj = C.project_texture(grid, [c for c, _ in cams], lambda c: (imgs[c.name], np.ones(imgs[c.name].shape[:2], bool)),
                             log_every=0)
    seen = C.seen_mask(proj, 0.3)
    assert seen.mean() > 0.05
    uv = grid.centers_uv()
    xz = fp.xz(uv)
    truth = tex_fn(xz[:, 0], xz[:, 1]).reshape(grid.nv, grid.nu, 3)
    # away from the checker edges the projected colour matches the truth
    fx = (xz[:, 0] / 0.5) % 1
    fz = (xz[:, 1] / 0.5) % 1
    interior = ((np.minimum(fx, 1 - fx) > 0.2) & (np.minimum(fz, 1 - fz) > 0.2)).reshape(grid.nv, grid.nu)
    err = np.abs(proj["tex"] - truth).mean(-1)[seen & interior]
    assert np.median(err) < 0.05


def test_lattice_fit_and_fill_continue_the_fittings():
    texel = 0.05
    shape = (120, 200)
    lat = C.Lattice(size_u=24, size_v=3, period_u=40, period_v=30, offset_u=10, offset_v=8)
    cov = C.render_lattice(shape, lat)
    base = np.full(shape + (3,), 0.6, np.float32)
    tex = base * (1 - cov[..., None]) + cov[..., None] * np.array([1.0, 1.0, 1.0], np.float32)
    seen = np.zeros(shape, bool)
    seen[:, :110] = True  # the right part was never seen
    out, info = C.lattice_fill(tex, seen, texel)
    assert info["lattice"] is not None and info["lattice"]["found"] >= 3
    got = out[..., 0][:, 120:] > 0.8
    want = cov[:, 120:] > 0.5
    iou = (got & want).sum() / max((got | want).sum(), 1)
    assert iou > 0.6
    np.testing.assert_allclose(out[seen], tex[seen])


def test_plane_splats_lie_on_the_plane_and_face_down():
    fp = C.Footprint(30.0, 0.0, 1.0, 0.0, 0.5)
    grid = C.TexGrid.make(fp, 3.1, 0.1)
    tex = np.full((grid.nv, grid.nu, 3), 0.8, np.float32)
    s = C.plane_splats(grid, tex, np.ones((grid.nv, grid.nu), bool), 0, merge_levels=0)
    assert len(s) == grid.nu * grid.nv
    merged = C.plane_splats(grid, tex, np.ones((grid.nv, grid.nu), bool), 0)  # uniform: big splats where they fit
    assert len(merged) < len(s) / 2
    np.testing.assert_allclose(merged.means[:, 1], 3.1, atol=1e-6)
    assert fp.inside(merged.means[:, [0, 2]]).all()
    np.testing.assert_allclose(s.means[:, 1], 3.1, atol=1e-6)
    n, flat = C.normals_of(s)
    assert (np.abs(n[:, 1]) > 0.999).all() and (flat < 0.05).all()
    assert fp.inside(s.means[:, [0, 2]]).all()
    np.testing.assert_allclose(s.rgb(), 0.8, atol=1e-5)


def test_dominant_angle_finds_rotated_walls():
    rng = np.random.default_rng(1)
    a = math.radians(37.0)
    t = rng.uniform(0, 8, 2000)
    walls = np.concatenate([np.stack([t, np.zeros_like(t)], 1), np.stack([np.zeros_like(t), t], 1), np.stack([t, np.full_like(t, 6)], 1)])
    walls += rng.normal(0, 0.01, walls.shape)
    rot = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    got = C.dominant_angle(walls @ rot.T)
    assert min(abs(got - 37.0), abs(got - 37.0 + 90), abs(got - 37.0 - 90)) < 1.5


def test_exposure_gains_remove_a_seam_between_views():
    h = 3.0
    def tex_fn(x, z):
        return np.tile([[0.6, 0.6, 0.6]], (len(x), 1))

    k = G.intrinsics(200, 150, 80)
    fp = C.Footprint(0.0, 0.0, 6.0, 0.0, 4.0, ("v1",))
    cams, imgs = [], {}
    for n, (x, yaw, gain) in enumerate([(2.8, 0, 1.0), (3.2, 0, 0.7)]):  # overlapping views
        c2w = G.yaw_pitch_c2w([x, 1.6, 2.0], yaw, 75)
        im = (_render_plane(c2w, k, tex_fn, h).astype(np.float32) * gain).astype(np.uint8)
        cams.append(TrainCam(f"c{n}", "t", c2w, k))
        imgs[f"c{n}"] = im
    grid = C.TexGrid.make(fp, h, 0.05)
    load = lambda c: (imgs[c.name], np.ones(imgs[c.name].shape[:2], bool))  # noqa: E731
    raw = C.project_texture(grid, cams, load, log_every=0, gain_iters=0)
    fixed = C.project_texture(grid, cams, load, log_every=0, gain_iters=2)
    seen = C.seen_mask(raw, 0.3)
    spread = lambda t: float(np.ptp(t.mean(-1)[seen]))  # noqa: E731
    assert spread(fixed["tex"]) < 0.5 * spread(raw["tex"])


def test_open_edge_row_finds_where_the_ceiling_ends():
    tex = np.full((100, 40, 3), 0.7, np.float32)
    tex[80:] = 0.1  # the night beyond the roof edge, projected onto the plane
    seen = np.ones((100, 40), bool)
    assert C.open_edge_row(tex, seen) == 79


def test_clear_zone_keeps_walls_and_outside():
    import splat_io as sio

    fp = C.Footprint(0.0, 0.0, 4.0, 0.0, 4.0)
    pts = np.array([[2.0, 3.0, 2.0],    # smear under the ceiling, middle: removed
                    [2.0, 1.0, 2.0],    # furniture height: kept
                    [0.05, 3.0, 2.0],   # inside the wall inset: kept
                    [6.0, 3.0, 2.0],    # outside: kept
                    [3.0, 3.0, 3.0]])   # over a protected (pillar) cell: kept
    s = sio.Splats.from_rgb(pts, [0.5, 0.5, 0.5], 0.05)
    drop = C.clear_zone(s, fp, 3.2, 2.3, 0.12, protect={(30, 30)})
    assert drop.tolist() == [True, False, False, False, False]


def test_height_sweep_finds_the_plane_the_views_agree_on():
    h = 3.1
    def tex_fn(x, z):
        on = (np.floor(x / 0.4) + np.floor(z / 0.3)) % 2 == 0
        return np.where(on[:, None], [0.9, 0.9, 0.9], [0.2, 0.2, 0.2])

    k = G.intrinsics(240, 180, 70)
    fp = C.Footprint(0.0, 0.0, 8.0, 0.0, 6.0, ("v1",))
    cams, imgs = [], {}
    for n, (x, z, yaw) in enumerate([(3.5, 3.5, 0), (4.5, 3.5, 90), (4.0, 2.5, 180), (4.0, 4.5, 270)]):
        c2w = G.yaw_pitch_c2w([x, 1.6, z], yaw, 50)
        cams.append(TrainCam(f"c{n}", "t", c2w, k))
        imgs[f"c{n}"] = _render_plane(c2w, k, tex_fn, h)
    load = lambda c: (imgs[c.name], np.ones(imgs[c.name].shape[:2], bool))  # noqa: E731
    rows = C.sweep_height(fp, cams, load, np.arange(2.9, 3.31, 0.05), texel=0.05, image_scale=1.0)
    best = min(rows, key=lambda r: r["score"])["height"]
    assert abs(best - h) < 0.03


def test_fittings_are_boxes_hanging_where_the_lattice_says():
    fp = C.Footprint(30.0, 0.0, 8.0, 0.0, 6.0)
    grid = C.TexGrid.make(fp, 3.2, 0.05)
    lat = C.Lattice(size_u=24, size_v=3, period_u=40, period_v=50, offset_u=20, offset_v=30, rows=[0, 1])
    cen = C.fitting_centres(lat, grid)
    assert len(cen) == 2 * 4  # two rows, columns at 20, 60, 100, 140 texels (all inside the 160-texel width)
    uv = fp.uv(np.array(cen))
    np.testing.assert_allclose(sorted(set(np.round(uv[:, 1], 3))), [1.525, 4.025], atol=1e-6)
    s = C.fitting_splats(cen, fp.angle, 0.0, 1.2, 0.12, 3.0, 3.2, [0.95, 0.95, 0.95])
    assert s.means[:, 1].min() >= 2.99 and s.means[:, 1].max() <= 3.2
    bottom = s.means[:, 1] < 3.005
    assert (s.rgb()[bottom].mean(1) > 0.75).all()  # the diffuser is the bright face, underneath
    # every splat stays within its fitting's footprint
    d = np.min(np.linalg.norm(s.means[:, None, [0, 2]] - np.array(cen)[None], axis=2), axis=1)
    assert d.max() <= 0.62


def test_plane_merge_keeps_detail_where_the_colour_changes():
    fp = C.Footprint(0.0, 0.0, 1.6, 0.0, 1.6)
    grid = C.TexGrid.make(fp, 3.0, 0.05)
    tex = np.full((grid.nv, grid.nu, 3), 0.7, np.float32)
    tex[10:12, :] = 1.0  # a thin bright fitting across the middle
    s = C.plane_splats(grid, tex, np.ones((grid.nv, grid.nu), bool), 0)
    bright = s.rgb().mean(1) > 0.95
    v = fp.uv(s.means[:, [0, 2]])[:, 1]
    assert bright.sum() >= grid.nu / 2 and ((v[bright] > 0.5) & (v[bright] < 0.6)).all()
    # no grey splat straddles the fitting: those touching it stay small
    near = ~bright & (np.abs(v - 0.55) < 0.12)
    assert (s.scales[near][:, 0] <= 0.75 * 0.1 + 1e-6).all()
    assert len(s) < grid.nu * grid.nv / 3
