"""Run the production register job on a known-answer pair, then read it out (test-only; runs inside the image).

  run     python known_answer_run.py run --build-dir B --workdir W --job-id J --protocol-from SRC_OUT/manifest.json --protocol-label jun17
          Runs the real main() on the pair in B (old_* and new_* files from `known_answer.py build`). Only the four steps
          that need DICOM, a GPU or the network are replaced by file copies (stage, DICOM to NIfTI, resample, segment),
          exactly as smoke_main.py does; the registration, gate, lung-volume step, manifest and consumers are production.
  dryrun  python known_answer_run.py dryrun --workdir W
          The whole chain (build, run, evaluate) on the small synthetic torso, about 10 minutes. It proves the plumbing
          before the long run; its numbers mean nothing about registration quality.

Docker (the image has /app on the path):
  docker run --rm --gpus all --entrypoint python -v $PWD:/t:ro -v /mnt/scratch:/mnt/scratch imaging-register:<tag> /t/known_answer_run.py ...
"""
import argparse
import copy
import json
import os
import shutil
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, "/app")

SYNTH_PROTOCOL = {"manufacturer": "SYNTH", "model": "KNOWN_ANSWER", "kernel": "B30f", "kernel_family": "B30", "kernel_variant": "f",
                  "slice_thickness_mm": 1.0, "kvp": 120.0, "contrast_agent": False, "n_slices": 150,
                  "study_date": "20260101", "slice_step_mm": 1.0, "max_gap_mm": 1.0, "gaps": 0}


def run_main(build_dir, workdir, job_id, protocol, anatomy="chest"):
    import register as R
    from totalsegmentator.map_to_binary import class_map
    names = {int(k): v for k, v in class_map["total"].items()}
    files = {"ref": (os.path.join(build_dir, "old_ct.nii.gz"), os.path.join(build_dir, "old_labels.nii.gz")),
             "mov": (os.path.join(build_dir, "new_ct.nii.gz"), os.path.join(build_dir, "new_labels.nii.gz"))}
    staged = {}

    def fake_stage(bucket, wallet, study, series, dest):
        os.makedirs(dest, exist_ok=True)
        staged[dest] = study
        return dest

    def fake_protocol(dcm_dir):
        return dict(protocol)

    def fake_dcm_to_nifti(dcm_dir, out_nii):
        shutil.copy(files[staged[dcm_dir]][0], out_nii)
        return out_nii

    def fake_preprocess(in_nii, out_nii, iso=1.0, hu_hi=3000.0):
        shutil.copy(in_nii, out_nii)
        return out_nii

    def fake_segment(ct_nii, out_nii):
        shutil.copy(files[os.path.basename(os.path.dirname(ct_nii))][1], out_nii)
        return out_nii, names

    R.stage_series, R.read_protocol, R.dcm_to_nifti = fake_stage, fake_protocol, fake_dcm_to_nifti
    R.preprocess, R.segment = fake_preprocess, fake_segment
    tps = json.dumps([{"label": "ref", "study": "ref", "series": "s"}, {"label": "mov", "study": "mov", "series": "s"}])
    sys.argv = ["register.py", "--wallet", "0xKNOWNANSWER", "--job-id", job_id, "--anatomy", anatomy, "--timepoints", tps,
                "--reference", "ref", "--workdir", workdir, "--no-upload"]
    t0 = time.time()
    try:
        R.main()
    except SystemExit as e:
        if e.code not in (0, None):
            raise AssertionError(f"main() exited with {e.code}")
    out = os.path.join(workdir, job_id, "out")
    man = json.load(open(os.path.join(out, "manifest.json")))
    assert man["status"] == "done", man.get("status")
    print(f"MAIN DONE in {time.time() - t0:.0f}s: gate {man['gate']['verdict']}")
    return out


