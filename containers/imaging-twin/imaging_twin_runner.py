#!/usr/bin/env python3
"""
imaging_twin_runner.py — GenoBank "3D Organ TimeMachine" pipeline (Phase 1 backbone).

The server-side execution surface that biofs-node dispatches to on a GPU VM for an
`imaging-twin` job. Given two CT timepoints of the SAME anatomy (a baseline + a
follow-up, each a primary axial soft-tissue series already in the patient's vault),
it produces a longitudinal change map:

  resolve series -> DICOM->NIfTI -> isotropic/HU normalize -> TotalSegmentator organ
  masks per timepoint -> ANTs SyN registration (affine + deformable) -> deltas
  (per-organ volume table, Jacobian growth/shrink map, registered subtraction,
   PyRadiomics delta-radiomics, resection-bed flag) -> per-organ glTF meshes ->
  manifest -> GCS.

Decision-support, NOT diagnosis. De-identified: only wallet + study_uid + anonymous
organ/region labels appear in any output (no PatientName/ID/DOB).

Invocation (env vars, mirroring clara-run-job.sh; CLI flags override):
  WALLET, ANATOMY, BASELINE_STUDY, BASELINE_SERIES, FOLLOWUP_STUDY, FOLLOWUP_SERIES,
  IMAGING_BUCKET (src, default genobank-health-imaging), OUTPUT_BUCKET (default same),
  JOB_ID
"""
import os, sys, json, time, shutil, subprocess, tempfile, argparse, traceback
import numpy as np

def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}] [twin]", *a, flush=True)

# ----- anatomy-aware stable anchors + organs of interest (TotalSegmentator v2 labels) -----
# Each anatomy gets its own registration anchors (stable in-FOV bones/vessels), the
# organs we mesh + report volumes for, and the muscle group for sarcopenia. Chest cannot
# use lumbar L1-L3 (out of FOV) so it anchors on mid-thoracic vertebrae + aorta + sternum.
_ANATOMY = {
    "abdomen": {
        "anchors": ["vertebrae_L1", "vertebrae_L2", "vertebrae_L3", "aorta"],
        "organs": [
            "liver", "spleen", "kidney_left", "kidney_right", "pancreas", "gallbladder",
            "stomach", "urinary_bladder", "aorta", "inferior_vena_cava",
            "autochthon_left", "autochthon_right", "iliopsoas_left", "iliopsoas_right",
            "vertebrae_L1", "vertebrae_L2", "vertebrae_L3",
        ],
        "muscle": ["autochthon_left", "autochthon_right", "iliopsoas_left", "iliopsoas_right"],
    },
    "chest": {
        "anchors": ["vertebrae_T8", "vertebrae_T9", "vertebrae_T10", "aorta", "sternum"],
        "organs": [
            "lung_upper_lobe_left", "lung_lower_lobe_left",
            "lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right",
            "heart", "aorta", "pulmonary_artery", "esophagus", "trachea",
            "autochthon_left", "autochthon_right",
            "vertebrae_T6", "vertebrae_T7", "vertebrae_T8", "vertebrae_T9", "vertebrae_T10",
        ],
        "muscle": ["autochthon_left", "autochthon_right"],
    },
}
# defaults = abdomen (backward compat for code paths that read the module globals)
STABLE_ANCHORS = _ANATOMY["abdomen"]["anchors"]
ORGANS = _ANATOMY["abdomen"]["organs"]
MUSCLE = _ANATOMY["abdomen"]["muscle"]


def select_anatomy(name):
    a = _ANATOMY.get(str(name or "abdomen").lower(), _ANATOMY["abdomen"])
    return a["anchors"], a["organs"], a["muscle"]

# ----------------------------------------------------------------------------------
def sh(cmd, **kw):
    log("$", cmd if isinstance(cmd, str) else " ".join(cmd))
    return subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kw)

def gcs_prefix(bucket, wallet, study, series):
    return f"gs://{bucket}/{wallet}/imaging/{study}/{series}/"

def stage_series(bucket, wallet, study, series, dest):
    """Copy one series' DICOMs from GCS to local scratch (server-side; never the laptop)."""
    os.makedirs(dest, exist_ok=True)
    sh(["gcloud", "storage", "cp", "--recursive", gcs_prefix(bucket, wallet, study, series) + "*", dest])
    n = len([f for f in os.listdir(dest) if f.endswith(".dcm")])
    log(f"staged {n} DICOM slices -> {dest}")
    if n == 0:
        raise RuntimeError(f"no DICOM slices staged for series {series}")
    return dest

def dcm_to_nifti(dcm_dir, out_nii):
    """Read the DICOM series directly with SimpleITK (proper slice ordering +
    geometry; no external dcm2niix binary). If the folder holds >1 series, pick
    the one with the most slices (the primary volume)."""
    import SimpleITK as sitk
    reader = sitk.ImageSeriesReader()
    series_ids = reader.GetGDCMSeriesIDs(dcm_dir)
    if not series_ids:
        raise RuntimeError(f"no DICOM series found in {dcm_dir}")
    best = max(series_ids, key=lambda sid: len(reader.GetGDCMSeriesFileNames(dcm_dir, sid)))
    files = reader.GetGDCMSeriesFileNames(dcm_dir, best)
    reader.SetFileNames(files)
    img = reader.Execute()
    sitk.WriteImage(img, out_nii)
    log(f"NIfTI {os.path.basename(out_nii)} <- {len(files)} slices (series {best[-12:]})")
    return out_nii

