#!/usr/bin/env python3
"""Organ package (schema organ-twin-package/1): one twin per organ, composed of every slice of every study.

Input: the output folder of a finished imaging-register job (manifest.json, native/<tp>/ct.nii.gz and labels.nii.gz,
frame/<tp>_labels.nii.gz, pairs/<pair>/rigid.mat). Output: for each organ and each timepoint the native volume, the organ cut
out of the CT (HU unchanged) with its mask, a per-slice table and surface meshes (GLB), plus package.json that says what every
file is, which placement it is in, why a placement was withheld, and how the volume changed between timepoints.

Three placements of a mesh:
  native    the scan's own patient coordinates. Always built.
  rigid     the native mesh of a later scan moved into the reference scan's coordinates by the saved rigid transform. Shape and
            size are untouched. Built only when the spine region of that pair did not fail and the transform measurably puts the
            spine of the later scan on the spine of the reference scan.
  frame     built from the warped label map (the deformable frame). Its shape is normalised to the reference, so its volume is the
            reference volume by construction: it is a picture of correspondence, never a size measurement. Built only when
            frame_contract.advise(organ_surface) allows it for that pair.

Volumes come from the native label maps only (frame_contract: organ_volume). A volume of an organ that touches the edge of the scan is
a lower bound, and a comparison that involves it is marked not assessable.

GLB axes: metres. X = patient left, Y = superior, Z = anterior (patient LPS millimetres (x, y, z) become (x, z, -y) / 1000). That is a
proper rotation, so a default camera at +Z looks at the patient from the front, patient right on the viewer's left.

Decision support for a radiologist, never a diagnosis. Nothing here reads DICOM; nothing here writes to the vault.
"""
import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import time

import numpy as np

SCHEMA = "organ-twin-package/1"
FLOORS_SCHEMA = "organ-volume-floors/1"
CT_CLIP = (-1024, 3071)
CROP_MARGIN_VOX = 5
FACE_BUDGET_DEFAULT = 40000
MIN_MESH_VOXELS = 50
SPINE_MAX_ASSD_MM = 2.0
SPINE_VS_MANIFEST_MM = 0.5
GLTF_AXES = "x=patient left, y=superior, z=anterior; metres"
PROTOCOL_KEYS = ("manufacturer", "model", "study_date", "kernel", "kernel_family", "slice_thickness_mm", "kvp",
                 "contrast_agent", "pixel_spacing_mm", "image_type", "n_slices", "z_extent_mm", "slice_step_mm")

DEFAULT_ORGANS = (
    "lung_left", "lung_right", "lung_upper_lobe_left", "lung_lower_lobe_left", "lung_upper_lobe_right",
    "lung_middle_lobe_right", "lung_lower_lobe_right", "heart", "aorta", "inferior_vena_cava", "trachea", "esophagus",
    "thyroid_gland", "liver", "spleen", "pancreas", "gallbladder", "kidney_left", "kidney_right", "adrenal_gland_left",
    "adrenal_gland_right", "stomach", "duodenum", "small_bowel", "colon", "urinary_bladder", "prostate",
    "portal_vein_and_splenic_vein", "spine")
COMPOSITES = {
    "lung_left": r"^lung_.*_left$",
    "lung_right": r"^lung_.*_right$",
    "spine": r"^vertebrae_[CTL]\d+$",
}
VOLUME_VARIES_WITH = {**{o: "filling" for o in ("stomach", "duodenum", "small_bowel", "colon", "urinary_bladder", "gallbladder", "esophagus")},
                      **{o: "inspiration" for o in ("lung_left", "lung_right", "lung_upper_lobe_left", "lung_lower_lobe_left",
                                                    "lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right")},
                      **{o: "cardiac and contrast phase" for o in ("heart", "aorta", "inferior_vena_cava", "portal_vein_and_splenic_vein")}}
LUNG_ORGANS = ("lung_left", "lung_right", "lung_upper_lobe_left", "lung_lower_lobe_left", "lung_upper_lobe_right",
               "lung_middle_lobe_right", "lung_lower_lobe_right")
SPINE_PATTERN = COMPOSITES["spine"]


def log(*a):
    print("[organ_package]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------------------------------
# Geometry: voxel index to patient LPS millimetres, and the viewer axes
class Grid:
    """Voxel grid of a SimpleITK image. Index order is (x, y, z) here; arrays are (z, y, x)."""

    def __init__(self, origin, spacing, direction, size):
        self.origin = np.asarray(origin, float)
        self.spacing = np.asarray(spacing, float)
        self.direction = np.asarray(direction, float).reshape(3, 3)
        self.size = tuple(int(s) for s in size)

    @classmethod
    def from_image(cls, img):
        return cls(img.GetOrigin(), img.GetSpacing(), img.GetDirection(), img.GetSize())

    def index_to_lps(self, ijk):
        ijk = np.atleast_2d(np.asarray(ijk, float))
        return self.origin + (ijk * self.spacing) @ self.direction.T

    def normal(self):
        return self.direction[:, 2]

    def voxel_volume_mm3(self):
        return float(np.prod(self.spacing))

    def cropped(self, start_xyz, size_xyz):
        origin = self.index_to_lps(np.asarray(start_xyz, float))[0]
        return Grid(origin, self.spacing, self.direction.ravel(), size_xyz)

    def same_as(self, other, tol=1e-4):
        return (self.size == other.size and np.allclose(self.origin, other.origin, atol=tol)
                and np.allclose(self.spacing, other.spacing, atol=tol)
                and np.allclose(self.direction, other.direction, atol=tol))

    def to_image(self, arr_zyx):
        import SimpleITK as sitk
        img = sitk.GetImageFromArray(arr_zyx)
        img.SetOrigin(tuple(float(v) for v in self.origin))
        img.SetSpacing(tuple(float(v) for v in self.spacing))
        img.SetDirection(tuple(float(v) for v in self.direction.ravel()))
        return img


def lps_to_gltf(points_mm):
    p = np.asarray(points_mm, float)
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], axis=1) * 1e-3


def gltf_to_lps(points_m):
    p = np.asarray(points_m, float)
    return np.stack([p[:, 0], -p[:, 2], p[:, 1]], axis=1) * 1e3


# ---------------------------------------------------------------------------------------------------------------------
# Files
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_image(path):
    import SimpleITK as sitk
    img = sitk.ReadImage(path)
    return sitk.GetArrayFromImage(img), Grid.from_image(img)