def phantom_source(path):
    """A small torso as the 'source job' of the dry run: native/jun17/{ct,labels} and a manifest with label names."""
    import SimpleITK as sitk
    from totalsegmentator.map_to_binary import class_map
    names = {int(k): v for k, v in class_map["total"].items()}
    nid = {v: k for k, v in names.items()}
    shape = (150, 140, 150)
    zz, yy, xx = np.indices(shape)

    def ell(c, r):
        return ((zz - c[0]) / r[0]) ** 2 + ((yy - c[1]) / r[1]) ** 2 + ((xx - c[2]) / r[2]) ** 2 <= 1

    ct = np.full(shape, -1024, np.int16)
    lab = np.zeros(shape, np.int16)
    dia = 50
    body = ((yy - 70) / 55.0) ** 2 + ((xx - 75) / 65.0) ** 2 <= 1
    ct[body] = 30
    for k, z0 in enumerate(range(15, 135, 15)):
        v = ((yy - 40) ** 2 + (xx - 75) ** 2 <= 70) & (zz >= z0) & (zz < z0 + 12)
        ct[v] = 650; lab[v] = nid[f"vertebrae_T{12 - k}"]
    st = ((yy - 112) ** 2 + (xx - 75) ** 2 <= 30) & (zz >= 70) & (zz < 125)
    ct[st] = 500; lab[st] = nid["sternum"]
    for side, cx in (("left", 42), ("right", 108)):
        lung = ell((dia + 42, 75, cx), (42, 34, 28)) & (zz >= dia) & body & (lab == 0)
        ct[lung] = -850; lab[lung] = nid[f"lung_upper_lobe_{side}"]
        for vz in range(dia + 10, dia + 75, 12):
            ct[((zz - vz) ** 2 + (yy - 75) ** 2 <= 4) & lung] = 80
    liver = ell((dia - 24, 70, 100), (30, 40, 36)) & body & (lab == 0)
    ct[liver] = 60; lab[liver] = nid["liver"]
    for vz in range(dia - 48, dia - 5, 9):
        ct[liver & ((zz - vz) ** 2 + (yy - 62) ** 2 <= 5)] = 160
    spleen = ell((dia - 15, 55, 38), (16, 14, 12)) & body & (lab == 0)
    ct[spleen] = 55; lab[spleen] = nid["spleen"]
    heart = ell((dia + 18, 88, 70), (18, 20, 22)) & body & (lab == 0)
    ct[heart] = 45; lab[heart] = nid["heart"]
    aorta = ((yy - 54) ** 2 + (xx - 64) ** 2 <= 36) & (zz >= 20) & (zz < 140) & (lab == 0)
    ct[aorta] = 220; lab[aorta] = nid["aorta"]
    base = os.path.join(path, "native", "jun17")
    os.makedirs(base, exist_ok=True)
    for arr, name in ((ct, "ct.nii.gz"), (lab, "labels.nii.gz")):
        img = sitk.GetImageFromArray(arr); img.SetSpacing((1.0, 1.0, 1.0)); img.SetOrigin((-75.0, -70.0, 1000.0))
        sitk.WriteImage(img, os.path.join(base, name))
    json.dump({"label_names": {str(k): v for k, v in names.items()}}, open(os.path.join(path, "manifest.json"), "w"))
    return path


def dryrun_spec():
    import known_answer as KA
    s = copy.deepcopy(KA.DEFAULT_SPEC)
    s["deformation"].update(mesh_cells=[3, 3, 3], p95_mm=3.0, max_mm_limit=12.0, min_jacobian=0.5,
                            rigid_translation_mm=[3.0, -2.0, 4.0], rigid_rotation_deg=[1.0, 0.0, 1.0])
    s["nodules"] = [{"diameter_mm": 6.0, "hu": 30.0}, {"diameter_mm": 8.0, "hu": 30.0}]
    s["nodule_rules"].update(min_edge_from_lung_mm=8.0, min_spacing_mm=20.0)
    s["consolidation"].update(lobe="lung_upper_lobe_right", fraction_from_bottom=0.5, roi_margin_mm=8.0)
    s["points"].update(n_per_lung_zone=6, n_body=8, erode_vox=3)
    return s


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("--build-dir", required=True); r.add_argument("--workdir", required=True)
    r.add_argument("--job-id", required=True); r.add_argument("--protocol-from", required=True); r.add_argument("--protocol-label", required=True)
    d = sub.add_parser("dryrun"); d.add_argument("--workdir", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "run":
        man = json.load(open(args.protocol_from))
        proto = next(t["protocol"] for t in man["timepoints"] if t["label"] == args.protocol_label)
        out = run_main(args.build_dir, args.workdir, args.job_id, proto)
        print(f"JOB_OUT {out}")
        return 0
    import known_answer as KA
    src = phantom_source(os.path.join(args.workdir, "dry_source"))
    spec = dryrun_spec()
    bdir = os.path.join(args.workdir, "dry_build")
    KA.build(src, "jun17", spec, bdir)
    out = run_main(bdir, os.path.join(args.workdir, "dry_run"), "known-answer-dry", SYNTH_PROTOCOL)
    rep = KA.evaluate(out, bdir, spec, os.path.join(args.workdir, "dry_report.json"))
    print(json.dumps({"gate": rep["gate_verdict"], "registration_error": {k: rep["registration_error"][k] for k in
                                                                         ("n_points", "blob_lost_fraction", "lung_outside_roi", "body")},
                      "nodules": [{k: o[k] for k in ("id", "diameter_mm", "deformable_retained_volume_ratio", "position_error_mm")} |
                                  {"detected": o["deformable_frame"]["detected"]} for o in rep["nodules"]["objects"]],
                      "lung_volume": {k: rep["lung_volume"][k] for k in ("measured_mass_frac", "truth_mass_frac", "flagged_with_lobe_fill",
                                                                         "flagged_deformation_only", "explained_by")},
                      "rules": {k: v["verdict"] for k, v in rep["pass_rules_applied"].items()}}, indent=1))
    print("KNOWN ANSWER DRYRUN COMPLETE (numbers are plumbing checks only)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
