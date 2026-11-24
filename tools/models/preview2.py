import sys, numpy as np; sys.path.insert(0, sys.argv[1])
from rig import build_model2, CLS
from shaded import shaded
PAL = {'PAINT': (0.42, 0.46, 0.3), 'PAINT2': (0.6, 0.66, 0.7), 'TEAM': (0.9, 0.5, 0.12), 'DARK': (0.16, 0.17, 0.18), 'STEEL': (0.34, 0.37, 0.39),
       'RUBBER': (0.1, 0.1, 0.1), 'GLASS': (0.45, 0.62, 0.7), 'LENS': (0.15, 0.17, 0.2), 'LAMP': (1, 0.9, 0.6), 'TRACK': (0.17, 0.17, 0.16)}
import pickle
for key in sys.argv[2:]:
    M = build_model2(key); pickle.dump(M, open(f'{sys.argv[1]}/v2_{key}.pkl', 'wb'))
    T = np.concatenate([p.tri for p in M['parts']]); Ccol = np.concatenate([np.array([PAL[CLS[k]] for k in p.cls]) * p.ao.mean(1)[:, None] for p in M['parts']])
    shaded(T, Ccol, f'{sys.argv[1]}/nimg/v2_{key}.png', f'{key} {len(T)} tris', size=(22, 5))
    print(key, len(T), flush=True)