def preprocess(in_nii, out_nii, iso=1.0, hu_hi=3000):
    """Reorient RAS, resample to isotropic `iso` mm, clamp HU. PIXEL-GRADE: default
    iso=1.0mm (3.4x finer voxels than 1.5mm -> small lesions/changes clear the
    quantization floor); a FLOOR (iso >= the acquired min spacing) prevents fabricating
    through-plane detail from thick slices; B-spline (not linear) avoids pre-blurring
    small structures; the HU upper clamp is widened to 3000 (NOT 1024) so enhancing
    lesions / vessels / calcifications / surgical clips keep their high-attenuation
    signal for subtraction + radiomics."""
    import SimpleITK as sitk
    img = sitk.ReadImage(in_nii)
    img = sitk.DICOMOrient(img, "RAS")
    sp = img.GetSpacing(); sz = img.GetSize()
    iso = max(float(iso), float(min(sp)))        # never upsample the acquired axis
    new_sp = [iso, iso, iso]
    new_sz = [int(round(sz[i] * sp[i] / iso)) for i in range(3)]
    rs = sitk.ResampleImageFilter()
    rs.SetOutputSpacing(new_sp); rs.SetSize(new_sz)
    rs.SetOutputOrigin(img.GetOrigin()); rs.SetOutputDirection(img.GetDirection())
    rs.SetInterpolator(sitk.sitkBSpline); rs.SetDefaultPixelValue(-1024)
    img = rs.Execute(img)
    img = sitk.Clamp(img, lowerBound=-1024, upperBound=float(hu_hi))
    sitk.WriteImage(img, out_nii)
    log(f"preprocessed -> {os.path.basename(out_nii)} iso={iso}mm (acq min {min(sp):.2f}mm) size={new_sz} HU<= {hu_hi}")
    return out_nii

def segment(in_nii, out_dir, fast=False):
    """TotalSegmentator (Python API) -> one mask .nii.gz per structure in out_dir."""
    from totalsegmentator.python_api import totalsegmentator
    os.makedirs(out_dir, exist_ok=True)
    log(f"TotalSegmentator on {os.path.basename(in_nii)} (fast={fast}) ...")
    totalsegmentator(in_nii, out_dir, fast=fast)
    masks = [f[:-7] for f in os.listdir(out_dir) if f.endswith(".nii.gz")]
    log(f"TotalSegmentator produced {len(masks)} structures")
    return out_dir

def mask_volume_ml(mask_nii):
    import SimpleITK as sitk
    m = sitk.ReadImage(mask_nii)
    arr = sitk.GetArrayFromImage(m)
    vox = np.prod(m.GetSpacing())  # mm^3
    return float((arr > 0).sum() * vox / 1000.0)  # mL (cc)

def organ_volumes(seg_dir):
    out = {}
    for organ in ORGANS:
        f = os.path.join(seg_dir, organ + ".nii.gz")
        if os.path.exists(f):
            try:
                out[organ] = round(mask_volume_ml(f), 2)
            except Exception as e:
                log(f"vol {organ} failed: {e}")
    return out

def register(fixed_nii, moving_nii, out_dir, reg_iso=1.0):
    """ANTs SyNRA (rigid+affine+deformable) on an ADAPTIVE grid: reg_iso is coarsened
    just enough to keep the deformable cost + displacement-field RAM bounded by a voxel
    budget, so a spine-cropped FOV registers fine while a FULL-FOV scan auto-falls-back
    to ~1.5mm (full-FOV native/1.0mm SyN is the pipeline's biggest time/RAM risk — the
    spine crop bails when the two scans share no physical-z range, which is common). The
    sensitivity-critical segmentation/volumes/meshes/VISTA-3D stay on the 1.0mm grid;
    registration only needs to ALIGN. Returns (warped, jacobian, transforms)."""
    import ants, SimpleITK as sitk
    os.makedirs(out_dir, exist_ok=True)
    MAX_REG_VOX = int(os.getenv("MAX_REG_VOX", str(28_000_000)))   # ~1.5mm full-abd-FOV
    fim = sitk.ReadImage(fixed_nii); fsp = fim.GetSpacing(); fsz = fim.GetSize()
    eff_iso = max(float(reg_iso), float(min(fsp)))
    while eff_iso < 2.0:                       # coarsen until the grid fits the budget
        nsz = [int(round(fsz[i] * fsp[i] / eff_iso)) for i in range(3)]
        if int(np.prod(nsz)) <= MAX_REG_VOX:
            break
        eff_iso *= 1.12
    def _to_iso(p, tag):
        im = sitk.ReadImage(p); sp = im.GetSpacing()
        if abs(min(sp) - eff_iso) < 1e-2:
            return p
        sz = im.GetSize(); nsz = [int(round(sz[i] * sp[i] / eff_iso)) for i in range(3)]
        r = sitk.ResampleImageFilter(); r.SetOutputSpacing([eff_iso] * 3); r.SetSize(nsz)
        r.SetOutputOrigin(im.GetOrigin()); r.SetOutputDirection(im.GetDirection())
        r.SetInterpolator(sitk.sitkBSpline); r.SetDefaultPixelValue(-1024)
        op = os.path.join(out_dir, f"reg_{tag}.nii.gz"); sitk.WriteImage(r.Execute(im), op)
        return op
    f_in = _to_iso(fixed_nii, "fixed"); m_in = _to_iso(moving_nii, "moving")
    fixed = ants.image_read(f_in); moving = ants.image_read(m_in)
    log(f"ANTs registration (SyNRA) at reg_iso={eff_iso:.2f}mm (grid budget {MAX_REG_VOX // 10**6}M vox) ...")
    reg = ants.registration(fixed=fixed, moving=moving, type_of_transform="SyNRA")
    warped = os.path.join(out_dir, "followup_in_baseline.nii.gz")
    ants.image_write(reg["warpedmovout"], warped)
    # Jacobian determinant of the nonlinear warp (>1 local expansion, <1 contraction)
    jac_nii = os.path.join(out_dir, "jacobian.nii.gz")
    try:
        jac = ants.create_jacobian_determinant_image(fixed, reg["fwdtransforms"][0], do_log=False)
        ants.image_write(jac, jac_nii)
    except Exception as e:
        log(f"jacobian failed: {e}"); jac_nii = None
    return warped, jac_nii, reg, eff_iso

