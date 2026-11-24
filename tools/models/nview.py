# Normalised model views in game coords: side (z fwd → right, y up), top (z → right, x left ↑), front (x left ← , y).
import sys, numpy as np, matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
D = sys.argv[1]
def show(key, out, tri=None, col=None, hl=None):
    if tri is None:
        d = np.load(f'{D}/norm/{key}.npz'); tri, col = d['tri'], d['col']
    if len(tri) > 50000:
        sel = np.random.default_rng(0).choice(len(tri), 50000, replace=False); tri, col = tri[sel], col[sel]
        if hl is not None: hl = hl[sel]
    C = np.clip(col, 0, 1).copy()
    if hl is not None: C[hl > 0] = plt.cm.tab10(hl[hl > 0] % 10)[:, :3]
    fig, ax = plt.subplots(1, 3, figsize=(18, 5), gridspec_kw=dict(width_ratios=[2.2, 2.2, 1]))
    for k, (a, b, depth, flip, nm) in enumerate(((2, 1, 0, False, 'side (from +X/left): z fwd →, y ↑'), (2, 0, 1, False, 'top: z fwd →, x(left) ↑'), (0, 1, 2, True, 'front (from +Z): x left ←, y ↑'))):
        o = np.argsort(tri[:, :, depth].mean(1))
        P = tri[o][:, :, [a, b]].copy()
        if flip: P[:, :, 0] *= -1
        ax[k].add_collection(PolyCollection(P, facecolors=C[o], edgecolors='none')); ax[k].autoscale(); ax[k].set_aspect('equal')
        ax[k].grid(True, lw=0.3); ax[k].set_title(nm, fontsize=9)
        ax[k].xaxis.set_major_locator(plt.MultipleLocator(1)); ax[k].yaxis.set_major_locator(plt.MultipleLocator(1)); ax[k].tick_params(labelsize=6)
    fig.suptitle(key); fig.tight_layout(); fig.savefig(out, dpi=60); plt.close(fig)
if __name__ == '__main__':
    for key in sys.argv[2:]: show(key, f'{D}/nimg/{key}.png')
