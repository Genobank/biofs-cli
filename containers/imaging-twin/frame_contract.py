#!/usr/bin/env python3
"""Consumer contract for an imaging-register manifest (schema imaging-register/2 or /3).

`biofs imaging register` writes one reference frame and a gate. A later verb asks
`advise` whether it may use that frame. The answer is per purpose:

  organ_volume
      Never the deformable frame. A deformation that fits one scan to the other absorbs the
      change of organ size into its Jacobian, so the volume of a warped label map is the
      reference volume by construction. Volumes come from the native-space labels of each
      timepoint (or from the integral of the Jacobian over the organ).
  organ_surface, picture
      Use the deformable frame when the pair did not FAIL and the regions the anatomy depends
      on have a number. Warnings travel with the use.
  lesion_link
      Do not resample lesion voxels through the deformable frame. A spot must stay on
      the rigid grid. Organ labels from the frame may attribute a lesion only where
      that organ did not hard-fail.
  hu_diff
      Do not subtract HU on the deformed frame. Same-protocol HU change stays on the
      rigid grid. Cross-protocol intensities are not a measurement on either grid.

Nothing here reads DICOM. It reads the manifest the register job already wrote.
"""
import json
import os
import sys

PURPOSES = ("organ_volume", "organ_surface", "picture", "lesion_link", "hu_diff")

# Gated deformable metrics that speak for one region. A hard fail closes that region.
REGION_METRICS = {
    "lungs": ("lung_dice_min", "lung_assd_max_mm", "lung_hd95_max_mm"),
    "spine": ("spine_assd_mm", "spine_hd95_mm"),
    "liver_spleen": ("abdominal_organ_assd_max_mm_corresponding",
                     "abdominal_organ_hd95_max_mm_corresponding"),
    "skin": ("body_surface_assd_mm", "body_surface_hd95_mm"),
}

DEFORMABLE_PURPOSES = ("organ_surface", "picture")

# The regions whose number the job needs, by the anatomy the job was run for. A region with no
# number ("unknown") is missing evidence, not a pass.
REQUIRED_REGIONS = {"chest": ("lungs", "spine"), "abdomen": ("liver_spleen", "spine")}


def load_manifest(path):
    with open(path) as f:
        return json.load(f)


def _pairs(manifest, pair):
    rows = list(manifest.get("pairs") or [])
    if pair:
        rows = [p for p in rows if p.get("pair") == pair]
    return rows


def _checks(pair):
    return {(c.get("stage"), c.get("metric")): c
            for c in ((pair.get("gate") or {}).get("checks") or [])}


def region_state(pair, metric_names):
    """pass, warn, fail, or unknown for one region of one pair."""
    found = []
    for name in metric_names:
        check = _checks(pair).get(("deformable", name))
        if not check or check.get("pass") is None:
            found.append("unknown")
        elif check.get("pass") is False and check.get("severity") == "hard":
            found.append("fail")
        elif check.get("pass") is False:
            found.append("warn")
        else:
            found.append("pass")
    if "fail" in found:
        return "fail"
    if "warn" in found:
        return "warn"
    if "pass" in found and "unknown" in found:
        return "warn"
    if "pass" in found:
        return "pass"
    return "unknown"


def _identity(manifest):
    software = manifest.get("software") or {}
    return {
        "schema": manifest.get("schema"),
        "job_id": manifest.get("job_id"),
        "engine_sha256": software.get("engine_sha256"),
        "frame_contract_sha256": software.get("frame_contract_sha256"),
        "image_digest": software.get("image_digest"),
        "image_tag": software.get("image_tag"),
    }


def _hu_comparable(manifest):
    mode = manifest.get("protocol_mode") or "unknown"
    flagged = manifest.get("voxel_comparison_assessable")
    comparable = mode == "same" and flagged is not False
    return mode, comparable


