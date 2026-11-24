import sys as _s, os as _o; _s.path.insert(0, _o.path.dirname(_o.path.abspath(__file__)))
# Per-model rigging: split parts, pivots, wheels. rig(key) -> dict(parts=[Part], info={...}, hl=labels for checking).
from build import *
def mats_of(mid, mats): return mats[mid]
def regrounded(tri, y0):
    tri = tri.copy(); tri[:, :, 1] -= y0; keep = tri[:, :, 1].min(1) > -0.08
    return tri, keep
GROUND = {
  'atcst': dict(zs=[2.2, -1.6, -2.85], R=0.6, xmin=0.55, budget=3200),
  'uaz': dict(zs=[1.25, -1.0], R=0.4, xmin=0.4, budget=2200),
  'tigr': dict(zs=[1.95, -1.6], R=0.55, xmin=0.55, budget=3600, yawMat='KordBase'),
  'brdm': dict(zs=[-1.75, 1.45], R=0.59, xmin=0.6, budget=3200, yawMat='Gun1Mtl'),
  'grad': dict(zs=[2.5, -1.0, -2.45], R=0.6, xmin=0.6, budget=3800),
  'smerch': dict(zs=[-5.1, -2.71, 0.94, 3.28], R=0.62, xmin=0.7, budget=3600, reground=True),
  'radar': dict(zs=[-2.74, -0.99, 1.61, 2.96], R=0.6, xmin=0.7, budget=3600),
  'tel': dict(zs=[-4.17, -2.12, 1.63, 3.88], R=0.66, xmin=0.7, budget=3400),
  'ifv2': dict(zs=None, R=0, xmin=0, budget=4200, tracked=True),
}
def rig_ground(key):
    g = GROUND[key]
    tri, col, mid, names, mats = load(key)
    mt = mats_of(mid, mats)
    if key == 'ifv2':
        y0 = np.percentile(tri[:, :, 1], 4); tri, keep = regrounded(tri, y0); tri, col, mt, mid = tri[keep], col[keep], mt[keep], mid[keep]
    cen = tri.mean(1)
    lab = np.zeros(len(tri), np.int8)   # 0 hull 1 wheel 2 yaw0 3 pitch0 4 spin 5 drop 6 magazine
    axles, wm = ([], np.zeros(len(tri), bool))
    if not g.get('tracked'):
        axles, wm = detect_wheels(tri, col, g['R'], g['xmin'], zs=g['zs'])
        if g.get('reground'):
            yb = min(tri[wm][:, :, 1].min(), 9)
            tri, keep = regrounded(tri, yb); tri, col, mt, mid, wm = tri[keep], col[keep], mt[keep], mid[keep], wm[keep]
            cen = tri.mean(1); lab = np.zeros(len(tri), np.int8)
            axles, wm = detect_wheels(tri, col, g['R'], g['xmin'], zs=g['zs'])
        lab[wm] = 1
    info = dict(axles=axles)
    y = cen[:, 1]; z = cen[:, 2]; x = cen[:, 0]
    if 'yawMat' in g: lab[np.array([g['yawMat'] in m for m in mt]) & (lab == 0)] = 2
    if key == 'ifv2':
        lab[np.isin(mid, list(IFV2_TURRET))] = 2
    if key == 'grad':
        lab[(y > 1.45) & (y < 2.0) & (z < -0.6) & (z > -3.3) & (np.abs(x) < 1.1) & (lab == 0)] = 2
        lab[(y >= 1.95) & (z < -0.45) & (z > -3.95) & (lab != 1)] = 3
    if key == 'smerch':
        lab[(y > 1.45) & (z < 1.95) & (z > -6.0) & (np.abs(x) < 1.35) & (lab == 0)] = 3
    if key == 'radar':
        lab[(y > 3.35) & (np.abs(z - 1.15) < 1.8) & (np.abs(x) < 1.35)] = 4
    if key == 'tel':
        lab[(z < -5.05) & (y > 2.75)] = 3
    # gun barrels: thin geometry ahead of the turret
    if key in ('ifv2', 'tigr', 'brdm'):
        yaw = lab == 2; yc = cen[yaw]
        zc = (np.percentile(yc[:, 2], 5) + np.percentile(yc[:, 2], 60)) / 2
        front = {'ifv2': 1.35, 'tigr': 0.35, 'brdm': 0.45}[key]
        bar = yaw & (z > zc + front)
        if bar.any():
            by, bx = np.median(cen[bar, 1]), np.median(cen[bar, 0])
            bar &= (np.abs(cen[:, 1] - by) < 0.3) & (np.abs(cen[:, 0] - bx) < 0.35)
            lab[bar] = 3
            info['gun'] = [float(bx), float(by), float(zc + front - 0.25)]
        info['ring'] = [0.0, float(np.percentile(yc[:, 1], 3)), float(zc)]
    return tri, col, mt, lab, info

