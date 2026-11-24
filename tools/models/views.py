# Three orthographic views (top X-Z, side, front) of a raw npz, painter-sorted polygons in sampled colours.
import sys, numpy as np, matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
def views(tri, col, title, out, mark=None):
    fig, ax = plt.subplots(1, 3, figsize=(15, 4.4))
    for k, (a, b, depth, nm) in enumerate(((0, 2, 1, 'top: x right, z up'), (2, 1, 0, 'side: z right, y up'), (0, 1, 2, 'front: x right, y up'))):
        o = np.argsort(tri[:, :, depth].mean(1))
        if k == 1: o = o[::-1] if False else o
        P = tri[o][:, :, [a, b]]
        pc = PolyCollection(P, facecolors=np.clip(col[o], 0, 1), edgecolors='none')
        ax[k].add_collection(pc); ax[k].autoscale(); ax[k].set_aspect('equal'); ax[k].set_title(nm, fontsize=9)
        if mark is not None: ax[k].plot(mark[:, a], mark[:, b], 'r+', ms=10)
    fig.suptitle(title); fig.tight_layout(); fig.savefig(out, dpi=70); plt.close(fig)
if __name__ == '__main__':
    d = np.load(sys.argv[1]); tri, col = d['tri'], d['col']
    if len(tri) > 60000:
        sel = np.random.default_rng(0).choice(len(tri), 60000, replace=False); tri, col = tri[sel], col[sel]
    views(tri, col, sys.argv[1].split('/')[-1], sys.argv[2])