def rigid_register_sitk(fixed_nii, moving_nii):
    """STRICT-RIGID (6-DOF) registration, SimpleITK, CPU. Mirrors the Image Time
    Machine comparator: 4mm body-mask centroid init -> exhaustive translation search
    (robust to the cranio-caudal FOV offset between two acquisitions) -> masked
    Mattes-MI gradient refine. Returns a sitk transform mapping FIXED->MOVING points
    (i.e. the transform that resamples MOVING into the FIXED/reference grid). NO
    deformation, so a real new/growing focus keeps its true size + position and is
    never smeared away (the whole point of the rigid twin)."""
    import SimpleITK as sitk
    f = sitk.Cast(sitk.ReadImage(fixed_nii), sitk.sitkFloat32)
    m = sitk.Cast(sitk.ReadImage(moving_nii), sitk.sitkFloat32)
    def iso(img, mm=4.0):
        sp, sz = img.GetSpacing(), img.GetSize()
        ns = [max(1, int(round(sz[i] * sp[i] / mm))) for i in range(3)]
        return sitk.Resample(img, ns, sitk.Transform(), sitk.sitkLinear,
                             img.GetOrigin(), [mm] * 3, img.GetDirection(), -1024.0, img.GetPixelID())
    def bodymask(img):
        b = sitk.BinaryThreshold(img, -500, 4000, 1, 0)
        b = sitk.BinaryMorphologicalClosing(b, (2, 2, 2))
        cc = sitk.RelabelComponent(sitk.ConnectedComponent(b), sortByObjectSize=True)
        return sitk.BinaryThreshold(cc, 1, 1, 1, 0)
    def centroid(mask):
        s = sitk.LabelShapeStatisticsImageFilter(); s.Execute(mask); return s.GetCentroid(1)
    flo, mlo = iso(f), iso(m)
    fmask, mmask = bodymask(flo), bodymask(mlo)
    fc, mc = centroid(fmask), centroid(mmask)
    init = sitk.Euler3DTransform(); init.SetCenter(fc)
    init.SetTranslation([mc[i] - fc[i] for i in range(3)])
    # exhaustive translation search (mainly z) — robust where a local optimizer stalls
    ex = sitk.ImageRegistrationMethod()
    ex.SetMetricAsMattesMutualInformation(numberOfHistogramBins=32)
    ex.SetMetricFixedMask(fmask); ex.SetMetricMovingMask(mmask)
    ex.SetMetricSamplingStrategy(ex.REGULAR); ex.SetMetricSamplingPercentage(0.30)
    ex.SetInterpolator(sitk.sitkLinear)
    ex.SetOptimizerAsExhaustive([0, 0, 0, 2, 2, 12])
    ex.SetOptimizerScales([1.0, 1.0, 1.0, 10.0, 10.0, 10.0])
    ex.SetInitialTransform(init, inPlace=True)
    ex.Execute(flo, mlo)
    # masked-MI rigid refine
    R = sitk.ImageRegistrationMethod()
    R.SetMetricAsMattesMutualInformation(numberOfHistogramBins=50)
    R.SetMetricFixedMask(fmask); R.SetMetricMovingMask(mmask)
    R.SetMetricSamplingStrategy(R.RANDOM); R.SetMetricSamplingPercentage(0.20, 42)
    R.SetInterpolator(sitk.sitkLinear)
    R.SetOptimizerAsRegularStepGradientDescent(2.0, 1e-4, 200, relaxationFactor=0.6)
    R.SetOptimizerScalesFromPhysicalShift()
    R.SetShrinkFactorsPerLevel([2, 1]); R.SetSmoothingSigmasPerLevel([1, 0])
    R.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    R.SetInitialTransform(init, inPlace=True)
    R.Execute(flo, mlo)
    log(f"rigid register metric={R.GetMetricValue():.4f} t={[round(t,1) for t in init.GetTranslation()]}")
    return init


def resample_mask_rigid(mask_nii, ref_ct_nii, transform, out_nii):
    """Resample an organ mask through the rigid transform into the REFERENCE grid
    (nearest-neighbor) so its mesh lands in the shared reference frame, rigidly
    aligned. The organ shape is an exact isometry (rigid) — never deformed."""
    import SimpleITK as sitk
    mask = sitk.ReadImage(mask_nii)
    ref = sitk.ReadImage(ref_ct_nii)
    out = sitk.Resample(mask, ref, transform, sitk.sitkNearestNeighbor, 0, mask.GetPixelID())
    sitk.WriteImage(out, out_nii)
    return out_nii


