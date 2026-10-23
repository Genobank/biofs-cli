"""End-to-end smoke test of register_pair and transitivity on a synthetic torso (test-only).

Three timepoints of a phantom with a body, eight vertebrae, a sternum, two lungs that
inflate differently, a liver and a spleen that move with the diaphragm, a stomach whose
content changes, heart and aorta. It exercises the landmark rigid, the column refinement,
the piecewise body/lung/viscera deformable stage, QC metrics, Jacobians, panels, transform
copies and the transitivity check, so a defect shows in minutes instead of after an hour
of real registration. Runs inside the imaging-register image."""
import os, sys, json, tempfile, time
import numpy as np
import SimpleITK as sitk

sys.path.insert(0, "/app")
import register as R
from totalsegmentator.map_to_binary import class_map

names = {int(k): v for k, v in class_map["total"].items()}
nid = {v: k for k, v in names.items()}
shape = (150, 140, 150)                    # z, y, x at 1 mm, RAS (+y anterior, +z superior)
zz, yy, xx = np.indices(shape)


def ellipsoid(c, r):
    return ((zz - c[0]) / r[0]) ** 2 + ((yy - c[1]) / r[1]) ** 2 + ((xx - c[2]) / r[2]) ** 2 <= 1


def phantom(shift, dia, stomach_full):
    """shift: global table offset (z, y, x voxels); dia: diaphragm height (z of lung bases)."""
    ct = np.full(shape, -1024, np.int16)
    lab = np.zeros(shape, np.int16)
    body = ((yy - 70) / 55.0) ** 2 + ((xx - 75) / 65.0) ** 2 <= 1
    ct[body] = 30
    for k, z0 in enumerate(range(15, 135, 15)):                     # eight vertebrae, 12 mm tall
        v = ((yy - 40) ** 2 + (xx - 75) ** 2 <= 70) & (zz >= z0) & (zz < z0 + 12)
        ct[v] = 650; lab[v] = nid[f"vertebrae_T{12 - k}"]
    st = ((yy - 112) ** 2 + (xx - 75) ** 2 <= 30) & (zz >= 70) & (zz < 125)
    ct[st] = 500; lab[st] = nid["sternum"]
    for side, cx in (("left", 42), ("right", 108)):                 # RAS: +x is the patient's right
        lung = ellipsoid((dia + 42, 75, cx), (42, 34, 28)) & (zz >= dia) & body & (lab == 0)
        ct[lung] = -850; lab[lung] = nid[f"lung_upper_lobe_{side}"]
        for vz in range(dia + 10, dia + 75, 12):                    # vessels so lungs have texture
            ves = ((zz - vz) ** 2 + (yy - 75) ** 2 <= 4) & lung
            ct[ves] = 80
    liver = ellipsoid((dia - 24, 70, 100), (30, 40, 36)) & body & (lab == 0)
    ct[liver] = 60; lab[liver] = nid["liver"]
    for vz in range(dia - 48, dia - 5, 9):
        ct[liver & ((zz - vz) ** 2 + (yy - 62) ** 2 <= 5)] = 160    # hepatic vessels
    spleen = ellipsoid((dia - 15, 55, 38), (16, 14, 12)) & body & (lab == 0)
    ct[spleen] = 55; lab[spleen] = nid["spleen"]
    stom = ellipsoid((dia - 12, 88, 58), (12, 14, 14)) & body & (lab == 0)
    ct[stom] = 10 if stomach_full else -900; lab[stom] = nid["stomach"]
    heart = ellipsoid((dia + 18, 88, 70), (18, 20, 22)) & body & (lab == 0)
    ct[heart] = 45; lab[heart] = nid["heart"]
    aorta = ((yy - 54) ** 2 + (xx - 64) ** 2 <= 36) & (zz >= 20) & (zz < 140) & (lab == 0)
    ct[aorta] = 220; lab[aorta] = nid["aorta"]
    ct = np.roll(ct, shift, axis=(0, 1, 2)); lab = np.roll(lab, shift, axis=(0, 1, 2))
    return ct, lab


def write(arr, path, origin):
    img = sitk.GetImageFromArray(arr); img.SetSpacing((1.0, 1.0, 1.0)); img.SetOrigin(origin)
    sitk.WriteImage(img, path)