def write_nifti_gz(img, path):
    """Deterministic: the gzip header carries no name and no time."""
    import SimpleITK as sitk
    raw_path = path[:-3] if path.endswith(".gz") else path + ".raw.nii"
    sitk.WriteImage(img, raw_path)
    with open(raw_path, "rb") as f:
        raw = f.read()
    os.remove(raw_path)
    with open(path, "wb") as out:
        with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=6) as g:
            g.write(raw)


def _glb_set_extras(glb_bytes, extras):
    """Put `extras` into asset.extras of a binary glTF. The JSON chunk is rewritten, the binary chunk is untouched."""
    magic, version, length = struct.unpack("<4sII", glb_bytes[:12])
    assert magic == b"glTF" and version == 2
    jlen, jtype = struct.unpack("<II", glb_bytes[12:20])
    assert jtype == 0x4E4F534A
    doc = json.loads(glb_bytes[20:20 + jlen].decode("utf-8"))
    doc.setdefault("asset", {})["extras"] = extras
    body = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode("utf-8")
    body += b" " * ((-len(body)) % 4)
    rest = glb_bytes[20 + jlen:]
    total = 12 + 8 + len(body) + len(rest)
    return struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<II", len(body), 0x4E4F534A) + body + rest


def glb_extras(path):
    with open(path, "rb") as f:
        data = f.read()
    jlen, _ = struct.unpack("<II", data[12:20])
    return json.loads(data[20:20 + jlen].decode("utf-8")).get("asset", {}).get("extras")


def organ_color(name):
    h = int(hashlib.md5(name.encode()).hexdigest()[:6], 16)
    hue = (h % 360) / 360.0
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(hue, 0.45, 0.85)
    return [round(r, 3), round(g, 3), round(b, 3), 1.0]


# ---------------------------------------------------------------------------------------------------------------------
# Masks and statistics
def organ_ids(names, organ):
    """Label ids of an organ. `names` maps id to TotalSegmentator class name."""
    if organ in COMPOSITES:
        pat = re.compile(COMPOSITES[organ])
        return sorted(i for i, n in names.items() if pat.match(n))
    return sorted(i for i, n in names.items() if n == organ)


def bbox_zyx(mask):
    zs = np.flatnonzero(mask.any(axis=(1, 2)))
    ys = np.flatnonzero(mask.any(axis=(0, 2)))
    xs = np.flatnonzero(mask.any(axis=(0, 1)))
    return (int(zs[0]), int(zs[-1]) + 1), (int(ys[0]), int(ys[-1]) + 1), (int(xs[0]), int(xs[-1]) + 1)


def scan_edge(mask):
    """Which sides of the scan the organ touches. A touched side means the organ is cut and its volume is a lower bound."""
    sides = {"first_slice": bool(mask[0].any()), "last_slice": bool(mask[-1].any()),
             "inplane_border": bool(mask[:, 0, :].any() or mask[:, -1, :].any() or mask[:, :, 0].any() or mask[:, :, -1].any())}
    sides["cut_by_scan_range"] = any(sides.values())
    return sides


def component_stats(mask):
    from scipy import ndimage
    lab, n = ndimage.label(mask, structure=np.ones((3, 3, 3), int))
    if n == 0:
        return 0, 0.0
    sizes = np.bincount(lab.ravel())[1:]
    return int(n), float(sizes.max() / sizes.sum())


def hu_stats(ct_vals):
    if ct_vals.size == 0:
        return None
    q = np.percentile(ct_vals, [5, 50, 95])
    return {"mean": round(float(ct_vals.mean()), 2), "sd": round(float(ct_vals.std()), 2),
            "p5": round(float(q[0]), 1), "p50": round(float(q[1]), 1), "p95": round(float(q[2]), 1)}


def slice_table(mask_crop, ct_crop, grid_crop, k_offset):
    """One row per axial slice of the study that holds the organ. `position_mm` is the slice centre projected on the scan's slice
    normal (the same number for any point of the slice). Areas are exact multiples of the voxel area."""
    sx, sy, _ = grid_crop.spacing
    rows = {"slice_index": [], "position_mm": [], "voxels": [], "area_mm2": [], "mean_hu": [], "centroid_lps_mm": []}
    normal = grid_crop.normal()
    for k in range(mask_crop.shape[0]):
        m = mask_crop[k] > 0
        n = int(m.sum())
        if n == 0:
            continue
        ys, xs = np.nonzero(m)
        cen = grid_crop.index_to_lps([[xs.mean(), ys.mean(), k]])[0]
        pos = float(grid_crop.index_to_lps([[0, 0, k]])[0] @ normal)
        rows["slice_index"].append(int(k + k_offset))
        rows["position_mm"].append(pos)
        rows["voxels"].append(n)
        rows["area_mm2"].append(float(n * sx * sy))
        rows["mean_hu"].append(round(float(ct_crop[k][m].mean()), 2))
        rows["centroid_lps_mm"].append([round(float(v), 3) for v in cen])
    return {"voxel_area_mm2": float(sx * sy), "slice_spacing_mm": float(grid_crop.spacing[2]),
            "slice_normal_lps": [float(v) for v in normal], "rows": rows}


# ---------------------------------------------------------------------------------------------------------------------
# Meshes
def edge_report(mesh):
    """(boundary edges, edges shared by more than 2 faces). A closed manifold surface has 0 and 0."""
    f = np.asarray(mesh.faces, dtype=np.int64)
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]], axis=0)
    e.sort(axis=1)
    n = int(f.max()) + 1 if len(f) else 1
    _, cnt = np.unique(e[:, 0] * n + e[:, 1], return_counts=True)
    return int((cnt == 1).sum()), int((cnt > 2).sum())


def _mc_mesh(mask_zyx, grid, step, smooth_iters):
    """Marching cubes at `step` voxels. The grid is padded by the step, so the sampled lattice always passes outside the organ; for a
    step above 1 the mask is smoothed first (Gaussian, 0.3 times the step)."""
    import trimesh
    from scipy import ndimage
    from skimage import measure
    pad = max(1, int(step))
    vol = np.pad((mask_zyx > 0).astype(np.float32), pad)
    if step > 1:
        vol = ndimage.gaussian_filter(vol, sigma=0.3 * step)
    verts_zyx, faces, _, _ = measure.marching_cubes(vol, level=0.5, step_size=int(step), spacing=(1.0, 1.0, 1.0))
    mesh = trimesh.Trimesh(vertices=grid.index_to_lps(verts_zyx[:, ::-1] - pad), faces=faces, process=True)
    if mesh.volume < 0:
        mesh.invert()
    if smooth_iters:
        trimesh.smoothing.filter_taubin(mesh, iterations=smooth_iters)
    if mesh.volume < 0:
        mesh.invert()
    return mesh


