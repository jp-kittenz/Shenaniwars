# Normalised models -> low-poly rigged parts in the game's paint-key format (one packed binary for the game).
import sys, os, json, struct, re, numpy as np, fast_simplification
from scipy.spatial import cKDTree
D = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, D)
# paint classes (index -> kit key); the game maps them to colours and camo
CLS = ['PAINT', 'PAINT2', 'TEAM', 'DARK', 'STEEL', 'RUBBER', 'GLASS', 'LENS', 'LAMP', 'TRACK']
C = {k: i for i, k in enumerate(CLS)}

def load(key):
    d = np.load(f'{D}/norm/{key}.npz')
    return d['tri'].astype(np.float64), d['col'].astype(np.float64), d['mid'], d['names'], d['mats']

def lum(c): return c @ np.array([0.2126, 0.7152, 0.0722])
def normals(tri):
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); l = np.linalg.norm(n, axis=1, keepdims=True); return n / np.maximum(l, 1e-12), l[:, 0] / 2

def paint_classes(tri, col, mats_of_tri, aircraft):
    L = lum(col); cls = np.full(len(tri), C['PAINT'], np.int8)
    sat = col.max(1) - col.min(1)
    glass = np.array([bool(re.search(r'glass|okna|transparent|canopy|\|op', m, re.I)) for m in mats_of_tri])
    dk = min(0.07, 0.45 * float(np.median(L)))
    cls[L < dk] = C['DARK']
    cls[(L >= dk) & (L < dk * 1.8) & (sat < 0.05)] = C['STEEL']
    cls[glass] = C['GLASS']
    return cls

def detect_wheels(tri, col, R, xmin, zs=None, tol=1.02):
    """Wheels around given axle stations: tyre (dark) geometry fixes each wheel's centre, radius and width."""
    cen = tri.mean(1); L = lum(col) if col is not None else np.zeros(len(tri))
    low = (cen[:, 1] < 2.6 * R) & (np.abs(cen[:, 0]) > xmin)
    axles = []; mask = np.zeros(len(tri), bool)
    for z0 in zs:
        win = low & (np.abs(cen[:, 2] - z0) < R * 1.4)
        tyre = win & (L < 0.2)
        if tyre.sum() < 10: tyre = win
        T = tri[tyre]
        zc = (np.percentile(T[:, :, 2], 1) + np.percentile(T[:, :, 2], 99)) / 2
        if abs(zc - z0) > 0.4 * R: zc = z0
        r = np.percentile(T[:, :, 1], 99) / 2
        r = float(np.clip(r, R * 0.7, R * 1.25))
        xin = np.percentile(np.abs(T[:, :, 0]), 2) - 0.03
        xout = np.percentile(np.abs(T[:, :, 0]), 99.5) + 0.02
        d = np.sqrt((tri[:, :, 2] - zc) ** 2 + (tri[:, :, 1] - r) ** 2).max(1)
        ax = np.abs(tri[:, :, 0])
        wm = (d < r * tol) & (ax.min(1) > xin) & (ax.max(1) < xout)
        mask |= wm; axles.append((float(zc), float(r), float(r), float((xin + xout) / 2), float(xout - xin)))
    return axles, mask

def decimate(tri, cls, target):
    """Per paint class: weld, quadric-decimate to a share of the target, re-label by nearest original face."""
    if len(tri) == 0: return tri, cls
    out_t, out_c = [], []
    tot = len(tri)
    for k in np.unique(cls):
        m = cls == k; T = tri[m]
        want = max(4, int(target * len(T) / tot))
        if len(T) <= want: out_t.append(T); out_c.append(np.full(len(T), k, np.int8)); continue
        V = T.reshape(-1, 3); q = np.round(V / 2e-3).astype(np.int64)
        uq, inv = np.unique(q, axis=0, return_inverse=True); inv = inv.reshape(-1)
        P = np.zeros((len(uq), 3)); np.add.at(P, inv, V); P /= np.bincount(inv)[:, None]
        F = inv.reshape(-1, 3); F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
        if len(F) == 0: continue
        try:
            P2, F2 = fast_simplification.simplify(P.astype(np.float32), F.astype(np.int32), target_reduction=float(np.clip(1 - want / len(F), 0, 0.995)), agg=7)
        except Exception as ex:
            P2, F2 = P, F
        R = P2[F2].astype(np.float64)
        if len(R) > want * 1.4: R = cluster(R, want)
        out_t.append(R); out_c.append(np.full(len(R), k, np.int8))
    return np.concatenate(out_t), np.concatenate(out_c)

def cluster(T, want):
    """Vertex clustering for triangle soups the quadric decimator cannot reduce: snap to a grid, drop collapsed
    and duplicate faces; the cell grows until the face count fits."""
    ext = np.ptp(T.reshape(-1, 3), axis=0).max()
    cell = ext / 120
    for _ in range(14):
        V = T.reshape(-1, 3); q = np.floor(V / cell).astype(np.int64)
        uq, inv = np.unique(q, axis=0, return_inverse=True); inv = inv.reshape(-1)
        P = np.zeros((len(uq), 3)); np.add.at(P, inv, V); P /= np.bincount(inv)[:, None]
        F = inv.reshape(-1, 3); F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
        F = np.unique(np.sort(F, axis=1), axis=0) if len(F) else F
        if len(F) <= want * 1.2 or cell > ext / 8: return P[F]
        cell *= 1.35
    return P[F]