wd = tempfile.mkdtemp(prefix="smoke_pair_")
tps = {}
for label, shift, dia, full, origin in (("t0", (0, 0, 0), 50, False, (-75.0, -70.0, 1000.0)),
                                        ("t1", (4, 2, -3), 56, True, (-75.0, -70.0, 900.0)),
                                        ("t2", (-3, -1, 2), 46, False, (-75.0, -70.0, 1100.0))):
    os.makedirs(os.path.join(wd, label), exist_ok=True)
    ct, lab = phantom(shift, dia, full)
    tps[label] = {"label": label, "ct": os.path.join(wd, label, "ct.nii.gz"), "labels": os.path.join(wd, label, "labels.nii.gz")}
    write(ct, tps[label]["ct"], origin); write(lab, tps[label]["labels"], origin)

groups = {
    "vertebrae": sorted(R.ids_matching(names, r"^vertebrae_[CTL]\d+$")),
    "sternum": R.ids_matching(names, r"^sternum$"),
    "lungs": R.ids_matching(names, r"^lung_"),
    "lung_left": R.ids_matching(names, r"^lung_.*_left$"),
    "lung_right": R.ids_matching(names, r"^lung_.*_right$"),
    "medium": R.ids_matching(names, r"^(aorta|trachea)$"),
    "esophagus": R.ids_matching(names, r"^esophagus$"),
    "heart_id": (R.ids_matching(names, r"^heart$") or [None])[0],
    "liver": R.ids_matching(names, r"^liver$"),
    "spleen": R.ids_matching(names, r"^spleen$"),
    "viscera_solid": R.ids_matching(names, r"^(heart|inferior_vena_cava|liver|spleen|pancreas|gallbladder|kidney_(left|right))$"),
    "viscera": R.ids_matching(names, r"^(heart|inferior_vena_cava|liver|spleen|pancreas|gallbladder|kidney_(left|right)|stomach)$"),
}
t0 = time.time()
res = {}
for mov, ref in (("t1", "t0"), ("t2", "t0"), ("t2", "t1")):
    pr = R.register_pair(wd, tps[ref], tps[mov], names, groups, 1.5, 1.5, 24000000)
    res[(mov, ref)] = pr
    d = pr["metrics"]["deformable"]
    print(json.dumps({"pair": pr["pair"], "init": pr["init"].get("method"), "regions": list(pr["apply"]),
                      "spine_assd": d["spine_assd_mm"], "lung_hd95_max": d["lung_hd95_max_mm"],
                      "lung_dice_min": d["lung_dice_min"], "organ_hd95_max": d["abdominal_organ_hd95_max_mm"],
                      "rigid_lung_hd95": pr["metrics"]["rigid"]["lung_hd95_max_mm"],
                      "rigid_organ_hd95": pr["metrics"]["rigid"]["abdominal_organ_hd95_max_mm"],
                      "fold": d["jacobian_fold_fraction"], "jac_regions": list(d["jacobian_by_region"]),
                      "artifacts": pr["artifacts"], "keep": sorted(pr["transforms"])}))
    for f in list(pr["transforms"].values()) + [pr["artifacts"]["qc_png"], pr["artifacts"]["warped_ct"],
                                                pr["artifacts"]["warped_labels"]] + pr["artifacts"]["jacobians"]:
        assert os.path.exists(os.path.join(pr["dir"], f)), f
    v, checks, hard, soft = R.evaluate_gate(pr["metrics"], None, R.gates_for("chest"))
    print("gate", pr["pair"], v, hard, soft)
tr = R.transitivity(tps["t0"], tps["t1"], tps["t2"], res[("t1", "t0")], res[("t2", "t1")], res[("t2", "t0")], names, groups)
assert tr["dice_by_target"] and tr["all_structures"]["n_structures"] > 0, tr
print("transitivity", json.dumps(tr))
json.dumps({k: {kk: vv for kk, vv in pr.items() if kk not in ("stages_fwd", "dir")} for k, pr in
            {"/".join(k): v for k, v in res.items()}.items()})       # the manifest content must serialize
d = res[("t1", "t0")]["metrics"]
assert d["deformable"]["lung_hd95_max_mm"] < d["rigid"]["lung_hd95_max_mm"], "lung deformation did not help"
assert d["deformable"]["abdominal_organ_hd95_max_mm"] < d["rigid"]["abdominal_organ_hd95_max_mm"], "viscera deformation did not help"
print(f"SMOKE PAIR PASSED in {time.time() - t0:.0f}s")