MC_STEPS = (2, 3, 4, 5, 6, 8)
MESH_VOLUME_TOL = 0.05


def mesh_from_mask(mask_zyx, grid, smooth_iters=5, face_budget=FACE_BUDGET_DEFAULT):
    """Surface mesh of a mask in patient LPS millimetres. Returns (mesh, info). Faces point outward whatever the direction matrix.
    At full resolution (1 voxel) unless that is over the face budget or is not a closed manifold; then the first coarser marching-cubes step
    (2 to 8) whose mesh is closed, manifold, within the budget and within 5 percent of the voxel volume. Quadric decimation is not used: on
    real organs it left edges shared by three faces."""
    full = _mc_mesh(mask_zyx, grid, 1, smooth_iters)
    faces_full = int(len(full.faces))
    vox_ml = float((mask_zyx > 0).sum() * grid.voxel_volume_mm3() / 1000.0)
    mesh, step, note = full, 1, None
    full_bnd, full_nonman = edge_report(full)
    over_budget = bool(face_budget) and faces_full > face_budget
    full_open = bool(full_bnd or full_nonman)
    if over_budget or full_open:
        found = False
        for st in MC_STEPS:
            try:
                cand = _mc_mesh(mask_zyx, grid, st, smooth_iters)
            except ValueError:
                note = f"the organ vanishes at step {st}"
                break
            bnd, nonman = edge_report(cand)
            if (bnd == 0 and nonman == 0 and len(cand.faces) > 0 and (not face_budget or len(cand.faces) <= face_budget)
                    and abs(cand.volume / 1000.0 - vox_ml) <= MESH_VOLUME_TOL * vox_ml):
                mesh, step, found = cand, st, True
                if full_open and not over_budget:
                    note = "a coarser step is used because the full-resolution mesh is not a closed manifold"
                break
        if not found:
            why = (f"no step up to {MC_STEPS[-1]} gave a closed manifold mesh" + (f" within {face_budget} faces" if face_budget else "") +
                   f" whose volume is within {int(MESH_VOLUME_TOL * 100)} percent of the voxel volume")
            note = (note or why) + "; the full-resolution mesh is kept"
    bnd, nonman = edge_report(mesh)
    info = {"faces": int(len(mesh.faces)), "faces_full_resolution": faces_full, "decimated": step > 1,
            "method": "marching cubes at full resolution" if step == 1 else f"marching cubes at step {step}, mask smoothed",
            "march_step": step, "face_budget": face_budget,
            "within_budget": (not face_budget) or len(mesh.faces) <= face_budget,
            "boundary_edges": bnd, "nonmanifold_edges": nonman, "closed_manifold": bnd == 0 and nonman == 0,
            "watertight": bool(mesh.is_watertight), "mesh_volume_ml": float(mesh.volume / 1000.0),
            "mesh_volume_ratio": round(float(mesh.volume / 1000.0 / vox_ml), 4) if vox_ml else None,
            "smoothing": f"taubin x{smooth_iters}"}
    if note:
        info["note"] = note
    return mesh, info


def write_glb(mesh_lps, path, organ, extras):
    import trimesh
    gl = trimesh.Trimesh(vertices=lps_to_gltf(mesh_lps.vertices), faces=mesh_lps.faces, process=False)
    gl.visual = trimesh.visual.TextureVisuals(
        material=trimesh.visual.material.PBRMaterial(baseColorFactor=organ_color(organ), metallicFactor=0.0,
                                                     roughnessFactor=0.85, name=organ))
    scene = trimesh.Scene()
    scene.add_geometry(gl, node_name=organ, geom_name=organ)
    data = scene.export(file_type="glb")
    with open(path, "wb") as f:
        f.write(_glb_set_extras(data, extras))


def load_glb_vertices_lps(path):
    import trimesh
    sc = trimesh.load(path, file_type="glb", force="scene")
    vs = [g.vertices for g in sc.geometry.values()]
    return gltf_to_lps(np.concatenate(vs, axis=0))


# ---------------------------------------------------------------------------------------------------------------------
# Rigid placement: the saved transform maps a reference point to a moving point (the direction an image is resampled in). A moving
# mesh is brought into the reference frame with its inverse.
def read_rigid(path):
    import SimpleITK as sitk
    return sitk.ReadTransform(path)


def affine_of(tf):
    """Matrix A and offset t of a transform, read numerically: T(x) = A x + t. Returns (A, t, linearity_error_mm). Works for any
    SimpleITK transform that is affine in effect (Euler, versor, affine, a composite of them)."""
    t = np.array(tf.TransformPoint((0.0, 0.0, 0.0)), float)
    A = np.stack([np.array(tf.TransformPoint(e), float) - t for e in ((1.0, 0, 0), (0, 1.0, 0), (0, 0, 1.0))], axis=1)
    probe = np.array([83.0, -41.0, 127.0])
    err = float(np.abs(np.array(tf.TransformPoint(tuple(probe))) - (A @ probe + t)).max())
    return A, t, err


def rigid_report(tf):
    """Is the transform rigid (orthonormal matrix, determinant +1)? Anything else would change the size of an organ."""
    try:
        A, t, lin = affine_of(tf)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
    return {"orthonormal_error": float(np.abs(A.T @ A - np.eye(3)).max()), "determinant": float(np.linalg.det(A)),
            "linearity_error_mm": lin}


def place_points(points_lps, tf):
    """Reference-frame position of points of the later scan. The saved transform takes a reference point to a later-scan point, so the
    placement is its inverse: x_ref = A^-1 (x_mov - t)."""
    A, t, _ = affine_of(tf)
    p = np.asarray(points_lps, float).reshape(-1, 3)
    return (np.linalg.solve(A, (p - t).T)).T


def _surface_points(mask, grid):
    from scipy import ndimage
    m = mask > 0
    shell = m & ~ndimage.binary_erosion(m)
    zyx = np.argwhere(shell)
    return grid.index_to_lps(zyx[:, ::-1])


