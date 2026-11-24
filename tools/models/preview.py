import sys, numpy as np; sys.path.insert(0, sys.argv[1])
from rig import build_model, CLS
from nview import show
PAL = {'PAINT': (0.36, 0.40, 0.25), 'PAINT2': (0.55, 0.62, 0.66), 'TEAM': (0.9, 0.5, 0.12), 'DARK': (0.14, 0.15, 0.16), 'STEEL': (0.3, 0.33, 0.35),
       'RUBBER': (0.1, 0.1, 0.1), 'GLASS': (0.5, 0.7, 0.77), 'LENS': (0.15, 0.17, 0.2), 'LAMP': (1, 0.9, 0.6), 'TRACK': (0.17, 0.17, 0.16)}
for key in sys.argv[2:]:
    M = build_model(key); T, C = [], []
    for p in M['parts']:
        t = p.tri.copy()
        if p.name == 'wheel':
            for z0, yc, r, xc, w in M['info']['info']['axles']:
                for sx in (1, -1):
                    q = t.copy(); q[..., 0] = q[..., 0] * sx + xc * sx; q[..., 1] += yc; q[..., 2] += z0
                    T.append(q); C.append(np.array([PAL[CLS[k]] for k in p.cls]) * p.ao.mean(1)[:, None])
            continue
        T.append(t); C.append(np.array([PAL[CLS[k]] for k in p.cls]) * p.ao.mean(1)[:, None])
    show(key, f'{sys.argv[1]}/nimg/pv_{key}.png', np.concatenate(T).astype(np.float32), np.concatenate(C))