def crop_to_common_spine(base_ct, base_seg, foll_ct, foll_seg):
    """Crop both CT volumes to the OVERLAPPING physical z-range of the spine, so
    ANTs registers comparable anatomy. Without this, a FOV mismatch (the two scans
    cover different cranio-caudal ranges) makes the global alignment chase whole-
    image intensity and mis-register even the spine. Returns (base_crop, foll_crop)
    CT paths; falls back to the full volumes if the spine can't be localized."""
    import SimpleITK as sitk
    import glob
    def spine_z(ct, seg):
        img = sitk.ReadImage(ct)
        verts = glob.glob(os.path.join(seg, "vertebrae_*.nii.gz"))
        if not verts:
            return None, img
        acc = None
        for v in verts:
            a = sitk.GetArrayFromImage(sitk.ReadImage(v)) > 0   # z,y,x
            acc = a if acc is None else (acc | a)
        zidx = np.where(acc.any(axis=(1, 2)))[0]
        if len(zidx) == 0:
            return None, img
        z0 = img.TransformIndexToPhysicalPoint((0, 0, int(zidx.min())))[2]
        z1 = img.TransformIndexToPhysicalPoint((0, 0, int(zidx.max())))[2]
        return (min(z0, z1), max(z0, z1)), img
    rb, imgb = spine_z(base_ct, base_seg)
    rf, imgf = spine_z(foll_ct, foll_seg)
    if not rb or not rf:
        log("crop: spine not localized; registering full FOV")
        return base_ct, foll_ct
    lo = max(rb[0], rf[0]); hi = min(rb[1], rf[1])
    if hi - lo < 20:
        log(f"crop: spine overlap only {hi-lo:.0f}mm; registering full FOV")
        return base_ct, foll_ct
    def crop(img, ct):
        sz = img.GetSize()
        def zi(z):
            return img.TransformPhysicalPointToIndex((img.GetOrigin()[0], img.GetOrigin()[1], z))[2]
        a, b = sorted((zi(lo), zi(hi)))
        a = max(0, a); b = min(sz[2] - 1, b)
        out = ct.replace(".nii.gz", "_crop.nii.gz")
        sitk.WriteImage(img[:, :, a:b + 1], out)
        log(f"crop {os.path.basename(ct)} -> z[{a}:{b}] ({hi-lo:.0f}mm common spine)")
        return out
    return crop(imgb, base_ct), crop(imgf, foll_ct)

def dice(a_nii, b_nii):
    import SimpleITK as sitk
    a = sitk.GetArrayFromImage(sitk.ReadImage(a_nii)) > 0
    b = sitk.GetArrayFromImage(sitk.ReadImage(b_nii)) > 0
    if a.shape != b.shape:
        return None
    inter = np.logical_and(a, b).sum()
    denom = a.sum() + b.sum()
    return float(2 * inter / denom) if denom else None

def subtraction(baseline_nii, warped_followup_nii, out_nii):
    import SimpleITK as sitk
    a = sitk.ReadImage(baseline_nii); b = sitk.ReadImage(warped_followup_nii)
    b = sitk.Resample(b, a)
    diff = sitk.Subtract(sitk.Cast(b, sitk.sitkFloat32), sitk.Cast(a, sitk.sitkFloat32))
    sitk.WriteImage(diff, out_nii)
    return out_nii

def radiomics_delta(base_img, base_seg, foll_img, foll_seg):
    """Delta-radiomics for organs present at BOTH timepoints (shape/firstorder/texture)."""
    try:
        from radiomics import featureextractor
        import logging as _l; _l.getLogger("radiomics").setLevel(_l.ERROR)
    except Exception as e:
        log(f"pyradiomics unavailable: {e}"); return {}
    ex = featureextractor.RadiomicsFeatureExtractor()
    ex.settings["geometryTolerance"] = 1e-3
    out = {}
    for organ in ORGANS:
        bm = os.path.join(base_seg, organ + ".nii.gz"); fm = os.path.join(foll_seg, organ + ".nii.gz")
        if not (os.path.exists(bm) and os.path.exists(fm)):
            continue
        try:
            bf = ex.execute(base_img, bm); ff = ex.execute(foll_img, fm)
            feats = {}
            for k in bf:
                if k.startswith("original_") and k in ff:
                    try:
                        b = float(bf[k]); f = float(ff[k])
                        feats[k] = {"baseline": round(b, 4), "followup": round(f, 4),
                                    "delta": round(f - b, 4),
                                    "pct": (round(100 * (f - b) / b, 2) if b else None)}
                    except Exception:
                        pass
            out[organ] = feats
        except Exception as e:
            log(f"radiomics {organ} failed: {e}")
    return out