def spine_distance(mov_mask, mov_grid, ref_mask, ref_grid, tf):
    """ASSD between the vertebrae of the later scan, placed with the inverse of the rigid transform, and the vertebrae of the
    reference scan, over the range along the body axis that both cover."""
    from scipy.spatial import cKDTree
    a = place_points(_surface_points(mov_mask, mov_grid), tf)
    b = _surface_points(ref_mask, ref_grid)
    if len(a) == 0 or len(b) == 0:
        return None
    lo = max(a[:, 2].min(), b[:, 2].min())
    hi = min(a[:, 2].max(), b[:, 2].max())
    if hi - lo < 20.0:
        return None
    a = a[(a[:, 2] >= lo) & (a[:, 2] <= hi)]
    b = b[(b[:, 2] >= lo) & (b[:, 2] <= hi)]
    d_ab = cKDTree(b).query(a)[0]
    d_ba = cKDTree(a).query(b)[0]
    assd = float((d_ab.sum() + d_ba.sum()) / (len(d_ab) + len(d_ba)))
    return {"assd_mm": round(assd, 3), "overlap_z_mm": round(float(hi - lo), 1), "points": int(len(a) + len(b))}


# ---------------------------------------------------------------------------------------------------------------------
# Placement policy: frame_contract decides, per pair
def _contract():
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import frame_contract
    return frame_contract


def pair_row(manifest, tp, ref):
    for row in manifest.get("pairs") or []:
        if row.get("moving") == tp and row.get("reference") == ref:
            return row
    return None


def decide_placements(manifest, tp, ref):
    """What may be built for a timepoint. Never a guess: a missing pair or a missing number withholds."""
    if tp == ref:
        return {"rigid": {"allowed": True, "reason": "reference scan"}, "frame": {"allowed": True, "reason": "reference scan"},
                "pair": None, "lungs_frame_withheld": False, "regions": {}}
    row = pair_row(manifest, tp, ref)
    if row is None:
        why = f"the job has no registration of {tp} into {ref}"
        return {"rigid": {"allowed": False, "reason": why}, "frame": {"allowed": False, "reason": why},
                "pair": None, "lungs_frame_withheld": False, "regions": {}}
    fc = _contract()
    advice = fc.advise(manifest, "organ_surface", pair=row["pair"])
    regions = (advice["pairs"][0]["regions"] if advice["pairs"] else {})
    spine = regions.get("spine", "unknown")
    if spine in ("fail", "unknown"):
        rigid = {"allowed": False, "reason": f"spine region {spine}: the later scan is not tied to the reference through the spine"}
    else:
        rigid = {"allowed": True, "reason": f"spine region {spine}; the placement is checked against the spine before use"}
    frame = {"allowed": bool(advice["use_frame"]) and bool(advice["use_organ_labels"]), "reason": advice["reason"]}
    if advice["use_frame"] and not advice["use_organ_labels"]:
        frame["reason"] = ("a region hard-failed (" + ", ".join(advice["regions_hard_fail"]) + "); labels from the frame are not used. "
                           + advice["reason"])
    return {"rigid": rigid, "frame": frame, "pair": row["pair"], "regions": regions,
            "lungs_frame_withheld": "lungs" in (advice.get("labels_excluded_regions") or [])}


# ---------------------------------------------------------------------------------------------------------------------
def clean_protocol(protocol):
    return {k: protocol[k] for k in PROTOCOL_KEYS if k in (protocol or {})}


def order_timepoints(manifest):
    tps = [t["label"] for t in manifest["timepoints"]]
    dates = {t["label"]: str((t.get("protocol") or {}).get("study_date") or "") for t in manifest["timepoints"]}
    if all(re.fullmatch(r"\d{8}", d) for d in dates.values()):
        return sorted(tps, key=lambda x: dates[x]), "study_date"
    return tps, "manifest order"


def choose_organs(spec, names):
    if spec in (None, "", "default"):
        wanted = list(DEFAULT_ORGANS)
    elif spec == "all":
        wanted = sorted(set(names.values()) | set(COMPOSITES))
    else:
        wanted = [s.strip() for s in spec.split(",") if s.strip()]
    return wanted


def _write_organ_files(out_dir, organ, tp, mask_crop, ct_crop, grid_crop):
    d = os.path.join(out_dir, "organs", organ)
    os.makedirs(d, exist_ok=True)
    mpath = os.path.join(d, f"{tp}_mask.nii.gz")
    cpath = os.path.join(d, f"{tp}_ct.nii.gz")
    write_nifti_gz(grid_crop.to_image(mask_crop.astype(np.uint8)), mpath)
    write_nifti_gz(grid_crop.to_image(ct_crop.astype(np.int16)), cpath)
    return mpath, cpath


