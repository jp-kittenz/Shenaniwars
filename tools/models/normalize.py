# Raw npz -> game ground coordinates (+Z forward, +X left, y=0 on the ground), scaled to real length.
import sys, numpy as np
sys.path.insert(0, sys.argv[1] if len(sys.argv) > 1 else '.')
from cfg import CFG
from views import views
import os
D = os.path.dirname(os.path.abspath(__file__))
def norm(key):
    c = CFG[key]
    d = np.load(f'{D}/raw/{c["src"]}.npz'); tri = d['tri'].astype(np.float64); col = d['col']; mid = d['mid']
    if col.shape[1] == 4:
        glassy = np.array([bool(__import__('re').search(r'glass|okna|transparent|\|op', m, 2)) for m in d['mats']])[mid]
        keep = (col[:, 3] > 0.35) | glassy
        tri, col, mid = tri[keep], col[keep, :3], mid[keep]
    crop = c.get('crop')
    if crop:
        cx = tri[:, :, 0].mean(1); keep = np.ones(len(tri), bool)
        if 'xmax' in crop: keep &= cx < crop['xmax']
        tri, col, mid = tri[keep], col[keep], mid[keep]
    # forward axis
    if c['fwd'] == 'pca':
        cen = tri.mean(1); y = cen[:, 1]; body = cen[y < np.percentile(y, 80)]
        xz = body[:, [0, 2]] - body[:, [0, 2]].mean(0)
        w, v = np.linalg.eigh(xz.T @ xz); ax = v[:, -1]
        if ax[0] > 0: ax = -ax
        fx, fz = ax
    else: fx, fz = c['fwd']
    a = -np.arctan2(fx, fz)
    ca, sa = np.cos(a), np.sin(a)
    x, z = tri[:, :, 0].copy(), tri[:, :, 2].copy()
    tri[:, :, 0] = x * ca + z * sa; tri[:, :, 2] = -x * sa + z * ca
    # Facing +Z with Y up the model's own +X must be the vehicle's left; mirroring is not needed (rotation keeps handedness).
    P = tri.reshape(-1, 3)
    span = np.percentile(P[:, 0], 99.5) - np.percentile(P[:, 0], 0.5)
    central = np.abs(tri[:, :, 0].mean(1) - np.median(P[:, 0])) < (0.12 * span if c.get('heli') else 1e9)
    if c.get('heli'):
        # Rotor blades lie along the fuselage too: measure the body below the rotor disc only.
        yy = tri[:, :, 1].mean(1); y0, y1 = np.percentile(P[:, 1], 0.5), np.percentile(P[:, 1], 99.5)
        central &= yy < y0 + (y1 - y0) * c.get('bodyTop', 0.72)
    Pc = tri[central].reshape(-1, 3)
    z0, z1 = np.percentile(Pc[:, 2], 0.3), np.percentile(Pc[:, 2], 99.7)
    s = c['length'] / (z1 - z0)
    tri *= s
    P = tri.reshape(-1, 3)
    # Drop thin stray geometry well outside the robust extents (antennas trailing behind, junk below the hull).
    lo, hi = np.percentile(P, 0.2, axis=0), np.percentile(P, 99.8, axis=0)
    pad = (hi - lo) * 0.12
    ok = np.all((tri >= lo - pad) & (tri <= hi + pad), axis=(1, 2))
    tri, col, mid = tri[ok], col[ok], mid[ok]
    P = tri.reshape(-1, 3)
    ground = np.percentile(P[:, 1], 0.15)
    tri[:, :, 1] -= ground
    tri[:, :, 0] -= (np.percentile(P[:, 0], 1) + np.percentile(P[:, 0], 99)) / 2
    zc = (np.percentile(tri[:, :, 2], 0.5) + np.percentile(tri[:, :, 2], 99.5)) / 2
    tri[:, :, 2] -= zc
    keep = tri[:, :, 1].min(1) > -0.35
    tri, col, mid = tri[keep], col[keep], mid[keep]
    np.savez_compressed(f'{D}/norm/{key}.npz', tri=tri.astype(np.float32), col=col, mid=mid, names=d['names'], mats=d['mats'])
    return tri, col
if __name__ == '__main__':
    os.makedirs(f'{D}/norm', exist_ok=True); os.makedirs(f'{D}/nimg', exist_ok=True)
    for key in (sys.argv[2:] or CFG):
        tri, col = norm(key)
        P = tri.reshape(-1, 3)
        print(key, len(tri), 'ext', P.min(0).round(2), P.max(0).round(2))