def shade_ao(tri, cls, col_l, H, ground=True):
    n, area = normals(tri)
    y = tri[:, :, 1]
    ao = np.ones((len(tri), 3))
    if ground:
        ao *= 0.6 + 0.4 * np.clip(y / max(0.45 * H, 0.3), 0, 1) ** 0.7
        ao[n[:, 1] < -0.45] *= 0.62
    else:
        ao[n[:, 1] < -0.5] *= 0.85
    shade = np.clip(col_l, 0.8, 1.12)[:, None]
    return np.clip(ao * shade, 0.3, 1.15)

class Part:
    def __init__(s, name, tri, cls, pivot=(0, 0, 0), extra=None):
        s.name, s.tri, s.cls, s.pivot, s.extra = name, tri, cls, np.array(pivot, np.float64), extra or {}

def pack(models, out_bin):
    header = {}; bufs = []; off = 0
    def add(b):
        nonlocal off
        pad = (-len(b)) % 4; bufs.append(b + b'\0' * pad); o = off; off += len(b) + pad; return o
    for key, M in models.items():
        parts = []
        for p in M['parts']:
            V = (p.tri - p.pivot).reshape(-1, 3).astype(np.float32)
            lo, hi = V.min(0), V.max(0); sc = np.maximum(hi - lo, 1e-4) / 65535
            q = np.round((V - lo) / sc).astype(np.uint16)
            ao = np.clip(np.round(p.ao.reshape(-1) * 200), 0, 255).astype(np.uint8)
            parts.append(dict(name=p.name, n=len(p.tri), lo=lo.round(5).tolist(), sc=sc.tolist(), pivot=p.pivot.round(4).tolist(),
                              pos=add(q.tobytes()), cls=add(p.cls.astype(np.uint8).tobytes()), ao=add(ao.tobytes()), **p.extra))
        header[key] = dict(parts=parts, info=M['info'])
    js = json.dumps(dict(classes=CLS, models=header), separators=(',', ':')).encode()
    js += b' ' * ((-len(js)) % 4)
    with open(out_bin, 'wb') as f:
        f.write(struct.pack('<I', len(js))); f.write(js)
        for b in bufs: f.write(b)
    return os.path.getsize(out_bin)

def visible_faces(tri, res=320, ndir=42, seed=0):
    """Faces seen from outside: parallel rays from many directions over the bounding sphere, first hit wins."""
    import trimesh
    from trimesh.ray.ray_pyembree import RayMeshIntersector
    V = tri.reshape(-1, 3); F = np.arange(len(V)).reshape(-1, 3)
    m = trimesh.Trimesh(V, F, process=False)
    rx = RayMeshIntersector(m)
    c = V.mean(0); R = np.linalg.norm(V - c, axis=1).max() * 1.05
    # Fibonacci sphere directions (incl. from below for undersides)
    i = np.arange(ndir) + 0.5; phi = np.arccos(1 - 2 * i / ndir); th = np.pi * (1 + 5 ** 0.5) * i
    dirs = np.c_[np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)]
    seen = np.zeros(len(F), bool); vote = np.zeros(len(F))
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    g = np.linspace(-R, R, res)
    for d in dirs:
        a = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.9 else [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(d, a)
        U, W = np.meshgrid(g, g); O = c - d * R * 1.5 + U.reshape(-1, 1) * a + W.reshape(-1, 1) * b
        hit = rx.intersects_first(O, np.tile(d, (len(O), 1)))
        h = np.unique(hit[hit >= 0]); seen[h] = True
        # a face seen along d should face back toward -d: vote on its winding
        vote[h] += np.sign(-(n[h] @ d))
    visible_faces.flip = vote < 0
    return seen

def decimate_whole(tri, cls, target):
    """Weld everything, quadric-decimate as one surface (no cracks between paint classes), relabel by nearest face."""
    if len(tri) <= target: return tri, cls
    V = tri.reshape(-1, 3); q = np.round(V / 1.5e-3).astype(np.int64)
    uq, inv = np.unique(q, axis=0, return_inverse=True); inv = inv.reshape(-1)
    P = np.zeros((len(uq), 3)); np.add.at(P, inv, V); P /= np.bincount(inv)[:, None]
    F = inv.reshape(-1, 3); ok = (F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2]); F = F[ok]; K0 = cls[ok]
    P2, F2 = fast_simplification.simplify(P.astype(np.float32), F.astype(np.int32), target_reduction=float(np.clip(1 - target / len(F), 0, 0.995)), agg=5)
    T2 = P2[F2].astype(np.float64)
    if len(T2) > target * 1.5: T2 = cluster(T2, target)
    idx = cKDTree(P[F].mean(1)).query(T2.mean(1))[1]
    return T2, K0[idx]