def build_package(job_out, out_dir, organs=None, face_budget=FACE_BUDGET_DEFAULT, smooth_iters=5, floors=None):
    t_start = time.time()
    with open(os.path.join(job_out, "manifest.json")) as f:
        manifest = json.load(f)
    names = {int(k): v for k, v in (manifest.get("label_names") or {}).items()}
    if not names:
        raise ValueError("the register manifest has no label_names")
    ref = manifest["reference"]
    order, order_basis = order_timepoints(manifest)
    organ_list = choose_organs(organs, names)
    os.makedirs(out_dir, exist_ok=True)
    fc = _contract()
    floors_doc, floors_sha = None, None
    if floors:
        with open(floors) as f:
            floors_doc = json.load(f)
        if floors_doc.get("schema") != FLOORS_SCHEMA:
            raise ValueError(f"the floors file has schema {floors_doc.get('schema')}, expected {FLOORS_SCHEMA}")
        floors_sha = sha256_file(floors)

    # native scans
    scans = {}
    for tp in order:
        ct_arr, ct_grid = read_image(os.path.join(job_out, "native", tp, "ct.nii.gz"))
        lab_arr, lab_grid = read_image(os.path.join(job_out, "native", tp, "labels.nii.gz"))
        if not ct_grid.same_as(lab_grid):
            raise ValueError(f"native CT and labels of {tp} are not on the same grid")
        scans[tp] = {"ct": ct_arr, "lab": lab_arr, "grid": ct_grid}

    plans = {tp: decide_placements(manifest, tp, ref) for tp in order}

    # rigid transform of each later scan, checked on the spine before it is used
    spine_ids = organ_ids(names, "spine")
    placement = {}
    for tp in order:
        plan = plans[tp]
        entry = {"pair": plan["pair"], "rigid": dict(plan["rigid"]), "frame": dict(plan["frame"]), "tf": None}
        if tp != ref and plan["rigid"]["allowed"]:
            row = pair_row(manifest, tp, ref)
            rig_name = (row.get("transforms") or {}).get("rigid")
            rig_path = os.path.join(job_out, "pairs", row["pair"], rig_name) if rig_name else None
            if not rig_path or not os.path.isfile(rig_path):
                entry["rigid"] = {"allowed": False, "reason": "the saved rigid transform is missing"}
            else:
                tf = read_rigid(rig_path)
                rep = rigid_report(tf)
                entry["rigid"]["transform"] = {"file": os.path.relpath(rig_path, job_out), **rep}
                spine_m = np.isin(scans[tp]["lab"], spine_ids) if spine_ids else None
                spine_r = np.isin(scans[ref]["lab"], spine_ids) if spine_ids else None
                chk = (spine_distance(spine_m, scans[tp]["grid"], spine_r, scans[ref]["grid"], tf)
                       if spine_ids and spine_m.any() and spine_r.any() else None)
                manifest_assd = ((row.get("metrics") or {}).get("rigid") or {}).get("spine_assd_mm")
                if rep.get("error") or rep.get("orthonormal_error", 1) > 1e-3 or abs(rep.get("determinant", 0) - 1) > 1e-3:
                    entry["rigid"] = {**entry["rigid"], "allowed": False, "reason": f"the transform is not rigid ({rep})"}
                elif chk is None:
                    entry["rigid"] = {**entry["rigid"], "allowed": False,
                                      "reason": "the spine is not in both scans over a common range: the placement cannot be checked"}
                else:
                    entry["rigid"]["spine_check"] = {**chk, "manifest_rigid_spine_assd_mm": manifest_assd,
                                                    "max_assd_mm": SPINE_MAX_ASSD_MM, "max_difference_to_manifest_mm": SPINE_VS_MANIFEST_MM}
                    bad = []
                    if chk["assd_mm"] > SPINE_MAX_ASSD_MM:
                        bad.append(f"spine ASSD {chk['assd_mm']} mm is above {SPINE_MAX_ASSD_MM} mm")
                    if manifest_assd is not None and abs(chk["assd_mm"] - manifest_assd) > SPINE_VS_MANIFEST_MM:
                        bad.append(f"spine ASSD {chk['assd_mm']} mm differs from the register job's {manifest_assd} mm by more than "
                                   f"{SPINE_VS_MANIFEST_MM} mm")
                    if bad:
                        entry["rigid"] = {**entry["rigid"], "allowed": False, "reason": "; ".join(bad)}
                    else:
                        entry["tf"] = tf
        placement[tp] = entry

    organs_out, files = {}, []
    t_mesh = 0.0
    for organ in organ_list:
        ids = organ_ids(names, organ)
        per_tp, present_any = {}, False
        for tp in order:
            sc = scans[tp]
            mask = np.isin(sc["lab"], ids) if ids else np.zeros(sc["lab"].shape, bool)
            n = int(mask.sum())
            if n == 0:
                per_tp[tp] = {"present": False}
                continue
            present_any = True
            grid = sc["grid"]
            (z0, z1), (y0, y1), (x0, x1) = bbox_zyx(mask)
            m = CROP_MARGIN_VOX
            z0, y0, x0 = max(0, z0 - m), max(0, y0 - m), max(0, x0 - m)
            z1, y1, x1 = min(mask.shape[0], z1 + m), min(mask.shape[1], y1 + m), min(mask.shape[2], x1 + m)
            mask_crop = mask[z0:z1, y0:y1, x0:x1]
            ct_crop = np.clip(np.rint(sc["ct"][z0:z1, y0:y1, x0:x1]), *CT_CLIP).astype(np.int16)
            grid_crop = grid.cropped((x0, y0, z0), (x1 - x0, y1 - y0, z1 - z0))
            vox_ml = grid.voxel_volume_mm3() / 1000.0
            ncomp, lcf = component_stats(mask)
            zyx = np.argwhere(mask)
            centroid = grid.index_to_lps(zyx[:, ::-1].mean(axis=0))[0]
            lo_i, hi_i = zyx[:, ::-1].min(axis=0), zyx[:, ::-1].max(axis=0)
            corners = grid.index_to_lps(np.array([[(lo_i, hi_i)[a][0], (lo_i, hi_i)[b][1], (lo_i, hi_i)[c][2]]
                                                  for a in (0, 1) for b in (0, 1) for c in (0, 1)]))
            rec = {"present": True, "voxel_count": n, "volume_ml": float(n * vox_ml),
                   "volume_source": "native_labels", "label_ids": ids,
                   "centroid_lps_mm": [round(float(v), 3) for v in centroid],
                   "bbox_lps_mm": {"min": [round(float(v), 2) for v in corners.min(axis=0)],
                                   "max": [round(float(v), 2) for v in corners.max(axis=0)]},
                   "hu": hu_stats(sc["ct"][mask]), "components": ncomp, "largest_component_fraction": round(lcf, 4),
                   "scan_edge": scan_edge(mask), "files": {}}
            mpath, cpath = _write_organ_files(out_dir, organ, tp, mask_crop, ct_crop, grid_crop)
            spath = os.path.join(out_dir, "organs", organ, f"{tp}_slices.json")
            with open(spath, "w") as f:
                json.dump(slice_table(mask_crop, ct_crop, grid_crop, z0), f, separators=(",", ":"))
            rec["files"].update({"mask": os.path.relpath(mpath, out_dir), "ct": os.path.relpath(cpath, out_dir),
                                 "slices": os.path.relpath(spath, out_dir)})
            rec["crop"] = {"start_zyx": [z0, y0, x0], "stop_zyx": [z1, y1, x1], "margin_voxels": m, "hu_storage": "int16, clipped "
                           f"{CT_CLIP[0]} to {CT_CLIP[1]}, rounded"}
            files += [mpath, cpath, spath]

            # meshes
            t0 = time.time()
            if n >= MIN_MESH_VOXELS:
                extras_base = {"schema": SCHEMA, "organ": organ, "timepoint": tp, "job_id": manifest.get("job_id"),
                               "axes": GLTF_AXES, "disclaimer": "Decision support, not a diagnosis."}
                mesh, info = mesh_from_mask(mask_crop, grid_crop, smooth_iters=smooth_iters, face_budget=face_budget)
                npath = os.path.join(out_dir, "organs", organ, f"{tp}_native.glb")
                write_glb(mesh, npath, organ, {**extras_base, "placement": "native",
                                               "coordinate_frame": f"patient LPS of the scan {tp}"})
                rec["mesh"] = {"native": {"file": os.path.relpath(npath, out_dir), **info}}
                files.append(npath)
                plc = placement[tp]
                if tp == ref:
                    rec["mesh"]["rigid"] = {"status": "reference scan: the native mesh is in the reference frame",
                                            "file": rec["mesh"]["native"]["file"]}
                    rec["mesh"]["frame"] = {"status": "reference scan: the native mesh is in the reference frame",
                                            "file": rec["mesh"]["native"]["file"]}
                else:
                    if plc["tf"] is not None:
                        from_tf = mesh.copy()
                        from_tf.vertices = place_points(mesh.vertices, plc["tf"])
                        rpath = os.path.join(out_dir, "organs", organ, f"{tp}_rigid.glb")
                        write_glb(from_tf, rpath, organ, {**extras_base, "placement": "rigid",
                                                          "coordinate_frame": f"patient LPS of the reference scan {ref}",
                                                          "transform": plc["rigid"].get("transform", {}).get("file")})
                        rec["mesh"]["rigid"] = {"status": "built", "file": os.path.relpath(rpath, out_dir),
                                                "mesh_volume_ml": float(from_tf.volume / 1000.0)}
                        files.append(rpath)
                    else:
                        rec["mesh"]["rigid"] = {"status": "withheld", "reason": plc["rigid"]["reason"]}
                    withheld = None
                    if not plc["frame"]["allowed"]:
                        withheld = plc["frame"]["reason"]
                    elif organ in LUNG_ORGANS and plans[tp]["lungs_frame_withheld"]:
                        withheld = ("the lung volume changed and the breath does not explain it: the lung surfaces of this pair are not "
                                    "comparable, so the lungs are placed by the rigid frame only")
                    if withheld:
                        rec["mesh"]["frame"] = {"status": "withheld", "reason": withheld}
                    else:
                        fpath_in = os.path.join(job_out, "frame", f"{tp}_labels.nii.gz")
                        if not os.path.isfile(fpath_in):
                            rec["mesh"]["frame"] = {"status": "withheld", "reason": "the job has no warped label map for this scan"}
                        else:
                            warr, wgrid = read_image(fpath_in)
                            wmask = np.isin(warr, ids)
                            if wmask.sum() < MIN_MESH_VOXELS:
                                rec["mesh"]["frame"] = {"status": "withheld", "reason": "the organ is not in the warped label map"}
                            else:
                                (fz0, fz1), (fy0, fy1), (fx0, fx1) = bbox_zyx(wmask)
                                fz0, fy0, fx0 = max(0, fz0 - 1), max(0, fy0 - 1), max(0, fx0 - 1)
                                fz1, fy1, fx1 = min(wmask.shape[0], fz1 + 1), min(wmask.shape[1], fy1 + 1), min(wmask.shape[2], fx1 + 1)
                                fmesh, finfo = mesh_from_mask(wmask[fz0:fz1, fy0:fy1, fx0:fx1],
                                                              wgrid.cropped((fx0, fy0, fz0), (fx1 - fx0, fy1 - fy0, fz1 - fz0)),
                                                              smooth_iters=smooth_iters, face_budget=face_budget)
                                fpath = os.path.join(out_dir, "organs", organ, f"{tp}_frame.glb")
                                write_glb(fmesh, fpath, organ, {**extras_base, "placement": "deformable_frame",
                                                                "coordinate_frame": f"patient LPS of the reference scan {ref}",
                                                                "reading": "shape normalised to the reference; not a size measurement"})
                                ref_mask = np.isin(scans[ref]["lab"], ids)
                                ref_vol = float(ref_mask.sum() * scans[ref]["grid"].voxel_volume_mm3() / 1000.0)
                                cut_in = [t for t, flag in ((tp, rec["scan_edge"]["cut_by_scan_range"]),
                                                            (ref, bool(ref_mask.any()) and scan_edge(ref_mask)["cut_by_scan_range"])) if flag]
                                rec["mesh"]["frame"] = {
                                    "status": "built", "file": os.path.relpath(fpath, out_dir), **finfo,
                                    "voxel_volume_ml": float(wmask.sum() * wgrid.voxel_volume_mm3() / 1000.0),
                                    "reference_native_volume_ml": ref_vol,
                                    "reading": "the warped label has the reference volume by construction; it is not a size measurement"}
                                if cut_in:
                                    rec["mesh"]["frame"]["caution"] = ("the organ is cut by the scan range in " + ", ".join(cut_in) +
                                                                       ": its warped label does not describe the whole organ")
                                files.append(fpath)
            else:
                rec["mesh"] = {"native": {"status": "not built", "reason": f"fewer than {MIN_MESH_VOXELS} voxels"}}
            t_mesh += time.time() - t0
            per_tp[tp] = rec
        if present_any:
            organs_out[organ] = {"label_ids": ids, "per_timepoint": per_tp}
        else:
            organs_out[organ] = {"label_ids": ids, "per_timepoint": per_tp, "absent_in_all_timepoints": True}
        log(f"{organ}: " + ", ".join(f"{tp} {per_tp[tp].get('volume_ml', 0):.1f} ml" for tp in order if per_tp[tp].get("present")))

    # volume change from the native volumes
    lung_cmp = (manifest.get("lung_volume") or {}).get("comparisons") or {}
    for organ, orec in organs_out.items():
        ptp = orec["per_timepoint"]
        rows = {}
        for kind in ("vs_reference", "vs_previous"):
            rows[kind] = {}
        for i, tp in enumerate(order):
            cur = ptp.get(tp) or {}
            for kind, other in (("vs_reference", ref if tp != ref else None), ("vs_previous", order[i - 1] if i > 0 else None)):
                if other is None:
                    continue
                prev = ptp.get(other) or {}
                row = {"against": other}
                if not (cur.get("present") and prev.get("present")):
                    row.update({"delta_assessable": False, "reason": "the organ is not segmented in both scans"})
                else:
                    cut = [t for t, r in ((tp, cur), (other, prev)) if r["scan_edge"]["cut_by_scan_range"]]
                    d = cur["volume_ml"] - prev["volume_ml"]
                    row.update({"delta_ml": d, "delta_pct": (100.0 * d / prev["volume_ml"]) if prev["volume_ml"] else None,
                                "from_ml": prev["volume_ml"], "to_ml": cur["volume_ml"]})
                    if cut:
                        row.update({"delta_assessable": False,
                                    "reason": "the organ touches the edge of the scan in " + ", ".join(cut) +
                                              ": its volume there is a lower bound"})
                    else:
                        row["delta_assessable"] = True
                    if organ in LUNG_ORGANS:
                        key = f"{tp}_to_{ref}" if kind == "vs_reference" else None
                        lc = lung_cmp.get(key) if key else None
                        if lc:
                            row["lung_volume_explanation"] = {k: lc.get(k) for k in (
                                "computed", "explained_by", "real_change_supported", "delta_volume_ml", "delta_volume_frac",
                                "delta_aerated_mass_frac", "explanation")}
                if organ in VOLUME_VARIES_WITH:
                    row["volume_varies_with"] = VOLUME_VARIES_WITH[organ]
                if floors_doc is not None:
                    fl = (floors_doc.get("organs") or {}).get(organ) or {}
                    fpct = fl.get("floor_pct")
                    row["floor_pct"] = fpct
                    if fpct is None:
                        row["exceeds_measured_floor"] = None
                        row.setdefault("floor_note", "no floor has been measured for this organ")
                    elif not row.get("delta_assessable") or row.get("delta_pct") is None:
                        row["exceeds_measured_floor"] = None
                    else:
                        row["exceeds_measured_floor"] = bool(abs(row["delta_pct"]) > fpct)
                rows[kind][tp] = row
        fl = ((floors_doc or {}).get("organs") or {}).get(organ) if floors_doc is not None else None
        floor_rec = None
        if fl and fl.get("floor_pct") is not None:
            floor_rec = {"floor_pct": fl["floor_pct"], "floor_ml": fl.get("floor_ml"), "set_by": fl.get("set_by"),
                         "sources_used": fl.get("sources_used"),
                         "n_by_source": {k: (v or {}).get("n") for k, v in (fl.get("by_source") or {}).items()},
                         "excludes": floors_doc.get("excludes"), "file": "floors.json"}
        reading = ("Volume change is reported, not called. No floor has been measured for this organ." if floor_rec is None else
                   "A change larger than the floor is larger than the variation between scans of unchanged anatomy seen in the listed sources. "
                   "A change inside it cannot be told from that variation. Neither is a clinical call.")
        if floors_doc is None:
            reading = "Volume change is reported, not called. No floor has been measured for this organ."
        orec["change"] = {"basis": "native_labels", "repeatability_floor": floor_rec,
                          **({"volume_varies_with": VOLUME_VARIES_WITH[organ]} if organ in VOLUME_VARIES_WITH else {}),
                          "reading": reading, **rows}

    pkg = {
        "schema": SCHEMA,
        "decision_support": "Decision support for a radiologist, not a diagnosis.",
        "source": {"register_job_id": manifest.get("job_id"), "register_schema": manifest.get("schema"),
                   "register_manifest_sha256": sha256_file(os.path.join(job_out, "manifest.json")),
                   "wallet": manifest.get("wallet"), "anatomy": manifest.get("anatomy"), "reference": ref,
                   "protocol_mode": manifest.get("protocol_mode"), "gate": manifest.get("gate"),
                   "engine_sha256": (manifest.get("software") or {}).get("engine_sha256"),
                   "image_digest": (manifest.get("software") or {}).get("image_digest")},
        "conventions": {"glb_axes": GLTF_AXES, "lps_to_gltf": "(x, y, z) mm -> (x, z, -y) / 1000",
                        "nifti": "patient LPS, as written by SimpleITK; origin, spacing and direction are in each file",
                        "volume": "voxel count times voxel volume of the native label map; never from a warped label map",
                        "ct_crop": f"int16 HU clipped {CT_CLIP[0]} to {CT_CLIP[1]}, bounding box of the organ plus {CROP_MARGIN_VOX} voxels"},
        "timepoints": [{"label": t["label"], "study_uid": t.get("study_uid"), "series_uid": t.get("series_uid"),
                        "protocol": clean_protocol(t.get("protocol")), "comparability_to_reference":
                            (t.get("versus_reference") or {}).get("comparability")}
                       for t in manifest["timepoints"]],
        "order": order, "order_basis": order_basis, "reference": ref,
        "placements": {tp: {"pair": placement[tp]["pair"], "rigid": placement[tp]["rigid"], "frame": placement[tp]["frame"]}
                       for tp in order},
        "organs": organs_out,
        "registry": {"biocid": None},
    }
    if floors_doc is not None:
        fdest = os.path.join(out_dir, "floors.json")
        shutil.copy(floors, fdest)
        files.append(fdest)
        pkg["floors"] = {"file": "floors.json", "sha256": floors_sha, "schema": floors_doc.get("schema"),
                         "sources": floors_doc.get("sources"), "excludes": floors_doc.get("excludes"), "rule": floors_doc.get("rule")}
    # file index
    index = []
    for p in sorted(set(files)):
        index.append({"path": os.path.relpath(p, out_dir), "bytes": os.path.getsize(p), "sha256": sha256_file(p)})
    pkg["files"] = index
    pkg["build"] = {"tool": "organ_package.py", "tool_sha256": sha256_file(os.path.abspath(__file__)),
                    "frame_contract_sha256": sha256_file(os.path.abspath(fc.__file__)),
                    "built_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "seconds": round(time.time() - t_start, 1), "mesh_seconds": round(t_mesh, 1),
                    "face_budget": face_budget, "versions": _versions()}
    with open(os.path.join(out_dir, "package.json"), "w") as f:
        json.dump(_clean_json(pkg), f, indent=1, sort_keys=True)
    with open(os.path.join(out_dir, "SHA256SUMS"), "w") as f:
        for e in index + [{"path": "package.json", "sha256": sha256_file(os.path.join(out_dir, "package.json"))}]:
            f.write(f"{e['sha256']}  {e['path']}\n")
    log(f"built {len(index)} files in {pkg['build']['seconds']} s")
    return pkg