def _jac_colormap(vals):
    """Diverging blue-white-red colormap on the Jacobian determinant -> per-vertex
    RGBA uint8. <1 = local contraction (blue), 1 = no change (white), >1 = expansion
    (red). Clamped to [0.6, 1.6] for visual contrast."""
    v = np.clip(np.asarray(vals, dtype=np.float32), 0.6, 1.6)
    # normalize to t in [0,1] with 1.0 at the midpoint (t=0.5)
    t = np.where(v <= 1.0, (v - 0.6) / 0.8 * 0.5, 0.5 + (v - 1.0) / 0.6 * 0.5)
    t = np.clip(t, 0.0, 1.0)
    lo = np.array([0.18, 0.48, 1.00]); mid = np.array([0.96, 0.96, 0.96]); hi = np.array([1.00, 0.23, 0.19])
    out = np.empty((len(v), 3), dtype=np.float32)
    a = t < 0.5
    out[a]  = lo  + (mid - lo) * (t[a][:, None] / 0.5)
    out[~a] = mid + (hi - mid) * ((t[~a][:, None] - 0.5) / 0.5)
    rgba = np.concatenate([out, np.ones((len(v), 1), dtype=np.float32)], axis=1)
    return (np.clip(rgba, 0, 1) * 255).astype(np.uint8)

def mesh_organ(mask_nii, out_glb, jac_arr=None, jac_sp=None):
    """Marching cubes -> glb. When jac_arr (the Jacobian determinant resampled onto
    THIS mask's grid, z,y,x) + jac_sp (x,y,z spacing mm) are given, bake the local
    growth/shrink as per-vertex glTF color (COLOR_0) so the web viewer can show the
    Jacobian heatmap without parsing the heavy NIfTI."""
    import SimpleITK as sitk
    from skimage import measure
    import trimesh
    m = sitk.ReadImage(mask_nii)
    arr = sitk.GetArrayFromImage(m).astype(np.float32)  # z,y,x
    if arr.max() < 1:
        return None
    sp = m.GetSpacing()[::-1]  # to z,y,x
    verts, faces, _, _ = measure.marching_cubes(arr, level=0.5, spacing=sp)
    # verts are (z,y,x) physical-mm offset from voxel 0; trimesh wants (x,y,z)
    mesh = trimesh.Trimesh(vertices=verts[:, ::-1], faces=faces, process=True)
    mesh = trimesh.smoothing.filter_taubin(mesh, iterations=5)
    # pixel-grade (1.0mm) masks yield 2-3x more triangles than 1.5mm; decimate to keep
    # the per-organ glTF web-viewer-friendly. Bake the Jacobian AFTER, on the kept verts.
    FACE_BUDGET = int(os.getenv("MESH_FACE_BUDGET", "40000"))
    if len(mesh.faces) > FACE_BUDGET:
        try:
            try:
                mesh = mesh.simplify_quadric_decimation(face_count=FACE_BUDGET)
            except TypeError:
                mesh = mesh.simplify_quadric_decimation(FACE_BUDGET)
        except Exception as e:
            log(f"decimate {os.path.basename(out_glb)} skipped: {e}")
    if jac_arr is not None and jac_sp is not None:
        try:
            vx = mesh.vertices  # (x,y,z) mm offset from voxel 0, same grid as jac_arr
            ix = np.clip(np.round(vx[:, 0] / jac_sp[0]).astype(int), 0, jac_arr.shape[2] - 1)
            iy = np.clip(np.round(vx[:, 1] / jac_sp[1]).astype(int), 0, jac_arr.shape[1] - 1)
            iz = np.clip(np.round(vx[:, 2] / jac_sp[2]).astype(int), 0, jac_arr.shape[0] - 1)
            mesh.visual.vertex_colors = _jac_colormap(jac_arr[iz, iy, ix])
        except Exception as e:
            log(f"jac bake {os.path.basename(out_glb)} failed: {e}")
    mesh.export(out_glb)
    return out_glb

