# USDZ -> npz: world-space triangles, per-face sampled base colour, mesh index + names. Usage: extract.py in.usdz out.npz
import sys, zipfile, io, numpy as np
from pxr import Usd, UsdGeom, UsdShade, Sdf
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
zf = zipfile.ZipFile(src)
st = Usd.Stage.Open(src)
xc = UsdGeom.XformCache(Usd.TimeCode.Default())
tex_cache = {}
def load_tex(path):
    if path in tex_cache: return tex_cache[path]
    arr = None
    for name in zf.namelist():
        if name.endswith(path.split('/')[-1]):
            try:
                im = Image.open(io.BytesIO(zf.read(name))).convert('RGBA'); im.thumbnail((256, 256)); arr = np.asarray(im).astype(np.float32) / 255
            except Exception: arr = None
            break
    tex_cache[path] = arr; return arr
def surface_inputs(mesh_prim):
    mat, _ = UsdShade.MaterialBindingAPI(mesh_prim).ComputeBoundMaterial()
    if not mat: return None, None, ''
    out = mat.GetSurfaceOutput()
    srcs = out.GetConnectedSources()[0] if out else []
    if not srcs: return None, None, mat.GetPath().name
    sh = UsdShade.Shader(srcs[0].source.GetPrim())
    dc = sh.GetInput('diffuseColor')
    const, tex = None, None
    if dc:
        if dc.HasConnectedSource():
            s2 = dc.GetConnectedSources()[0][0].source
            t = UsdShade.Shader(s2.GetPrim()); f = t.GetInput('file')
            if f and f.Get(): tex = load_tex(f.Get().path)
            sc = t.GetInput('scale')
            if tex is not None and sc and sc.Get() is not None: tex = tex * np.array(list(sc.Get())[:3] + [1.0], np.float32)
        elif dc.Get() is not None: const = np.array(dc.Get(), np.float32)
    op = sh.GetInput('opacity')
    opv = op.Get() if op and not op.HasConnectedSource() else None
    return const, tex, mat.GetPath().name + ('|op%.2f' % opv if opv is not None and opv < 0.9 else '')
TRI, COL, MID, names, mats = [], [], [], [], []
mi = 0
for p in st.Traverse(Usd.TraverseInstanceProxies(Usd.PrimDefaultPredicate)):
    if not p.IsA(UsdGeom.Mesh): continue
    m = UsdGeom.Mesh(p)
    pts = np.array(m.GetPointsAttr().Get() or [], np.float64)
    cnt = np.array(m.GetFaceVertexCountsAttr().Get() or [], np.int64)
    idx = np.array(m.GetFaceVertexIndicesAttr().Get() or [], np.int64)
    if len(pts) == 0 or len(cnt) == 0: continue
    M = np.array(xc.GetLocalToWorldTransform(p), np.float64)
    wp = np.c_[pts, np.ones(len(pts))] @ M
    wp = wp[:, :3]
    const, tex, mname = surface_inputs(p)
    # UVs
    pv = UsdGeom.PrimvarsAPI(p)
    st_pv = None
    for nm in ('st', 'st0', 'UVMap', 'uv', 'map1'):
        if pv.HasPrimvar(nm): st_pv = pv.GetPrimvar(nm); break
    if st_pv is None:
        for q in pv.GetPrimvars():
            if q.GetTypeName().role == 'TextureCoordinate' or 'TexCoord' in str(q.GetTypeName()): st_pv = q; break
    uv = None; interp = None
    if st_pv is not None and tex is not None:
        uvv = st_pv.ComputeFlattened()
        if uvv is not None: uv = np.array(uvv, np.float32); interp = st_pv.GetInterpolation()
    disp = None
    dcp = pv.GetPrimvar('displayColor') if pv.HasPrimvar('displayColor') else None
    if dcp is not None and dcp.Get() is not None and len(dcp.Get()) > 0: disp = np.array(dcp.Get(), np.float32)
    # triangulate (fan)
    starts = np.r_[0, np.cumsum(cnt)[:-1]]
    tri_v, tri_fv = [], []
    for f, (s0, c) in enumerate(zip(starts, cnt)):
        for k in range(1, c - 1):
            tri_v.append((idx[s0], idx[s0 + k], idx[s0 + k + 1])); tri_fv.append((s0, s0 + k, s0 + k + 1, f))
    tri_v = np.array(tri_v, np.int64); tri_fv = np.array(tri_fv, np.int64)
    T = wp[tri_v]
    # colour
    if tex is not None and uv is not None:
        if interp == 'faceVarying' and len(uv) >= idx.size: tuv = uv[tri_fv[:, :3]]
        elif len(uv) == len(pts): tuv = uv[tri_v]
        else: tuv = None
        if tuv is not None:
            h, w, _ = tex.shape
            cs = []
            for wts in ((1/3, 1/3, 1/3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)):
                u = (tuv[:, 0, 0] * wts[0] + tuv[:, 1, 0] * wts[1] + tuv[:, 2, 0] * wts[2]) % 1.0
                v = (tuv[:, 0, 1] * wts[0] + tuv[:, 1, 1] * wts[1] + tuv[:, 2, 1] * wts[2]) % 1.0
                cs.append(tex[np.clip(((1 - v) * h).astype(int), 0, h - 1), np.clip((u * w).astype(int), 0, w - 1)])
            C = np.mean(cs, axis=0)
        else: C = np.tile(np.mean(tex.reshape(-1, 4), 0), (len(T), 1))
    elif const is not None: C = np.tile(list(const[:3]) + [1.0], (len(T), 1))
    elif disp is not None: C = np.tile(list(disp[0][:3]) + [1.0], (len(T), 1))
    else: C = np.full((len(T), 4), 0.5, np.float32); C[:, 3] = 1
    TRI.append(T.astype(np.float32)); COL.append(C.astype(np.float32)); MID.append(np.full(len(T), mi, np.int32))
    names.append(str(p.GetPath())); mats.append(mname); mi += 1
np.savez_compressed(dst, tri=np.concatenate(TRI), col=np.concatenate(COL), mid=np.concatenate(MID), names=np.array(names), mats=np.array(mats),
                    up=UsdGeom.GetStageUpAxis(st), mpu=UsdGeom.GetStageMetersPerUnit(st))
t = np.concatenate(TRI).reshape(-1, 3)
print(dst.split('/')[-1], 'tris', sum(len(x) for x in TRI), 'meshes', mi, 'min', t.min(0).round(2), 'max', t.max(0).round(2))