def advise(manifest, purpose, pair=None):
    """One purpose, one answer. `pair` limits the rows; default is every pair."""
    if purpose not in PURPOSES:
        raise ValueError(f"purpose must be one of {PURPOSES}")
    mode, hu_ok = _hu_comparable(manifest)
    rows = _pairs(manifest, pair)
    per_pair = []
    for row in rows:
        regions = {name: region_state(row, metrics) for name, metrics in REGION_METRICS.items()}
        verdict = (row.get("gate") or {}).get("verdict")
        per_pair.append({
            "pair": row.get("pair"),
            "verdict": verdict,
            "regions": regions,
            "warnings": list((row.get("gate") or {}).get("warnings") or []),
            "hard_failures": list((row.get("gate") or {}).get("hard_failures") or []),
        })
    any_fail = any(p.get("verdict") == "FAIL" for p in per_pair)
    any_rows = bool(per_pair)
    closed = [name for name, metrics in REGION_METRICS.items()
              if any(p["regions"].get(name) == "fail" for p in per_pair)]
    required = REQUIRED_REGIONS.get(manifest.get("anatomy"), ("spine",))
    unknown = [name for name in required
               if any(p["regions"].get(name) == "unknown" for p in per_pair)]
    base = {
        "purpose": purpose,
        "protocol_mode": mode,
        "hu_comparable": hu_ok,
        "pairs": per_pair,
        "regions_hard_fail": closed,
        "regions_without_a_number": unknown,
        "anatomy": manifest.get("anatomy"),
        "identity": _identity(manifest),
        "reference": manifest.get("reference"),
        "frame_files": {
            "manifest": "manifest.json",
            "reference_ct": f"frame/{manifest.get('reference')}_ct.nii.gz" if manifest.get("reference") else None,
            "moving_ct": "frame/<moving>_ct.nii.gz",
            "moving_labels": "frame/<moving>_labels.nii.gz",
        },
    }
    if not any_rows:
        base.update(use_frame=False, use_organ_labels=False,
                    reason="The manifest has no pair, so there is no frame to trust.")
        return base
    if purpose == "organ_volume":
        base.update(use_frame=False, use_organ_labels=False, volumes_from="native_labels",
                    reason=("Organ volume is read from the native-space labels of each timepoint, not from a "
                            "deformed label map: the deformation absorbs the change of size into its Jacobian, so "
                            "a warped label has the reference volume by construction. The frame is for surface "
                            "correspondence and pictures."))
        return base
    if purpose in DEFORMABLE_PURPOSES:
        use = (not any_fail) and not unknown
        if use:
            reason = ("The deformable frame is usable for this purpose. "
                      "A warning on a region stays attached to that region.")
        elif any_fail:
            reason = "A pair FAILed the gate. Do not use this frame for organ surface or picture measurements."
        else:
            reason = ("A region this anatomy depends on has no number (" + ", ".join(unknown) +
                      "). Missing evidence is not a pass: do not use this frame.")
        base.update(use_frame=use, use_organ_labels=use and not closed,
                    reason=reason)
        return base
    if purpose == "lesion_link":
        labels_ok = (not any_fail and not unknown
                     and not any(r in closed for r in ("lungs", "liver_spleen", "spine")))
        base.update(
            use_frame=False,
            use_organ_labels=labels_ok,
            reason=("Lesion voxels stay on the rigid grid so a spot is not resampled by SyN. "
                    "Organ labels from this frame may name the organ of a lesion only where "
                    "that organ did not hard-fail."),
        )
        return base
    # hu_diff
    if not hu_ok:
        reason = ("Intensities are not comparable (protocol_mode is not same). "
                  "Do not measure HU change on the rigid difference or on the deformed frame.")
    else:
        reason = ("Same protocol. HU change stays on the rigid grid so a new spot is not "
                  "resampled by SyN. This frame's gate is context beside that rigid result.")
    base.update(use_frame=False, use_organ_labels=False, reason=reason)
    return base


def advise_all(manifest):
    return {purpose: advise(manifest, purpose) for purpose in PURPOSES}


def annotate_consumer_result(kind, result, manifest):
    """Attach the contract to a lesion, compare, trajectory, or twin result.

    The rigid registration those verbs already computed is left in place.
    Cross-protocol HU results are marked not assessable. Foci are not deleted.
    """
    if isinstance(manifest, str):
        manifest = load_manifest(manifest)
    purpose = {"lesion": "lesion_link", "compare": "hu_diff",
               "trajectory": "hu_diff", "twin": "organ_volume"}[kind]
    advice = advise(manifest, purpose)
    out = dict(result)
    out["register_frame"] = advice
    if kind in ("compare", "trajectory"):
        reg = dict(out.get("registration") or {})
        reg["deformable_frame_used_for_voxels"] = False
        reg["register_frame_job"] = manifest.get("job_id")
        out["registration"] = reg
        if not advice["hu_comparable"]:
            out["voxel_comparison_assessable"] = False
            out["interval_change_assessable"] = False
            comp = dict(out.get("comparison") or {})
            comp["hu_comparable"] = False
            comp["hu_withheld_reason"] = advice["reason"]
            out["comparison"] = comp
    elif kind == "lesion":
        reg = dict(out.get("registration") or {})
        reg["deformable_frame_used_for_voxels"] = False
        reg["register_frame_job"] = manifest.get("job_id")
        reg["organ_labels_from_frame"] = advice["use_organ_labels"]
        out["registration"] = reg
        if any(p.get("verdict") == "FAIL" for p in advice["pairs"]):
            rec = dict(out.get("recist_response") or {})
            rec["human_review_forced"] = True
            rec["response_assessable"] = False
            reasons = list(rec.get("reasons") or [])
            reasons.append("register frame hard-failed; lesion voxels stayed on the rigid grid and the response stays unassessed")
            rec["reasons"] = reasons
            out["recist_response"] = rec
    elif kind == "twin":
        out["organ_measurements_may_use_register_frame"] = False
        out["organ_volumes_source"] = advice.get("volumes_from")
        out["registration_source"] = (
            "This twin job keeps its own alignment. Organ volumes are the native-space volumes of each "
            "timepoint; a deformed label map would carry the reference volume. The imaging-register "
            "frame is for surface correspondence and pictures."
        )
    return out


def attach_if_configured(result, kind):
    """Honor REGISTER_MANIFEST when a runner was started with that env var. No-op otherwise."""
    path = os.environ.get("REGISTER_MANIFEST")
    if not path:
        return result
    if not os.path.isfile(path):
        flagged = dict(result)
        flagged["register_frame_error"] = f"REGISTER_MANIFEST is not a file: {path}"
        return flagged
    return annotate_consumer_result(kind, result, path)


def main(argv):
    if len(argv) < 3 or argv[1] not in ("advise", "annotate"):
        print("usage: frame_contract.py advise <manifest.json> [purpose] [pair]", file=sys.stderr)
        print("       frame_contract.py annotate <kind> <manifest.json> <result.json>", file=sys.stderr)
        return 2
    if argv[1] == "advise":
        manifest = load_manifest(argv[2])
        if len(argv) == 3:
            print(json.dumps(advise_all(manifest), indent=2))
        else:
            purpose = argv[3]
            pair = argv[4] if len(argv) > 4 else None
            print(json.dumps(advise(manifest, purpose, pair), indent=2))
        return 0
    kind, manifest_path, result_path = argv[2], argv[3], argv[4]
    result = load_manifest(result_path)
    print(json.dumps(annotate_consumer_result(kind, result, manifest_path), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