IFV2_TURRET = {0, 2, 17, 23, 25, 27, 28, 29, 30}
AIR = {
  'gunship': dict(budget=4200, droopY=3.9, bodyW=2.2, main=lambda x, y, z: (y > 4.25) & (z > -8.5), tail=lambda x, y, z: (z < -9.7) & (y > 3.7) & (x > 0.12)),
  'utilheli': dict(budget=4200, noseZ=10.6, main=lambda x, y, z: (y > 4.25) & (z > -9), tail=lambda x, y, z: (z < -11.0) & (y > 4.0) & (np.abs(x) > 0.15)),
  'reconheli': dict(budget=3400, droopY=2.9, bodyW=1.0, noseZ=5.2, main=lambda x, y, z: (y > 3.35) & (z > -8), tail=lambda x, y, z: (z < -8.8) & (y > 2.7) & (np.abs(x) > 0.12)),
  'heavyheli': dict(budget=4500, scale=0.88, droopY=6.4, bodyW=2.6, farR=4, main=lambda x, y, z: (y > 7.0) & (z > -13), tail=lambda x, y, z: (z < -15.5) & (y > 5.8) & (np.abs(x) > 0.3)),
  'lightattack': dict(budget=3600, jet=True),
  'fighter2': dict(budget=3800, jet=True, gear=lambda x, y, z: (y < 1.55) & (np.abs(x) < 2.6)),
  'fighter3': dict(budget=3800, jet=True, gear=lambda x, y, z: (y < 1.28) & (np.abs(x) < 2.6)),
}
def rig_air(key):
    a = AIR[key]
    tri, col, mid, names, mats = load(key)
    mt = mats_of(mid, mats)
    if 'scale' in a: tri = tri * a['scale']
    # drop the source interiors (the game builds its own from the seat layout)
    inner = np.array([bool(re.search(r'interior|seats|gauges|yoke|pedals|collectiv|achs|rpm|_alt|_asi|fuel|oiltemp|panel', m, re.I)) for m in mt])
    tri, col, mt, mid = tri[~inner], col[~inner], mt[~inner], mid[~inner]
    cen = tri.mean(1); x, y, z = cen[:, 0], cen[:, 1], cen[:, 2]
    lab = np.zeros(len(tri), np.int8)  # 0 hull 1 gear 2 yaw0 3 pitch0 4 main rotor 5 tail rotor
    info = {}
    if 'main' in a:
        m = a['main'](x, y, z)
        hx, hz = (x[m].min() + x[m].max()) / 2, (z[m].min() + z[m].max()) / 2
        # drooping blade tips: anything thin far out from the hub at rotor height
        far = np.hypot(x - hx, z - hz) > a.get('farR', 2.4)
        m |= far & (y > a.get('droopY', 3.0)) & ((np.abs(x) > a.get('bodyW', 1.7)) | (z > a.get('noseZ', 99)))
        lab[m] = 4
        hx, hz = (x[m].min() + x[m].max()) / 2, (z[m].min() + z[m].max()) / 2
        info['hub'] = [float(hx), float(np.percentile(y[m], 40)), float(hz)]
        t = a['tail'](x, y, z) & ~m; lab[t] = 5
        if t.any(): info['tail'] = [float((x[t].min() + x[t].max()) / 2), float((y[t].min() + y[t].max()) / 2), float((z[t].min() + z[t].max()) / 2)]
    if 'gear' in a: lab[a['gear'](x, y, z) & (lab == 0)] = 1
    if key == 'gunship':
        g = (z > 7.4) & (y < 1.45) & (np.abs(x) < 0.55); lab[g] = 3
        if g.any(): info['chin'] = [float(np.median(x[g])), float(np.median(y[g])), float(np.percentile(z[g], 20))]
    return tri, col, mt, lab, info

