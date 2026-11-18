"""The consumer contract. No images, no ANTs."""
import json
import os
import tempfile
import frame_contract as F


def manifest(mode="same", verdict="PASS_WITH_WARNINGS", lung_pass=True, skin_pass=False):
    def check(metric, ok, severity="soft"):
        return {"stage": "deformable", "metric": metric, "pass": ok, "severity": severity,
                "value": 1.0 if ok else 9.0, "threshold": 5.0}
    checks = [
        check("lung_dice_min", lung_pass, "hard"),
        check("lung_assd_max_mm", lung_pass, "hard"),
        check("lung_hd95_max_mm", lung_pass, "hard"),
        check("spine_assd_mm", True, "hard"),
        check("spine_hd95_mm", True, "hard"),
        check("abdominal_organ_hd95_max_mm_corresponding", False, "soft"),
        check("body_surface_hd95_mm", skin_pass, "soft"),
    ]
    return {
        "schema": "imaging-register/3", "job_id": "register-test", "reference": "mar3",
        "protocol_mode": mode, "voxel_comparison_assessable": mode == "same",
        "software": {"engine_sha256": "abc", "image_digest": "sha256:test"},
        "pairs": [{
            "pair": "jan9_to_mar3",
            "gate": {"verdict": verdict, "checks": checks, "warnings": ["skin"], "hard_failures": []},
        }],
    }


def test_organ_use_follows_the_gate_and_hu_does_not():
    ok = manifest()
    organ = F.advise(ok, "organ_surface")
    assert organ["use_frame"] is True
    assert organ["pairs"][0]["regions"]["lungs"] == "pass"
    assert organ["pairs"][0]["regions"]["liver_spleen"] == "warn"
    assert organ["pairs"][0]["regions"]["skin"] == "warn"
    hu = F.advise(ok, "hu_diff")
    assert hu["use_frame"] is False and hu["hu_comparable"] is True
    lesion = F.advise(ok, "lesion_link")
    assert lesion["use_frame"] is False and lesion["use_organ_labels"] is True


def test_organ_volume_never_comes_from_the_deformed_frame():
    ok = manifest()
    vol = F.advise(ok, "organ_volume")
    assert vol["use_frame"] is False and vol["use_organ_labels"] is False
    assert vol["volumes_from"] == "native_labels" and "reference volume" in vol["reason"]
    out = F.annotate_consumer_result("twin", {"job_id": "t"}, ok)
    assert out["organ_measurements_may_use_register_frame"] is False
    assert out["organ_volumes_source"] == "native_labels"


def test_a_region_with_no_number_is_not_a_pass():
    m = manifest()
    m["anatomy"] = "chest"
    for c in m["pairs"][0]["gate"]["checks"]:
        if c["metric"].startswith("lung_"):
            c["pass"] = None                       # not computed
    surf = F.advise(m, "organ_surface")
    assert surf["use_frame"] is False and "lungs" in surf["regions_without_a_number"]
    assert "no number" in surf["reason"]
    assert F.advise(m, "lesion_link")["use_organ_labels"] is False
    m["anatomy"] = "abdomen"                       # lungs are not what an abdomen job depends on
    assert F.advise(m, "organ_surface")["regions_without_a_number"] == []


def test_cross_protocol_withholds_hu_and_a_fail_closes_the_frame():
    cross = manifest(mode="cross")
    hu = F.advise(cross, "hu_diff")
    assert hu["hu_comparable"] is False and hu["use_frame"] is False
    assert "not comparable" in hu["reason"]
    failed = manifest(verdict="FAIL", lung_pass=False)
    failed["pairs"][0]["gate"]["hard_failures"] = ["lung"]
    organ = F.advise(failed, "organ_surface")
    assert organ["use_frame"] is False
    assert organ["pairs"][0]["regions"]["lungs"] == "fail"
    lesion = F.advise(failed, "lesion_link")
    assert lesion["use_organ_labels"] is False


def test_annotate_keeps_rigid_results_and_marks_cross_protocol():
    result = {"registration": {"model": "rigid 6-DOF"}, "comparison": {"bone_dice": 0.8},
              "interval_change_assessable": True, "foci": [{"id": 1}]}
    out = F.annotate_consumer_result("compare", result, manifest(mode="cross"))
    assert out["registration"]["model"] == "rigid 6-DOF"
    assert out["registration"]["deformable_frame_used_for_voxels"] is False
    assert out["interval_change_assessable"] is False
    assert out["foci"] == [{"id": 1}]
    assert out["comparison"]["hu_comparable"] is False


def test_attach_is_a_noop_without_the_env(monkeypatch=None):
    os.environ.pop("REGISTER_MANIFEST", None)
    result = {"job_id": "x"}
    assert F.attach_if_configured(result, "lesion") == result
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "manifest.json")
        with open(path, "w") as f:
            json.dump(manifest(), f)
        os.environ["REGISTER_MANIFEST"] = path
        try:
            attached = F.attach_if_configured({"registration": {}, "recist_response": {"reasons": []}}, "lesion")
        finally:
            os.environ.pop("REGISTER_MANIFEST", None)
    assert attached["register_frame"]["purpose"] == "lesion_link"
    assert attached["registration"]["deformable_frame_used_for_voxels"] is False


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for f in fns:
        f()
        print("ok", f.__name__)
    print(f"{len(fns)} passed")


def test_a_real_lung_change_makes_the_lung_surface_not_comparable():
    changed = {"computed": True, "real_change_supported": True, "explained_by": "tissue_or_one_sided_change",
               "delta_volume_ml": -400.0, "delta_volume_frac": -0.1, "delta_aerated_mass_frac": -0.2, "explanation": "x"}
    m = manifest()
    m["lung_volume"] = {"comparisons": {"jan9_to_mar3": changed}}
    a = F.advise(m, "organ_surface")
    assert a["lung_surface_comparable"] is False and a["lung_surface_not_comparable_pairs"] == ["jan9_to_mar3"]
    assert a["labels_excluded_regions"] == ["lungs"] and "position only" in a["reason"]
    assert a["pairs"][0]["lung_volume_change"]["delta_volume_ml"] == -400.0
    b = manifest()
    b["lung_volume"] = {"comparisons": {"jan9_to_mar3": {**changed, "real_change_supported": False, "explained_by": "breath_depth"}}}
    assert F.advise(b, "organ_surface")["lung_surface_comparable"] is True
    assert F.advise(manifest(), "organ_surface")["lung_surface_comparable"] is None     # an older manifest: not assessed