# ----------------------------------------------------------------------------------
def main():
    global STABLE_ANCHORS, ORGANS, MUSCLE
    ap = argparse.ArgumentParser()
    ap.add_argument("--wallet", default=os.getenv("WALLET"))
    ap.add_argument("--anatomy", default=os.getenv("ANATOMY", "abdomen"))
    ap.add_argument("--baseline-study", default=os.getenv("BASELINE_STUDY"))
    ap.add_argument("--baseline-series", default=os.getenv("BASELINE_SERIES"))
    ap.add_argument("--followup-study", default=os.getenv("FOLLOWUP_STUDY"))
    ap.add_argument("--followup-series", default=os.getenv("FOLLOWUP_SERIES"))
    # N-timepoint: ordered JSON list [{"label","study","series"}], first entry = registration
    # reference. When absent, falls back to the baseline/followup pair (full backward compat).
    ap.add_argument("--timepoints", default=os.getenv("TIMEPOINTS"))
    ap.add_argument("--src-bucket", default=os.getenv("IMAGING_BUCKET", "genobank-health-imaging"))
    ap.add_argument("--out-bucket", default=os.getenv("OUTPUT_BUCKET", "genobank-health-imaging"))
    ap.add_argument("--job-id", default=os.getenv("JOB_ID", "twin-" + str(int(time.time()))))
    ap.add_argument("--workdir", default=os.getenv("WORKDIR", "/scratch/twin"))
    ap.add_argument("--fast", action="store_true", default=os.getenv("TS_FAST") == "1")
    args = ap.parse_args()
    if not args.wallet:
        log("FATAL: --wallet required"); sys.exit(2)
    # build the ordered timepoint list (tps[0] is the reference all others register to)
    tps = []
    if args.timepoints:
        try:
            for i, t in enumerate(json.loads(args.timepoints)):
                tps.append({"label": str(t.get("label") or f"t{i}"), "study": t["study"], "series": t["series"]})
        except Exception as e:
            log(f"FATAL: --timepoints not valid JSON list of {{label,study,series}}: {e}"); sys.exit(2)
    else:
        tps = [{"label": "baseline", "study": args.baseline_study, "series": args.baseline_series},
               {"label": "followup", "study": args.followup_study, "series": args.followup_series}]
    if len(tps) < 2 or any((not t["study"] or not t["series"]) for t in tps):
        log("FATAL: need >=2 timepoints, each with study + series"); sys.exit(2)
    # sanitize labels to the artifact-safe charset (mesh files are <label>_<organ>.glb)
    import re as _re
    seen = set()
    for i, t in enumerate(tps):
        lbl = _re.sub(r"[^A-Za-z0-9_]", "_", t["label"]) or f"t{i}"
        while lbl in seen:
            lbl = lbl + "_" + str(i)
        seen.add(lbl); t["label"] = lbl
    ref = tps[0]; last = tps[-1]; n_tp = len(tps)
    # select anatomy-specific anchors / organs / muscle group (chest != abdomen)
    STABLE_ANCHORS, ORGANS, MUSCLE = select_anatomy(args.anatomy)
    log(f"anatomy={args.anatomy} n_timepoints={n_tp} organs={len(ORGANS)} anchors={STABLE_ANCHORS}")

    wd = os.path.join(args.workdir, args.job_id)
    os.makedirs(wd, exist_ok=True)
    manifest = {
        "schema": "imaging-twin/2", "job_id": args.job_id, "wallet": args.wallet,
        "anatomy": args.anatomy,
        "n_timepoints": n_tp,
        "timepoints": [{"label": t["label"], "study_uid": t["study"], "series_uid": t["series"]} for t in tps],
        # backward-compat aliases: baseline = reference (first), followup = last
        "baseline": {"study_uid": ref["study"], "series_uid": ref["series"], "label": ref["label"]},
        "followup": {"study_uid": last["study"], "series_uid": last["series"], "label": last["label"]},
        "disclaimer": "Decision-support only, not a diagnosis. Quantified change map for clinician review.",
        "stages": {},
    }
    t0 = time.time()
    try:
        # 1-3. stage + nifti + preprocess + segment EACH timepoint (N >= 2)
        vols = {}
        for t in tps:
            tp = t["label"]
            d = stage_series(args.src_bucket, args.wallet, t["study"], t["series"], os.path.join(wd, tp, "dcm"))
            raw = dcm_to_nifti(d, os.path.join(wd, tp, "raw.nii.gz"))
            pre = preprocess(raw, os.path.join(wd, tp, "ct.nii.gz"),
                             iso=float(os.getenv("ISO_MM", "1.0")), hu_hi=float(os.getenv("HU_HI", "3000")))
            seg = segment(pre, os.path.join(wd, tp, "seg"), fast=args.fast)
            vols[tp] = {"ct": pre, "seg": seg, "volumes": organ_volumes(seg)}
            import gc; gc.collect()   # free the finer-grid arrays between timepoints
        manifest["iso_mm"] = float(os.getenv("ISO_MM", "1.0"))
        manifest["stages"]["segmentation"] = "ok"
        REF = ref["label"]; LAST = last["label"]   # convenience labels for the rest of main()

        # REGISTRATION mode: "rigid" (strict 6-DOF, spot-faithful, organ meshes are exact
        # isometries resampled into the reference grid) vs "deformable" (SyNRA + Jacobian).
        RIGID = os.getenv("REGISTRATION", "deformable").strip().lower() == "rigid"
        log(f"registration mode = {'RIGID (no deformation)' if RIGID else 'deformable (SyNRA)'}")

        # 4. registration: align EACH non-reference timepoint -> the reference (tps[0]).
        rigid_tx, warps, jacs, regs, ref_crops, qc_by_tp = {}, {}, {}, {}, {}, {}
        eff_reg_iso = None; warped = jac = sub = b_ct_reg = regdir = None
        if RIGID:
            import SimpleITK as sitk
            for t in tps[1:]:
                tp = t["label"]
                rdir = os.path.join(wd, "reg_" + tp); os.makedirs(rdir, exist_ok=True)
                tx = rigid_register_sitk(vols[REF]["ct"], vols[tp]["ct"])
                rigid_tx[tp] = tx
                # QC: resample tp anchor masks via the rigid transform into the ref grid, Dice vs ref
                q = {}
                for anchor in STABLE_ANCHORS:
                    bm = os.path.join(vols[REF]["seg"], anchor + ".nii.gz")
                    fm = os.path.join(vols[tp]["seg"], anchor + ".nii.gz")
                    if os.path.exists(bm) and os.path.exists(fm):
                        try:
                            fm_a = os.path.join(rdir, f"qc_rig_{anchor}.nii.gz")
                            resample_mask_rigid(fm, vols[REF]["ct"], tx, fm_a)
                            q[anchor] = dice(bm, fm_a)
                        except Exception as e:
                            log(f"rigid qc {tp}/{anchor} failed: {e}")
                qc_by_tp[tp] = q
                import gc; gc.collect()
            manifest["registration_type"] = "rigid (no deformation)"
            manifest["registration_iso_mm"] = None
            manifest["registration_qc_dice"] = qc_by_tp.get(LAST, {})
            manifest["registration_qc_dice_by_timepoint"] = qc_by_tp
            manifest["mesh_alignment"] = ("rigid into reference grid — spot-faithful; each "
                                          "organ mesh is an exact isometry, never deformed")
            manifest["stages"]["registration"] = "ok"
        else:
            import ants
            reg_iso = float(os.getenv("REG_ISO_MM", "1.0"))
            eff_reg_iso = reg_iso
            for t in tps[1:]:
                tp = t["label"]
                rdir = os.path.join(wd, "reg_" + tp); os.makedirs(rdir, exist_ok=True)
                b_ct_reg, f_ct_reg = crop_to_common_spine(
                    vols[REF]["ct"], vols[REF]["seg"], vols[tp]["ct"], vols[tp]["seg"])
                warped_tp, jac_tp, _reg_tp, eff_reg_iso = register(b_ct_reg, f_ct_reg, rdir, reg_iso=reg_iso)
                warps[tp] = warped_tp; jacs[tp] = jac_tp; regs[tp] = _reg_tp; ref_crops[tp] = b_ct_reg
                # QC: in the reg FIXED (cropped-reference) space, Dice warped-tp vs resampled-reference anchors
                fixed_img = ants.image_read(b_ct_reg); q = {}
                for anchor in STABLE_ANCHORS:
                    bm = os.path.join(vols[REF]["seg"], anchor + ".nii.gz")
                    fm = os.path.join(vols[tp]["seg"], anchor + ".nii.gz")
                    if os.path.exists(bm) and os.path.exists(fm):
                        try:
                            bm_r = ants.resample_image_to_target(ants.image_read(bm), fixed_img, interp_type="nearestNeighbor")
                            fm_w = ants.apply_transforms(fixed_img, ants.image_read(fm), _reg_tp["fwdtransforms"], interpolator="nearestNeighbor")
                            bmp = os.path.join(rdir, f"qc_b_{anchor}.nii.gz"); ants.image_write(bm_r, bmp)
                            fmp = os.path.join(rdir, f"qc_f_{anchor}.nii.gz"); ants.image_write(fm_w, fmp)
                            q[anchor] = dice(bmp, fmp)
                        except Exception as e:
                            log(f"qc {tp}/{anchor} failed: {e}")
                qc_by_tp[tp] = q
                import gc; gc.collect()
            # compat single-values point at the LAST timepoint vs reference (the overall change)
            warped, jac, _reg, b_ct_reg = warps[LAST], jacs[LAST], regs[LAST], ref_crops[LAST]
            regdir = os.path.dirname(b_ct_reg) if os.path.isdir(os.path.dirname(b_ct_reg)) else os.path.join(wd, "reg_" + LAST)
            manifest["registration_type"] = "deformable (SyNRA)"
            manifest["registration_fov_cropped"] = bool(b_ct_reg.endswith("_crop.nii.gz"))
            manifest["registration_iso_mm"] = round(float(eff_reg_iso), 2)
            manifest["registration_iso_requested_mm"] = reg_iso
            manifest["registration_qc_dice"] = qc_by_tp[LAST]            # compat: reference vs last
            manifest["registration_qc_dice_by_timepoint"] = qc_by_tp
            manifest["stages"]["registration"] = "ok"

        # 5. deltas — per-organ volume TREND across all timepoints + first-vs-last compat
        vol_table = {}
        allorgans = set()
        for t in tps:
            allorgans.update(vols[t["label"]]["volumes"].keys())
        rvol = vols[REF]["volumes"]; lvol = vols[LAST]["volumes"]
        for organ in allorgans:
            series = [{"label": t["label"], "ml": vols[t["label"]]["volumes"].get(organ)} for t in tps]
            b = rvol.get(organ); f = lvol.get(organ)
            row = {"series": series, "baseline_ml": b, "followup_ml": f}
            if b and f:
                row["delta_ml"] = round(f - b, 2); row["pct"] = round(100 * (f - b) / b, 1)
            vol_table[organ] = row
        manifest["organ_volumes"] = vol_table
        muscle_series = [{"label": t["label"],
                          "ml": round(sum(vols[t["label"]]["volumes"].get(m, 0) for m in MUSCLE), 1)} for t in tps]
        manifest["muscle_total_ml"] = {"baseline": muscle_series[0]["ml"],
                                       "followup": muscle_series[-1]["ml"], "series": muscle_series}

        # maps (reference vs LAST = the overall change; compat filenames). Rigid mode
        # produces a RIGID subtraction (no Jacobian — that is a deformable concept);
        # deformable mode produces the warped subtraction + Jacobian.
        if RIGID:
            import SimpleITK as sitk
            rdirL = os.path.join(wd, "reg_" + LAST); os.makedirs(rdirL, exist_ok=True)
            last_aligned = os.path.join(rdirL, "last_rigid_in_ref.nii.gz")
            sitk.WriteImage(sitk.Resample(sitk.ReadImage(vols[LAST]["ct"]), sitk.ReadImage(vols[REF]["ct"]),
                            rigid_tx[LAST], sitk.sitkLinear, -1024.0), last_aligned)
            warped = last_aligned
            sub = subtraction(vols[REF]["ct"], last_aligned, os.path.join(rdirL, "subtraction.nii.gz"))
            manifest["maps"] = {"jacobian": None, "subtraction": "subtraction.nii.gz",
                                "followup_in_baseline": "followup_in_baseline.nii.gz"}
        else:
            sub = subtraction(b_ct_reg, warped, os.path.join(regdir, "subtraction.nii.gz"))
            manifest["maps"] = {"jacobian": "jacobian.nii.gz" if jac else None,
                                "subtraction": "subtraction.nii.gz",
                                "followup_in_baseline": "followup_in_baseline.nii.gz"}

        # delta-radiomics (reference vs last)
        manifest["delta_radiomics"] = radiomics_delta(
            vols[REF]["ct"], vols[REF]["seg"], vols[LAST]["ct"], vols[LAST]["seg"])
        manifest["stages"]["deltas"] = "ok"

        # resection-bed flag (abdomen only): pancreas region. Not applicable to chest.
        if str(args.anatomy).lower() == "abdomen":
            pf = vol_table.get("pancreas", {})
            manifest["resection_bed_flag"] = {
                "region": "pancreas/peripancreatic",
                "baseline_pancreas_ml": pf.get("baseline_ml"),
                "followup_pancreas_ml": pf.get("followup_ml"),
                "note": "Pancreas label unreliable post-surgical; treat as ROI for human review, not a measurement.",
            }
        else:
            manifest["resection_bed_flag"] = None

        # 6. meshes (per-organ glb per timepoint) -> GCS. Bake the reference->last Jacobian
        # growth/shrink map as per-vertex color onto the REFERENCE meshes (Jacobian lives in
        # reference space; resample onto the reference mask grid so vertex indexing aligns).
        jac_arr = jac_sp = None
        if jac:
            try:
                import SimpleITK as sitk
                ref_ct_img = sitk.ReadImage(vols[REF]["ct"])
                jimg = sitk.Resample(sitk.ReadImage(jac), ref_ct_img,
                                     sitk.Transform(), sitk.sitkLinear, 1.0)  # OOB -> 1.0 (no change)
                jac_arr = sitk.GetArrayFromImage(jimg).astype(np.float32)
                _jsp = ref_ct_img.GetSpacing()
                jac_sp = (_jsp[0], _jsp[1], _jsp[2])
                log("jacobian prepared for per-vertex baking on reference meshes")
            except Exception as e:
                log(f"jac prep failed: {e}"); jac_arr = None
        meshdir = os.path.join(wd, "mesh"); os.makedirs(meshdir, exist_ok=True)
        meshes = {}
        for t in tps:
            tp = t["label"]; meshes[tp] = []
            for organ in ORGANS:
                mp = os.path.join(vols[tp]["seg"], organ + ".nii.gz")
                if os.path.exists(mp):
                    try:
                        out_glb = os.path.join(meshdir, f"{tp}_{organ}.glb")
                        src_mask = mp
                        # RIGID: resample each non-reference timepoint's organ mask through
                        # its rigid transform into the REFERENCE grid, so the mesh lands in
                        # the shared frame, rigidly aligned (organ shape preserved exactly).
                        if RIGID and tp != REF:
                            src_mask = os.path.join(wd, "reg_" + tp, f"al_{organ}.nii.gz")
                            resample_mask_rigid(mp, vols[REF]["ct"], rigid_tx[tp], src_mask)
                        ja, js = (jac_arr, jac_sp) if tp == REF else (None, None)
                        if mesh_organ(src_mask, out_glb, jac_arr=ja, jac_sp=js):
                            meshes[tp].append(f"{tp}_{organ}.glb")
                    except Exception as e:
                        log(f"mesh {tp}/{organ} failed: {e}")
        manifest["meshes"] = meshes
        manifest["mesh_jacobian_colors"] = bool(jac_arr is not None)
        manifest["stages"]["meshes"] = "ok"

        # 7. upload outputs to GCS
        out_prefix = f"gs://{args.out_bucket}/{args.wallet}/imaging-twin/{args.job_id}/"
        # collect artifacts
        up = os.path.join(wd, "out"); os.makedirs(up, exist_ok=True)
        if jac: shutil.copy(jac, os.path.join(up, "jacobian.nii.gz"))
        shutil.copy(sub, os.path.join(up, "subtraction.nii.gz"))
        shutil.copy(warped, os.path.join(up, "followup_in_baseline.nii.gz"))
        meshes_out = os.path.join(up, "mesh"); shutil.copytree(meshdir, meshes_out, dirs_exist_ok=True)
        manifest["elapsed_sec"] = round(time.time() - t0, 1)
        manifest["status"] = "done"
        with open(os.path.join(up, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)
        sh(["gcloud", "storage", "cp", "--recursive", up + "/*", out_prefix])
        manifest["output_gcs"] = out_prefix
        log("DONE", out_prefix)
        print("TWIN_RESULT " + json.dumps({k: manifest[k] for k in
              ("status", "job_id", "output_gcs", "organ_volumes", "registration_qc_dice",
               "muscle_total_ml", "resection_bed_flag", "elapsed_sec") if k in manifest}))
    except Exception as e:
        manifest["status"] = "error"; manifest["error"] = str(e)
        log("ERROR", e); traceback.print_exc()
        print("TWIN_RESULT " + json.dumps({"status": "error", "error": str(e), "job_id": args.job_id}))
        sys.exit(1)

if __name__ == "__main__":
    main()
