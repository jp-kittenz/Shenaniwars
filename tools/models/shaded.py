# Shaded orthographic 3/4 views (painter's algorithm, lambert per face) for judging model quality.
import numpy as np, matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
def rot(yaw, pitch):
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]); Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return Rx @ Ry
def shaded(tri, base, out, title='', views=((0.7, 0.4), (2.5, 0.35), (np.pi / 2, 0.02), (0, 1.5)), size=(20, 5)):
    fig, ax = plt.subplots(1, len(views), figsize=size)
    L = np.array([0.4, 0.8, 0.45]); L /= np.linalg.norm(L)
    for k, (yaw, pitch) in enumerate(views):
        R = rot(yaw, pitch); T = tri @ R.T
        n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        front = n[:, 2] > 0   # facing the viewer (+z towards camera)
        Lr = R @ L
        sh = 0.38 + 0.62 * np.clip(n @ Lr, 0, 1)
        o = np.argsort(T[:, :, 2].mean(1))
        o = o[front[o]]
        colr = np.clip(base[o] * sh[o, None], 0, 1)
        ax[k].add_collection(PolyCollection(T[o][:, :, :2], facecolors=colr, edgecolors=colr, linewidths=0.2))
        ax[k].autoscale(); ax[k].set_aspect('equal'); ax[k].axis('off')
    fig.suptitle(title); fig.tight_layout(); fig.savefig(out, dpi=55); plt.close(fig)
