"""Smoke test of every ANTsPy call register.py makes, on small synthetic volumes, so an API
mismatch shows in seconds instead of after an hour of registration. Test-only."""
import os, sys, tempfile
import numpy as np
import ants
import SimpleITK as sitk

sys.path.insert(0, "/app")
import register as R

tmp = tempfile.mkdtemp()

# 1) landmark transform: matrix + translation must map x -> R x + t
Rm = np.array([[0.9986, -0.0523, 0.0], [0.0523, 0.9986, 0.0], [0.0, 0.0, 1.0]])
Rm, _ = np.linalg.qr(Rm); Rm = Rm * np.sign(np.diag(Rm))[None, :]
t = np.array([3.0, -7.0, 150.0])
tx = ants.create_ants_transform(transform_type="AffineTransform", dimension=3, matrix=Rm, translation=tuple(t))
p = np.array([10.0, 20.0, 30.0])
got = np.asarray(tx.apply_to_point(tuple(p)))
assert np.allclose(got, Rm @ p + t, atol=1e-4), (got, Rm @ p + t)
ants.write_transform(tx, os.path.join(tmp, "init.mat"))
back = ants.read_transform(os.path.join(tmp, "init.mat"))
assert np.allclose(np.asarray(back.apply_to_point(tuple(p))), Rm @ p + t, atol=1e-3)
print("ok landmark transform convention")

# 2) synthetic CT-like volumes with a "spine" (bright cylinder), "lungs" (dark blobs), body
shape = (64, 64, 64)
zz, yy, xx = np.indices(shape)
def phantom(shift):
    a = np.full(shape, -1000.0, np.float32)
    body = ((yy - 32) ** 2 / 26 ** 2 + (xx - 32) ** 2 / 28 ** 2) <= 1
    a[body] = 40
    spine = ((yy - 48 + shift[1]) ** 2 + (xx - 32 + shift[2]) ** 2) <= 25
    a[spine] = 700
    for cx in (20, 44):
        lung = ((yy - 28) ** 2 + (xx - cx) ** 2 + ((zz - 34 - shift[0]) / 1.6) ** 2) <= 81
        a[lung & body] = -850
    lab = np.zeros(shape, np.int16)
    lab[spine] = 30
    lab[(a == -850)] = 10
    return a, lab
def to_img(arr):
    img = sitk.GetImageFromArray(arr); img.SetSpacing((1.5, 1.5, 1.5)); img.SetOrigin((-48.0, -48.0, 100.0))
    return img
fa, fl = phantom((0, 0, 0)); ma, ml = phantom((4, 1, -1))
paths = {}
for k, arr in (("F", fa), ("M", ma), ("FL", fl), ("ML", ml)):
    paths[k] = os.path.join(tmp, f"{k}.nii.gz"); sitk.WriteImage(to_img(arr), paths[k])
F, M = ants.image_read(paths["F"]), ants.image_read(paths["M"])
Fm = ants.image_read(paths["FL"]); Mm = ants.image_read(paths["ML"])
Fmask = Fm.new_image_like((Fm.numpy() > 0).astype(np.float32)); Mmask = Mm.new_image_like((Mm.numpy() > 0).astype(np.float32))

# 3) the rigid call exactly as register.py makes it
ident = ants.create_ants_transform(transform_type="AffineTransform", dimension=3, matrix=np.eye(3), translation=(0.0, 0.0, 0.0))
ants.write_transform(ident, os.path.join(tmp, "ident.mat"))
r_rig = ants.registration(F, M, type_of_transform="Rigid", initial_transform=[os.path.join(tmp, "ident.mat")],
                          mask=Fmask, moving_mask=Mmask, outprefix=os.path.join(tmp, "rigid_"),
                          aff_metric="mattes", aff_sampling=32, aff_random_sampling_rate=1.0,
                          aff_iterations=(50, 25, 10), aff_shrink_factors=(4, 2, 1),
                          aff_smoothing_sigmas=(2, 1, 0), mask_all_stages=True, random_seed=42, verbose=False)
print("ok rigid", [os.path.basename(x) for x in r_rig["fwdtransforms"]])

# 4) the SyNOnly call exactly as register.py makes it (4 levels), then the 3-level one
for its in ((20, 20, 10, 5), (20, 10, 5)):
    r = ants.registration(F, M, type_of_transform="SyNOnly", initial_transform=r_rig["fwdtransforms"],
                          mask=Fmask, moving_mask=Mmask, outprefix=os.path.join(tmp, f"syn{len(its)}_"),
                          syn_metric="CC", syn_sampling=2, reg_iterations=its, flow_sigma=3, total_sigma=0,
                          grad_step=0.2, mask_all_stages=True, random_seed=42, verbose=False)
    print("ok SyNOnly", len(its), "levels", [os.path.basename(x) for x in r["fwdtransforms"]],
          [os.path.basename(x) for x in r["invtransforms"]])

# 5) piecewise apply, genericLabel, Jacobian, new_image_like
sel = os.path.join(tmp, "select.nii.gz"); sitk.WriteImage(sitk.Cast(to_img((fl == 10).astype(np.uint8)), sitk.sitkUInt8), sel)
tf = {"body": r["fwdtransforms"], "regions": [{"name": "lung", "tf": r["fwdtransforms"], "select": sel}]}
wl = R.apply_stage(ants, F, ants.image_read(paths["ML"]), tf, "genericLabel", 0)
wc = R.apply_stage(ants, F, M, tf, "linear", -1024)
assert wl.shape == F.shape and wc.shape == F.shape
arr = R.zyx(wl, np.int16)
assert set(np.unique(arr)) == {0, 10, 30}, np.unique(arr)
jac = ants.create_jacobian_determinant_image(F, r["fwdtransforms"][0], do_log=False)
st = R.jacobian_stats(jac.numpy(), Fmask.numpy())
assert st and st["voxels"] > 0
ants.image_write(wl, os.path.join(tmp, "wl.nii.gz"))
print("ok piecewise apply, labels", sorted(np.unique(arr).tolist()), "jacobian p01", round(st["p01"], 3))

# 6) the metrics on the warped synthetic labels
groups = {"vertebrae": [30], "lung_left": [10], "lung_right": [10], "liver": [], "spleen": [], "medium": [], "esophagus": [], "heart_id": None}
names = {10: "lung_lower_lobe_left", 30: "vertebrae_T8"}
ref = np.transpose(Fm.numpy(), (2, 1, 0)).astype(np.int16)
valid = np.ones_like(ref, bool)
m = R.stage_metrics(ref, arr, valid, names, groups, np.array([1.5, 1.5, 1.5]), [30], (3, 60))
print("ok stage_metrics", {k: m[k] for k in ("spine_assd_mm", "lung_dice_min", "lung_hd95_max_mm", "vertebra_tre_median_mm")})
assert m["spine_assd_mm"] is not None and m["spine_assd_mm"] < 3.0, m["spine_assd_mm"]
assert m["lung_dice_min"] is not None and m["lung_dice_min"] > 0.8, m["lung_dice_min"]
print("SMOKE PASSED")