def _versions():
    out = {}
    for m in ("numpy", "scipy", "SimpleITK", "skimage", "trimesh"):
        try:
            out[m] = __import__(m).__version__ if m != "SimpleITK" else __import__(m).Version.VersionString()
        except Exception:
            out[m] = None
    return out


def _clean_json(o):
    if isinstance(o, dict):
        return {str(k): _clean_json(v) for k, v in o.items() if not callable(v) and k != "tf"}
    if isinstance(o, (list, tuple)):
        return [_clean_json(v) for v in o]
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    return o


# ---------------------------------------------------------------------------------------------------------------------
def verify_package(pkg_dir):
    """Read the package back. Hashes, no stray files, volumes recomputed from the mask files, mesh bounds inside the recorded box."""
    problems = []
    ppath = os.path.join(pkg_dir, "package.json")
    if not os.path.isfile(ppath):
        return {"ok": False, "problems": ["package.json is missing"]}
    with open(ppath) as f:
        pkg = json.load(f)
    if pkg.get("schema") != SCHEMA:
        problems.append(f"schema is {pkg.get('schema')}")
    listed = {e["path"]: e for e in pkg.get("files", [])}
    for path, e in listed.items():
        full = os.path.join(pkg_dir, path)
        if not os.path.isfile(full):
            problems.append(f"missing file: {path}")
            continue
        if os.path.getsize(full) != e["bytes"] or sha256_file(full) != e["sha256"]:
            problems.append(f"changed file: {path}")
    on_disk = set()
    for root, _, fs in os.walk(pkg_dir):
        for fn in fs:
            rel = os.path.relpath(os.path.join(root, fn), pkg_dir)
            if rel not in ("package.json", "SHA256SUMS"):
                on_disk.add(rel)
    for extra in sorted(on_disk - set(listed)):
        problems.append(f"unlisted file: {extra}")
    sums = os.path.join(pkg_dir, "SHA256SUMS")
    if not os.path.isfile(sums):
        problems.append("SHA256SUMS is missing")
    else:
        for line in open(sums):
            h, _, p = line.strip().partition("  ")
            if p == "package.json" and sha256_file(ppath) != h:
                problems.append("changed file: package.json")
    if pkg.get("floors"):
        fp = os.path.join(pkg_dir, pkg["floors"]["file"])
        if not os.path.isfile(fp):
            problems.append("the floors file named by the package is missing")
        else:
            if sha256_file(fp) != pkg["floors"]["sha256"]:
                problems.append("the floors file differs from the hash the package names")
            fdoc = json.load(open(fp))
            for organ, orec in (pkg.get("organs") or {}).items():
                rec_floor = ((orec.get("change") or {}).get("repeatability_floor") or {}).get("floor_pct")
                file_floor = ((fdoc.get("organs") or {}).get(organ) or {}).get("floor_pct")
                if rec_floor != file_floor and not (rec_floor is None and file_floor is None):
                    problems.append(f"floor of {organ} in the package ({rec_floor}) differs from the floors file ({file_floor})")
    # semantic re-checks that do not trust the build path
    for organ, orec in (pkg.get("organs") or {}).items():
        for tp, rec in (orec.get("per_timepoint") or {}).items():
            if not rec.get("present"):
                continue
            mfile = (rec.get("files") or {}).get("mask")
            if mfile and os.path.isfile(os.path.join(pkg_dir, mfile)):
                arr, grid = read_image(os.path.join(pkg_dir, mfile))
                vol = float((arr > 0).sum() * grid.voxel_volume_mm3() / 1000.0)
                if abs(vol - rec["volume_ml"]) > 1e-9 * max(1.0, abs(vol)):
                    problems.append(f"volume of {organ} {tp} differs from its mask file: {rec['volume_ml']} vs {vol}")
            for kind, mrec in (rec.get("mesh") or {}).items():
                gfile = mrec.get("file") if isinstance(mrec, dict) else None
                if gfile and os.path.isfile(os.path.join(pkg_dir, gfile)):
                    ex = glb_extras(os.path.join(pkg_dir, gfile))
                    if not ex or ex.get("schema") != SCHEMA or ex.get("organ") != organ:
                        problems.append(f"mesh {gfile} does not carry its own description")
                        continue
                    if mrec.get("closed_manifold") is True or (kind == "rigid" and (rec["mesh"].get("native") or {}).get("closed_manifold") is True):
                        import trimesh
                        sc = trimesh.load(os.path.join(pkg_dir, gfile), file_type="glb", force="scene")
                        g = next(iter(sc.geometry.values()))
                        bnd, nonman = edge_report(g)
                        if bnd or nonman:
                            problems.append(f"mesh {gfile} is recorded as closed manifold but has {bnd} boundary and {nonman} non-manifold edges")
                    if kind == "native":
                        v = load_glb_vertices_lps(os.path.join(pkg_dir, gfile))
                        lo, hi = np.array(rec["bbox_lps_mm"]["min"]), np.array(rec["bbox_lps_mm"]["max"])
                        slack = 3.0
                        if (v.min(axis=0) < lo - slack).any() or (v.max(axis=0) > hi + slack).any():
                            problems.append(f"mesh {gfile} lies outside the organ's recorded box")
    return {"ok": not problems, "problems": problems, "files_checked": len(listed)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--job-out", required=True, help="the out/ folder of a finished imaging-register job")
    b.add_argument("--out", required=True)
    b.add_argument("--organs", default="default", help="default, all, or a comma list")
    b.add_argument("--face-budget", type=int, default=FACE_BUDGET_DEFAULT)
    b.add_argument("--floors", default=None, help="a floors file of organ_floor.py (schema organ-volume-floors/1)")
    v = sub.add_parser("verify")
    v.add_argument("package")
    args = ap.parse_args(argv)
    if args.cmd == "build":
        if os.path.exists(args.out) and os.listdir(args.out):
            print(f"refusing to build into a folder that is not empty: {args.out}", file=sys.stderr)
            return 2
        build_package(args.job_out, args.out, organs=args.organs, face_budget=args.face_budget, floors=args.floors)
        res = verify_package(args.out)
        print(json.dumps({"verify": res}, indent=1))
        return 0 if res["ok"] else 1
    res = verify_package(args.package)
    print(json.dumps(res, indent=1))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