# ------------------------------------------------------------------ assembly
from build import decimate, decimate_whole, visible_faces, shade_ao, paint_classes, Part, pack, lum
def rotY(P, a, piv):
    c, s = np.cos(a), np.sin(a); Q = P - piv; x, z = Q[..., 0].copy(), Q[..., 2].copy()
    Q[..., 0] = x * c + z * s; Q[..., 2] = -x * s + z * c; return Q + piv
def rotX(P, a, piv):
    c, s = np.cos(a), np.sin(a); Q = P - piv; y, z = Q[..., 1].copy(), Q[..., 2].copy()
    Q[..., 1] = y * c - z * s; Q[..., 2] = y * s + z * c; return Q + piv

def build_model(key):
    ground = key in GROUND
    tri, col, mt, lab, info = rig_ground(key) if ground else rig_air(key)
    aircraft = not ground
    # Hidden geometry (engine bays, inner faces, interiors behind closed hulls) costs triangles and wrecks decimation.
    vis = visible_faces(tri)
    flip = visible_faces.flip
    tri = tri.copy(); tri[flip] = tri[flip][:, [0, 2, 1]]   # consistent outward winding (the sources are mixed)
    tri, col, mt, lab = tri[vis], col[vis], mt[vis], lab[vis]
    cls = paint_classes(tri, col, mt, aircraft)
    L = lum(col); Lm = np.median(L[cls == C['PAINT']]) if (cls == C['PAINT']).any() else 0.4
    rel = L / max(Lm, 1e-3)
    H = np.percentile(tri[:, :, 1], 99.5)
    budget = (GROUND.get(key) or AIR.get(key))['budget']
    parts = []; out = dict(info=info)
    def emit(name, mask, pivot=(0, 0, 0), share=1.0, cls_override=None, xf=None, extra=None):
        if not mask.any(): return None
        T = tri[mask].copy(); K = cls[mask].copy() if cls_override is None else np.full(mask.sum(), cls_override, np.int8)
        R_ = rel[mask]
        if xf is not None: T = xf(T)
        n0 = len(T)
        T2, K2 = decimate_whole(T, K, max(24, int(budget * share)))
        # carry shade from the nearest original face
        from scipy.spatial import cKDTree
        idx = cKDTree(T.mean(1)).query(T2.mean(1))[1]
        p = Part(name, T2, K2, pivot, extra)
        p.ao = shade_ao(T2, K2, R_[idx], H, ground=ground)
        parts.append(p); return p
    n = len(tri); frac = lambda m: m.sum() / n
    # team markings: side bands on ground hulls, fins on aircraft
    cen = tri.mean(1); nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]); nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    paint = cls == C['PAINT']
    if ground:
        band = paint & (np.abs(nrm[:, 0]) > 0.8) & (cen[:, 1] > H * 0.55) & (cen[:, 1] < H * 0.61) & (np.abs(cen[:, 2]) < np.percentile(np.abs(cen[:, 2]), 70))
        pass  # markings are added as plates in the game (decimation smears marked faces)
    else:
        zmin = np.percentile(cen[:, 2], 3)
        fin = paint & (np.abs(nrm[:, 0]) > 0.85) & (cen[:, 1] > H * 0.62) & (cen[:, 2] < zmin + (np.percentile(cen[:, 2], 97) - zmin) * 0.22)
        pass
    if ground:
        hull = lab == 0
        emit('hull', hull, share=0.62 if (lab > 0).any() else 1.0)
        wm = lab == 1
        if wm.any():
            z0, yc, r, xc, w = info['axles'][0]
            proto = wm & (np.abs(cen[:, 2] - z0) < r * 1.1) & (cen[:, 0] > 0)
            def wxf(T, z0=z0, yc=yc, xc=xc): T = T.copy(); T[..., 0] -= xc; T[..., 1] -= yc; T[..., 2] -= z0; return T
            K = cls.copy(); K[proto & (L < 0.2)] = C['RUBBER']; cls[:] = K
            emit('wheel', proto, share=0.1, xf=wxf)
        if ((lab == 2).any() or (lab == 3).any()) and key not in ('smerch', 'tel'):
            if key == 'grad':
                pod = lab == 3; P = tri[pod].reshape(-1, 3)
                # principal axis of the pod: muzzle end is the high end
                c0 = P.mean(0); w, v = np.linalg.eigh(np.cov((P - c0).T)); u = v[:, -1]; u = u if u[1] > 0 else -u
                az = np.arctan2(u[0], u[2]); el = np.arcsin(np.clip(u[1], -1, 1))
                proj = (P - c0) @ u; low = c0 + u * proj.min()
                yawp = np.array([0, 1.62, low[2] - 0.2]); piv = np.array([0, low[1] - 0.15, low[2]])
                un = lambda T: rotX(rotY(T, -az, yawp), el, rotY(piv[None], -az, yawp)[0])
                pivR = rotY(piv[None], -az, yawp)[0]
                emit('yaw0', lab == 2, pivot=yawp, share=0.08, xf=lambda T: rotY(T, -az, yawp))
                emit('pitch0', pod, pivot=pivR, share=0.12, xf=un)
                out['mount0'] = dict(pos=yawp.tolist(), trunnion=(pivR - yawp).tolist(), barrel=float(proj.max() - proj.min()))
            else:
                ring = np.array(info.get('ring', [0, 2, 0])); gun = np.array(info.get('gun', ring))
                emit('yaw0', lab == 2, pivot=ring, share=0.14)
                emit('pitch0', lab == 3, pivot=gun, share=0.05)
                out['mount0'] = dict(pos=ring.tolist(), trunnion=(gun - ring).tolist(), barrel=float(tri[lab == 3][:, :, 2].max() - gun[2]) if (lab == 3).any() else 1.0)
        if key in ('smerch', 'tel'):
            pm = lab == 3; P = tri[pm].reshape(-1, 3)
            if key == 'smerch':
                piv = np.array([0, 2.0, P[:, 2].min() + 0.4])
                emit('pitch0', pm, pivot=piv, share=0.2)
                out['mount0'] = dict(pos=piv.tolist(), trunnion=[0, 0, 0], barrel=float(P[:, 2].max() - piv[2]))
            else:
                piv = np.array([0, 3.4, float(np.median(P[:, 2]))])
                # erected missiles -> stowed along the bed, pointing forward
                emit('pitch0', pm, pivot=piv, share=0.2, xf=lambda T: rotX(T, np.pi / 2, piv))
                out['mount0'] = dict(pos=piv.tolist(), trunnion=[0, 0, 0], barrel=float(P[:, 1].max() - piv[1]))
        if key == 'radar':
            sp = lab == 4; P = tri[sp].reshape(-1, 3)
            piv = np.array([0, P[:, 1].min(), (P[:, 2].min() + P[:, 2].max()) / 2])
            emit('spin', sp, pivot=piv, share=0.08)
            out['spin'] = piv.tolist()
    else:
        emit('hull', lab == 0, share=0.8)
        if (lab == 4).any():
            hub = np.array(info['hub']); emit('rotor', lab == 4, pivot=hub, share=0.12); out['rotor'] = hub.tolist()
        if (lab == 5).any():
            tl = np.array(info['tail']); emit('tailrotor', lab == 5, pivot=tl, share=0.04); out['tailrotor'] = tl.tolist()
        if (lab == 1).any(): emit('gear', lab == 1, share=0.08)
        if (lab == 3).any():
            ch = np.array(info['chin']); emit('pitch0', lab == 3, pivot=ch, share=0.04); out['chin'] = ch.tolist()
    P = np.concatenate([p.tri.reshape(-1, 3) + (p.pivot if p.name not in ('hull', 'gear', 'wheel') else 0) * 0 for p in parts if p.name == 'hull'])
    out['bbox'] = [P.min(0).round(3).tolist(), P.max(0).round(3).tolist()]
    out['tris'] = int(sum(len(p.tri) for p in parts))
    return dict(parts=parts, info=out)

if __name__ == '__main__':
    import sys, json
    keys = sys.argv[1:] or list(GROUND) + list(AIR)
    models = {}
    for k in keys:
        M = build_model(k); models[k] = M
        print(k, M['info']['tris'], json.dumps({a: b for a, b in M['info'].items() if a not in ('tris',)}, default=lambda o: np.round(o, 3).tolist())[:400])
    size = pack(models, f'{D}/torsa-models.bin')
    print('packed', size)