def remesh(tri, pitch, target, close=2, smooth=6, open_=0):
    """Watertight rebuild of a triangle soup: rasterise the surface into voxels, close small gaps, fill the inside,
    re-surface with marching cubes, smooth the voxel steps away and quadric-decimate the now manifold surface.
    Returns (triangles, outward winding)."""
    import trimesh
    from scipy import ndimage
    from skimage.measure import marching_cubes
    V = tri.reshape(-1, 3); F = np.arange(len(V)).reshape(-1, 3)
    m = trimesh.Trimesh(V, F, process=False)
    vox = m.voxelized(pitch)
    occ = vox.matrix.copy()
    pad = close + 3
    occ = np.pad(occ, pad)
    if close:
        st = ndimage.generate_binary_structure(3, 1)
        occ = ndimage.binary_closing(occ, structure=st, iterations=close)
    occ = ndimage.binary_fill_holes(occ)
    if open_: occ = ndimage.binary_opening(occ, iterations=open_)
    # drop tiny islands (specks)
    lab, n = ndimage.label(occ)
    if n > 1:
        sizes = ndimage.sum(occ, lab, range(1, n + 1))
        keep = np.isin(lab, 1 + np.where(sizes >= max(20, sizes.max() * 0.002))[0])
        occ = keep
    field = ndimage.gaussian_filter(occ.astype(np.float32), 0.7)
    verts, faces, _, _ = marching_cubes(field, 0.5)
    # voxel index -> world (trimesh voxel transform maps indices of the unpadded grid)
    T = vox.transform
    verts = (verts - pad) @ T[:3, :3].T + T[:3, 3]
    mm = trimesh.Trimesh(verts, faces, process=True)
    if smooth: trimesh.smoothing.filter_taubin(mm, iterations=smooth)
    P, Fo = mm.vertices.astype(np.float32), mm.faces.astype(np.int32)
    if len(Fo) > target:
        P, Fo = fast_simplification.simplify(P, Fo, target_reduction=float(np.clip(1 - target / len(Fo), 0, 0.995)), agg=4)
    out = trimesh.Trimesh(P, Fo, process=True)
    out.fix_normals()
    return np.asarray(out.vertices)[np.asarray(out.faces)]

def transfer_classes(new_tri, src_tri, src_cls, src_shade):
    """Paint class and shade per new face from the nearest visible source face."""
    tree = cKDTree(src_tri.mean(1))
    d, idx = tree.query(new_tri.mean(1))
    return src_cls[idx], src_shade[idx]

def solid_grid(tri, pitch, close=2):
    """Closed, filled occupancy grid of a soup (voxel surface, closing, hole fill). Returns occ, origin, pitch."""
    import trimesh
    from scipy import ndimage
    V = tri.reshape(-1, 3); m = trimesh.Trimesh(V, np.arange(len(V)).reshape(-1, 3), process=False)
    vox = m.voxelized(pitch); occ = vox.matrix.copy(); pad = close + 3
    occ = np.pad(occ, pad)
    if close: occ = ndimage.binary_closing(occ, structure=ndimage.generate_binary_structure(3, 1), iterations=close)
    occ = ndimage.binary_fill_holes(occ)
    T = vox.transform
    return occ, T[:3, 3] - pad * pitch, pitch

def surface_from_grid(occ, origin, pitch, target, sigma=0.8, smooth=4, keep_frac=0.002):
    import trimesh
    from scipy import ndimage
    from skimage.measure import marching_cubes
    lab, n = ndimage.label(occ)
    if n > 1:
        sizes = ndimage.sum(occ, lab, range(1, n + 1))
        occ = np.isin(lab, 1 + np.where(sizes >= max(30, sizes.max() * keep_frac))[0])
    field = ndimage.gaussian_filter(occ.astype(np.float32), sigma)
    verts, faces, _, _ = marching_cubes(np.pad(field, 1), 0.5)
    verts = (verts - 1) * pitch + origin
    mm = trimesh.Trimesh(verts, faces, process=True)
    if smooth: trimesh.smoothing.filter_taubin(mm, iterations=smooth)
    P, Fo = mm.vertices.astype(np.float32), mm.faces.astype(np.int32)
    for agg in (3, 5, 7, 9):
        if len(Fo) <= target * 1.05: break
        P, Fo = fast_simplification.simplify(P, Fo, target_reduction=float(np.clip(1 - target / len(Fo), 0, 0.998)), agg=agg)
    out = trimesh.Trimesh(P, Fo, process=True); out.fix_normals()
    return np.asarray(out.vertices)[np.asarray(out.faces)]

def visual_hull(occ):
    """Intersection of the three orthographic silhouettes of a solid (crisp, convex-per-axis shapes)."""
    sx = occ.any(0); sy = occ.any(1); sz = occ.any(2)   # silhouettes along x, y, z
    return sx[None, :, :] & sy[:, None, :] & sz[:, :, None]
