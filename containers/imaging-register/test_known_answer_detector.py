"""Plumbing tests for the detector known-answer test (known_answer_detector.py, fake_gcloud.py), with a perfect 'detector' made from the truth
so that only the harness, the shim and the executor's own storage calls are exercised. Run: python3 test_known_answer_detector.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.environ.get("FINDINGS_DIR", "/Users/danieluribe/Downloads/biofs-cli/containers/imaging-findings"))
import SimpleITK as sitk
import known_answer_detector as KD
import known_answer_findings as KF

WALLET, BUCKET = "0xKNOWNANSWERTEST", "genobank-health-imaging"
TEST_PAIRS = {
    "D0": {"base": "B0", "fu": "F0", "seed": 0, "nodules": []},
    "D1": {"base": "B0", "fu": "F1", "seed": 31, "nodules": [{"id": "n1", "base_d": None, "fu_d": 8, "hu": 40.0, "expect": "new"},
                                                               {"id": "n2", "base_d": None, "fu_d": 14, "hu": 40.0, "expect": "new"}]},
    "D2": {"base": "B2", "fu": "F2", "seed": 32, "nodules": [{"id": "a", "base_d": 12, "fu_d": 18, "hu": 40.0, "expect": "enlarged"},
                                                               {"id": "b", "base_d": 16, "fu_d": 16, "hu": 40.0, "expect": "stable"}]},
    "D3": {"base": "B3", "fu": "F3", "seed": 33, "nodules": [{"id": "a", "base_d": 20, "fu_d": 12, "hu": 40.0, "expect": "shrunk"},
                                                               {"id": "c", "base_d": 14, "fu_d": None, "hu": 40.0, "expect": "resolved"}]},
}
RULES = {"min_edge_from_lung_mm": 8.0, "min_spacing_mm": 25.0, "parenchyma_hu_max": -780.0}


def make_source(d):
    shape = (90, 150, 170)
    zz, yy, xx = np.indices(shape)
    ct = np.full(shape, 30, np.int16)
    lab = np.zeros(shape, np.int16)
    for k, cx in ((1, 45), (2, 125)):
        m = (((zz - 45) / 38.0) ** 2 + ((yy - 75) / 60.0) ** 2 + ((xx - cx) / 36.0) ** 2) <= 1
        ct[m] = -850
        lab[m] = k
    os.makedirs(os.path.join(d, "native", "jun17"), exist_ok=True)
    for arr, nm in ((ct, "ct.nii.gz"), (lab, "labels.nii.gz")):
        img = sitk.GetImageFromArray(arr)
        img.SetSpacing((1.0, 1.0, 1.0)); img.SetOrigin((-80.0, -75.0, 1000.0))
        sitk.WriteImage(img, os.path.join(d, "native", "jun17", nm))
    json.dump({"job_id": "synthetic-source", "label_names": {"1": "lung_left", "2": "lung_right"}}, open(os.path.join(d, "manifest.json"), "w"))


class DetectorPlumbing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="kad_")
        cls.src = os.path.join(cls.tmp, "src"); cls.root = os.path.join(cls.tmp, "fake_gcs")
        os.makedirs(cls.src); os.makedirs(cls.root)
        make_source(cls.src)
        cls.truth = KD.build(cls.src, cls.root, WALLET, BUCKET, pairs=TEST_PAIRS, rules=RULES, log=lambda *a: None)

    def test_series_are_written_where_the_executor_looks_and_round_trip(self):
        pj = json.load(open(os.path.join(self.root, "_truth", "pairs.json")))
        tp = pj["D2"]["timepoints"][0]
        d = os.path.join(self.root, BUCKET, WALLET, "imaging", tp["study"], tp["series"])
        r = sitk.ImageSeriesReader()
        r.SetFileNames(r.GetGDCMSeriesFileNames(d))
        img = r.Execute()
        self.assertEqual(img.GetSize(), (170, 150, 90))
        a = sitk.GetArrayFromImage(img)
        n = self.truth["pairs"]["D2"]["nodules"][0]
        ci = [int(round(v)) for v in n["center_index_zyx"]]
        self.assertGreater(float(a[tuple(ci)]), 0.0)                       # the nodule (40 HU) in air (-850 HU)
        self.assertLess(float(a[0, 0, 0]), 100.0)

    def test_shim_copies_globs_logs_and_refuses_unknown(self):
        shim = os.path.join(HERE, "fake_gcloud.py")
        env = {**os.environ, "FAKE_GCS": self.root}
        dest = os.path.join(self.tmp, "staged"); os.makedirs(dest)
        pj = json.load(open(os.path.join(self.root, "_truth", "pairs.json")))["D0"]["timepoints"][0]
        uri = f"gs://{BUCKET}/{WALLET}/imaging/{pj['study']}/{pj['series']}/*"
        r = subprocess.run([sys.executable, shim, "storage", "cp", "--recursive", uri, dest], env=env)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len([f for f in os.listdir(dest) if f.endswith(".dcm")]), 90)
        up = os.path.join(self.tmp, "x.txt"); open(up, "w").write("hi")
        r = subprocess.run([sys.executable, shim, "storage", "cp", up, f"gs://{BUCKET}/{WALLET}/out/job/x.txt"], env=env)
        self.assertEqual(r.returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.root, BUCKET, WALLET, "out", "job", "x.txt")))
        self.assertNotEqual(subprocess.run([sys.executable, shim, "storage", "ls", uri], env=env, stderr=subprocess.DEVNULL).returncode, 0)
        self.assertNotEqual(subprocess.run([sys.executable, shim, "storage", "cp", "--foo", up, dest], env=env, stderr=subprocess.DEVNULL).returncode, 0)
        self.assertNotEqual(subprocess.run([sys.executable, shim, "storage", "cp", "gs://nobucket/none/*", dest], env=env, stderr=subprocess.DEVNULL).returncode, 0)
        self.assertIn("storage cp", open(os.path.join(self.root, "_gcloud_calls.log")).read())

    def test_evaluate_scores_a_perfect_detector_and_catches_a_missed_nodule(self):
        import findings_runner as FR
        bindir = os.path.join(self.tmp, "bin"); os.makedirs(bindir)
        os.symlink(os.path.join(HERE, "fake_gcloud.py"), os.path.join(bindir, "gcloud"))
        os.chmod(os.path.join(HERE, "fake_gcloud.py"), 0o755)
        os.environ["PATH"] = bindir + os.pathsep + os.environ["PATH"]; os.environ["FAKE_GCS"] = self.root
        FR.LL_CKPT = "/nonexistent"
        FR.TUMOR_USED = [23]
        pj = json.load(open(os.path.join(self.root, "_truth", "pairs.json")))
        for pid, tp in self.truth["pairs"].items():
            wd = tempfile.mkdtemp(dir=self.tmp)
            cts, segs = [], []
            for k, (lab, scan, dkey) in enumerate((("base", tp["base_scan"], "base_d"), ("fu", tp["fu_scan"], "fu_d"))):
                t = pj[pid]["timepoints"][k]
                d = os.path.join(wd, lab); os.makedirs(d)
                subprocess.run([sys.executable, os.path.join(HERE, "fake_gcloud.py"), "storage", "cp", "--recursive",
                                f"gs://{BUCKET}/{WALLET}/imaging/{t['study']}/{t['series']}/*", d], env={**os.environ}, check=True)
                r = sitk.ImageSeriesReader(); r.SetFileNames(r.GetGDCMSeriesFileNames(d)); img = r.Execute()
                ctp = os.path.join(wd, f"{lab}.nii.gz"); sitk.WriteImage(img, ctp); cts.append(ctp)
                seg = np.zeros(sitk.GetArrayFromImage(img).shape, np.uint8)
                for n in tp["nodules"]:
                    if n[dkey] and n["hu"] > 0:                              # the perfect detector sees solid nodules only
                        seg[KD.sphere_mask_on(img, n["center_phys_xyz_mm"], n[dkey])] = 23
                s = sitk.GetImageFromArray(seg); s.CopyInformation(img); segs.append(s)
            prefix = f"gs://{BUCKET}/{WALLET}/imaging-findings/{pj[pid]['job_id']}"
            findings, tracker, nb, nf = FR.analyze_interval("base", "fu", segs[0], segs[1], cts[0], cts[1], segs[0].GetSpacing(), wd, [0, 90], prefix=prefix)
            rec = FR.recist_for_interval(findings, True, True, "naive")
            for f in findings:
                f.pop("mask", None)
            out = os.path.join(self.root, BUCKET, WALLET, "imaging-findings", pj[pid]["job_id"]); os.makedirs(out, exist_ok=True)
            json.dump({"detected_classes": ["lung_tumor"], "dropped_classes": [], "elapsed_sec": 1.0,
                       "intervals": [{"tracker": tracker, "n_baseline_lesions": nb, "n_followup_lesions": nf, "findings": findings, "recist_response": rec}]},
                      open(os.path.join(out, "findings.json"), "w"))
        rep = KD.evaluate(self.root, WALLET, BUCKET)
        for pid in ("D0", "D1", "D2", "D3"):
            self.assertTrue(rep["pairs"][pid]["ran"], pid)
        self.assertEqual(rep["pairs"]["D0"]["n_new_or_enlarged"], 0)
        self.assertTrue(rep["pairs"]["D0"]["dt2_ok"])
        for pid in ("D1", "D2", "D3"):
            p = rep["pairs"][pid]
            self.assertEqual(p["dt4_failed"], [], (pid, [(r["id"], r["finding"]) for r in p["nodules"]]))
            self.assertEqual(p["dt3_failed"], [], pid)
            self.assertTrue(p["dt5_ok"], pid)
            self.assertEqual(p["missed"], [], pid)
        self.assertEqual(rep["pairs"]["D2"]["reported_category"], "PD")
        self.assertEqual(rep["pairs"]["D3"]["reported_category"], "PR")
        # the shim wrote the executor's mask uploads, and logged only storage cp calls
        log = open(os.path.join(self.root, "_gcloud_calls.log")).read().splitlines()
        self.assertTrue(all(" storage cp" in line for line in log))


if __name__ == "__main__":
    unittest.main(verbosity=2)
