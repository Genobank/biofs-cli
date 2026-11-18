"""End-to-end smoke test of main() on the synthetic torso (test-only). It runs the whole job path
that smoke_pair.py does not: protocol read, group building, every pair, the transitivity leg,
the gate, the consumer contract, the manifest, the output folders and the status file. Only the
four steps that need DICOM, a GPU or the network are replaced (stage, DICOM to NIfTI, resample,
segment); everything else is the production code. Runs inside the imaging-register image:
  docker run --rm --gpus all --entrypoint python -v $PWD:/t:ro imaging-register:<tag> /t/smoke_main.py
The v23b image reached production with a crash in register_pair that smoke_pair.py would have
shown, and its main() tail (manifest, consumers, outputs) had never run. This closes both."""
import contextlib, io, json, os, shutil, sys, tempfile, time
import numpy as np
import SimpleITK as sitk

sys.path.insert(0, "/app")
import register as R
from totalsegmentator.map_to_binary import class_map

names = {int(k): v for k, v in class_map["total"].items()}
nid = {v: k for k, v in names.items()}
shape = (150, 140, 150)
zz, yy, xx = np.indices(shape)


def ellipsoid(c, r):
    return ((zz - c[0]) / r[0]) ** 2 + ((yy - c[1]) / r[1]) ** 2 + ((xx - c[2]) / r[2]) ** 2 <= 1


def phantom(shift, dia, stomach_full):
    ct = np.full(shape, -1024, np.int16)
    lab = np.zeros(shape, np.int16)
    body = ((yy - 70) / 55.0) ** 2 + ((xx - 75) / 65.0) ** 2 <= 1
    ct[body] = 30
    for k, z0 in enumerate(range(15, 135, 15)):
        v = ((yy - 40) ** 2 + (xx - 75) ** 2 <= 70) & (zz >= z0) & (zz < z0 + 12)
        ct[v] = 650; lab[v] = nid[f"vertebrae_T{12 - k}"]
    st = ((yy - 112) ** 2 + (xx - 75) ** 2 <= 30) & (zz >= 70) & (zz < 125)
    ct[st] = 500; lab[st] = nid["sternum"]
    for side, cx in (("left", 42), ("right", 108)):
        lung = ellipsoid((dia + 42, 75, cx), (42, 34, 28)) & (zz >= dia) & body & (lab == 0)
        ct[lung] = -850; lab[lung] = nid[f"lung_upper_lobe_{side}"]
        for vz in range(dia + 10, dia + 75, 12):
            ves = ((zz - vz) ** 2 + (yy - 75) ** 2 <= 4) & lung
            ct[ves] = 80
    liver = ellipsoid((dia - 24, 70, 100), (30, 40, 36)) & body & (lab == 0)
    ct[liver] = 60; lab[liver] = nid["liver"]
    for vz in range(dia - 48, dia - 5, 9):
        ct[liver & ((zz - vz) ** 2 + (yy - 62) ** 2 <= 5)] = 160
    spleen = ellipsoid((dia - 15, 55, 38), (16, 14, 12)) & body & (lab == 0)
    ct[spleen] = 55; lab[spleen] = nid["spleen"]
    stom = ellipsoid((dia - 12, 88, 58), (12, 14, 14)) & body & (lab == 0)
    ct[stom] = 10 if stomach_full else -900; lab[stom] = nid["stomach"]
    heart = ellipsoid((dia + 18, 88, 70), (18, 20, 22)) & body & (lab == 0)
    ct[heart] = 45; lab[heart] = nid["heart"]
    aorta = ((yy - 54) ** 2 + (xx - 64) ** 2 <= 36) & (zz >= 20) & (zz < 140) & (lab == 0)
    ct[aorta] = 220; lab[aorta] = nid["aorta"]
    return np.roll(ct, shift, axis=(0, 1, 2)), np.roll(lab, shift, axis=(0, 1, 2))


def write(arr, path, origin):
    img = sitk.GetImageFromArray(arr); img.SetSpacing((1.0, 1.0, 1.0)); img.SetOrigin(origin)
    sitk.WriteImage(img, path)


SPEC = {"t0": ((0, 0, 0), 50, False, (-75.0, -70.0, 1000.0)),
        "t1": ((4, 2, -3), 56, True, (-75.0, -70.0, 900.0)),
        "t2": ((-3, -1, 2), 46, False, (-75.0, -70.0, 1100.0))}
PH = {k: phantom(v[0], v[1], v[2]) for k, v in SPEC.items()}
STAGED = {}


def fake_stage(bucket, wallet, study, series, dest):
    os.makedirs(dest, exist_ok=True)
    STAGED[dest] = study
    return dest


def fake_protocol(dcm_dir):
    return {"manufacturer": "SYNTH", "model": "PHANTOM", "kernel": "B30f", "kernel_family": "B30", "kernel_variant": "f",
            "slice_thickness_mm": 1.0, "kvp": 120.0, "contrast_agent": False, "n_slices": shape[0],
            "study_date": "20260101", "slice_step_mm": 1.0, "max_gap_mm": 1.0, "gaps": 0}


def fake_dcm_to_nifti(dcm_dir, out_nii):
    label = STAGED[dcm_dir]
    write(PH[label][0], out_nii, SPEC[label][3])
    return out_nii


def fake_preprocess(in_nii, out_nii, iso=1.0, hu_hi=3000.0):
    shutil.copy(in_nii, out_nii)
    return out_nii


def fake_segment(ct_nii, out_nii):
    label = os.path.basename(os.path.dirname(ct_nii))
    write(PH[label][1], out_nii, SPEC[label][3])
    return out_nii, names


R.stage_series, R.read_protocol, R.dcm_to_nifti = fake_stage, fake_protocol, fake_dcm_to_nifti
R.preprocess, R.segment = fake_preprocess, fake_segment

wd = tempfile.mkdtemp(prefix="smoke_main_")
tps = json.dumps([{"label": k, "study": k, "series": "s"} for k in ("t0", "t1", "t2")])
sys.argv = ["register.py", "--wallet", "0xSMOKE", "--job-id", "smoke-main", "--anatomy", "chest",
            "--timepoints", tps, "--workdir", wd, "--no-upload"]
t0 = time.time()
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        R.main()
except SystemExit as e:
    print(buf.getvalue()[-3000:])
    raise AssertionError(f"main() exited with {e.code}")
out = buf.getvalue()
line = [l for l in out.splitlines() if l.startswith("REGISTER_RESULT ")]
assert line, out[-2000:]
res = json.loads(line[-1][len("REGISTER_RESULT "):])
assert res["status"] == "done", res

job = os.path.join(wd, "smoke-main")
man = json.load(open(os.path.join(job, "out", "manifest.json")))
assert man["status"] == "done" and man["schema"] == "imaging-register/3", man.get("status")
assert man["gate"]["verdict"] in ("PASS", "PASS_WITH_WARNINGS", "FAIL"), man["gate"]
assert len(man["pairs"]) == 3, [p["pair"] for p in man["pairs"]]
for p in man["pairs"]:
    g = p["gate"]
    assert g["checks"] and "not_computed" in g, p["pair"]
    # a healthy phantom must produce every hard number: the fail-closed gate must not misfire
    assert not [h for h in g["hard_failures"] if "not computed" in h], (p["pair"], g["hard_failures"])
    d = p["metrics"]["deformable"]
    assert d["image_agreement_ncc"]["gated"] is False and d["image_agreement_ncc"]["body"] is not None, d["image_agreement_ncc"]
assert "consumers" in man and "consumers_error" not in man, man.get("consumers_error")
assert set(man["consumers"]) == {"organ_volume", "organ_surface", "picture", "lesion_link", "hu_diff"}
assert man["consumers"]["organ_volume"]["use_frame"] is False
assert man["software"]["engine_sha256"] and man["software"]["frame_contract_sha256"] and man["software"]["lung_volume_sha256"]
assert man["transitivity"] and man["transitivity"].get("dice_median") is not None
# A7: the lung volume step records an error instead of crashing, so a silent failure has to be asserted against
lv = man["lung_volume"]
assert lv["error"] is None, lv["error"]
assert set(lv["per_timepoint"]) == {t["label"] for t in man["timepoints"]}, list(lv["per_timepoint"])
assert set(lv["comparisons"]) == {p["pair"] for p in man["pairs"]}, list(lv["comparisons"])
for name, c in lv["comparisons"].items():
    assert c["computed"] is True and c["explained_by"] in ("no_meaningful_change", "breath_depth", "tissue_or_one_sided_change", "volume_change_mass_not_comparable"), (name, c)
for p in man["pairs"]:
    assert "lung_gate_downgraded" in p["gate"], p["pair"]
assert all("lung_volume_change" in row for row in man["consumers"]["organ_surface"]["pairs"])
status = json.load(open(os.path.join(job, "status.json")))
assert status["status"] == "done", status
for rel in ("frame/t0_ct.nii.gz", "frame/t0_labels.nii.gz", "frame/t1_ct.nii.gz", "frame/t1_labels.nii.gz",
            "frame/t2_ct.nii.gz", "native/t2/labels.nii.gz", "pairs/t1_to_t0/rigid.mat"):
    assert os.path.exists(os.path.join(job, "out", rel)), rel
json.dumps(man)
for p in man["pairs"]:
    g = p["gate"]
    d = p["metrics"]["deformable"]
    print(f"PAIR {p['pair']}: {g['verdict']} hard={g['hard_failures']} warn={g['warnings']} not_computed={g['not_computed']}")
    print(f"     lung volume: {lv['comparisons'][p['pair']]['explanation']} downgraded={g['lung_gate_downgraded']}")
    print(f"     spine {d['spine_assd_mm']}/{d['spine_hd95_mm']} lungs dice {d['lung_dice_min']} assd {d['lung_assd_max_mm']} "
          f"hd95 {d['lung_hd95_max_mm']} fold {d['jacobian_fold_fraction']} ncc {d['image_agreement_ncc']}")
print(f"SMOKE MAIN PASSED in {time.time() - t0:.0f}s: gate {man['gate']['verdict']}, "
      f"pairs {[(p['pair'], p['gate']['verdict']) for p in man['pairs']]}")
