#!/usr/bin/env python3
"""Lung volume change between two scans, and what explains it. numpy only.

The lung gate in register.py asks that the two lungs coincide after the warp. A real change of lung
volume (fluid pressing on the lung, a collapse) can break that although the registration is right,
and a breath held at a different depth changes the lung volume with no disease at all. The two are
told apart by the mass of the aerated lung. A breath changes the air in the lung, not the tissue, so
the mass of the aerated lung stays about the same while its volume changes. A change of that mass, or
a change that moves one lung and not the other, is not explained by the breath.

Method, per scan, inside the lung labels of the segmentation:
  volume          number of voxels times the voxel volume.
  aerated lung    voxels below `parenchyma_hu_max` HU. Vessels, the lung wall and consolidated lung
                  are left out, so the contrast phase does not move the number.
  mass            sum over the aerated voxels of density times voxel volume, with density
                  (HU + 1000) / 1000 g/mL (air 0, water 1).
Two scans are then compared by the fractional change of volume, of mass, of each lung and of each
lobe. Decision support, not a diagnosis: it names the pattern and where the change is largest.

Every threshold in LUNG_CHANGE_PARAMS is provisional and uncalibrated. They were fixed before any
scan was read with them and have to be calibrated on inhale and exhale pairs and on same-day repeat
scans before they are called validated.
"""
import numpy as np

LUNG_CHANGE_PARAMS = {
    "status": ("provisional, not calibrated; fixed 2026-11-04 before any scan was read with them; calibrate on "
               "inhale/exhale 4D-CT pairs (DIR-Lab) and same-day repeat scans (RIDER Lung CT)"),
    "parenchyma_hu_max": -500.0,       # HU below this is aerated lung
    "mass_change_flag_frac": 0.10,     # aerated-lung mass changed by more than 10 percent: not the breath
    "asymmetry_flag_frac": 0.15,       # left and right volume changes differ by more than 15 points: not the breath
    "volume_change_report_frac": 0.05, # a volume change under 5 percent is called no meaningful change
    "edge_lung_area_mm2": 300.0,       # lung in the outermost slice of the scan larger than this (3 cm2): the scanned range cuts the lungs
}

LUNG_LOBES = ("lung_upper_lobe_left", "lung_lower_lobe_left",
              "lung_upper_lobe_right", "lung_middle_lobe_right", "lung_lower_lobe_right")


def _region(ct, mask, dv, hu_max):
    vol = float(mask.sum()) * dv
    par = mask & (ct < hu_max)
    npar = int(par.sum())
    if npar == 0:
        return {"volume_ml": round(vol, 1), "aerated_volume_ml": 0.0, "aerated_mass_g": 0.0, "aerated_mean_hu": None}
    hu = np.clip(ct[par].astype(np.float64), -1000.0, hu_max)
    mass = float(((hu + 1000.0) / 1000.0).sum() * dv)
    return {"volume_ml": round(vol, 1), "aerated_volume_ml": round(npar * dv, 1),
            "aerated_mass_g": round(mass, 2), "aerated_mean_hu": round(float(hu.mean()), 1)}


def lung_report(ct, labels, spacing_mm, groups, params=None):
    """One scan. `ct` and `labels` are z,y,x arrays on one grid; `spacing_mm` is z,y,x;
    `groups` = {"lung_left": [ids], "lung_right": [ids], "lobes": {name: [ids]}}."""
    p = {**LUNG_CHANGE_PARAMS, **(params or {})}
    if ct.shape != labels.shape:
        raise ValueError(f"CT {ct.shape} and labels {labels.shape} are not on one grid")
    dv = float(np.prod(spacing_mm)) / 1000.0

    def mask_of(ids):
        return np.isin(labels, list(ids)) if ids else np.zeros(labels.shape, bool)

    left, right = mask_of(groups.get("lung_left")), mask_of(groups.get("lung_right"))
    hu_max = p["parenchyma_hu_max"]
    out = {"left": _region(ct, left, dv, hu_max), "right": _region(ct, right, dv, hu_max),
           "total": _region(ct, left | right, dv, hu_max), "lobes": {}}
    for name, ids in (groups.get("lobes") or {}).items():
        if ids:
            out["lobes"][name] = _region(ct, mask_of(ids), dv, hu_max)
    out["coverage"] = _coverage(left | right, spacing_mm, p["edge_lung_area_mm2"])
    return out


def _coverage(lung, spacing_mm, edge_area_mm2):
    """Does the scanned range cut the lungs? The outermost 2 slices at each end (axis 0) are checked for lung larger than
    edge_area_mm2. A scan that cuts the lungs at either end holds a different amount of lung from one that does not (or that cuts
    elsewhere), so its volume and mass say nothing about a breath or about tissue. extent_z_mm is the lung extent along the slice axis."""
    area = float(spacing_mm[1]) * float(spacing_mm[2])
    per = lung.sum(axis=(1, 2)).astype(np.float64) * area
    zs = np.nonzero(per > 0)[0]
    first, last = float(per[:2].max()), float(per[-2:].max())
    return {"cut_first_slice": bool(first > edge_area_mm2), "cut_last_slice": bool(last > edge_area_mm2),
            "first_slices_lung_area_mm2": round(first, 1), "last_slices_lung_area_mm2": round(last, 1),
            "extent_z_mm": None if zs.size == 0 else round(float((zs.max() - zs.min() + 1) * spacing_mm[0]), 1)}


def _ratio(ref, mov):
    """Fractional change of `mov` against `ref`; the caller has checked that `ref` is not zero."""
    if not ref:
        raise ZeroDivisionError("reference value is zero")
    return (mov / ref) - 1.0


def _frac(ref, mov):
    return None if not ref else _ratio(ref, mov)


def compare_lung_volume(ref, mov, params=None, mass_comparable=True, mass_withheld_reason=None, mass_caveat=None):
    """`mov` relative to `ref` (both from lung_report). computed False means a lung or its mass is missing in
    one scan: that is missing evidence, never a finding.

    The mass of the aerated lung depends on the reconstruction: on same-scan reconstructions of 6 patients (RIDER Lung CT) the
    standard kernel read 22 percent (median) above the lung kernel at 1.25 mm, and 5 mm slices read 15 percent above 1.25 mm.
    Between scans that differ in kernel family, contrast or slice thickness the mass is therefore not comparable:
    `mass_comparable` False leaves it out of the decision (it is still reported) and the verdict uses the volume and the
    left and right lungs only. `mass_caveat` is text carried into the explanation when the scans differ in a way that is allowed
    but is known to move the mass (the reconstruction variant)."""
    p = {**LUNG_CHANGE_PARAMS, **(params or {})}
    r, m = ref["total"], mov["total"]
    if not (r["volume_ml"] and m["volume_ml"] and r["aerated_mass_g"] and m["aerated_mass_g"]):
        return {"computed": False, "real_change_supported": False, "explained_by": "not_computed",
                "explanation": "A lung or its aerated mass is missing in one of the two scans, so no explanation is offered.",
                "params_status": p["status"]}
    cut = [(who, c) for who, c in (("reference", ref.get("coverage") or {}), ("moving", mov.get("coverage") or {}))
           if c.get("cut_first_slice") or c.get("cut_last_slice")]
    if cut:
        ext = {who: (rep.get("coverage") or {}).get("extent_z_mm") for who, rep in (("reference", ref), ("moving", mov))}
        return {"computed": False, "real_change_supported": False, "explained_by": "not_assessable_lungs_cut",
                "explanation": ("The scanned range cuts the lungs in the " + " and ".join(w for w, _ in cut) + " scan, so the volume and "
                                "the aerated mass of the lungs depend on how much lung each scan includes (lung extent along the slice axis: "
                                f"reference {ext['reference']} mm, moving {ext['moving']} mm). No breath or tissue explanation is offered; "
                                "the lung step needs scans that include both lungs completely."),
                "coverage": {"reference": ref.get("coverage"), "moving": mov.get("coverage")}, "params_status": p["status"]}
    dv, dm = _ratio(r["volume_ml"], m["volume_ml"]), _ratio(r["aerated_mass_g"], m["aerated_mass_g"])
    dl = _frac(ref["left"]["volume_ml"], mov["left"]["volume_ml"])
    dr = _frac(ref["right"]["volume_ml"], mov["right"]["volume_ml"])
    asym = abs(dl - dr) if (dl is not None and dr is not None) else None
    lobes = []
    for name, rl in (ref.get("lobes") or {}).items():
        ml = (mov.get("lobes") or {}).get(name)
        if ml is not None and rl["volume_ml"]:
            lobes.append({"lobe": name, "ref_ml": rl["volume_ml"], "moving_ml": ml["volume_ml"],
                          "delta_ml": round(ml["volume_ml"] - rl["volume_ml"], 1),
                          "delta_frac": round(_ratio(rl["volume_ml"], ml["volume_ml"]), 4),
                          "delta_mass_g": round(ml["aerated_mass_g"] - rl["aerated_mass_g"], 2),
                          "delta_mass_frac": None if not rl["aerated_mass_g"] else round(_ratio(rl["aerated_mass_g"], ml["aerated_mass_g"]), 4)})
    mass_flag = mass_comparable and abs(dm) > p["mass_change_flag_frac"]
    # where the change is largest: by aerated mass when the mass is what changed, by volume otherwise
    lobes.sort(key=(lambda x: -abs(x["delta_mass_g"])) if mass_flag else (lambda x: -abs(x["delta_ml"])))
    asym_flag = asym is not None and asym > p["asymmetry_flag_frac"]
    real = bool(mass_flag or asym_flag)
    if real:
        why = []
        if mass_flag:
            why.append(f"the mass of the aerated lung differs by {dm:+.1%}, more than the {p['mass_change_flag_frac']:.0%} "
                       "a different breath gives")
        if asym_flag:
            why.append(f"the left lung changed by {dl:+.1%} and the right by {dr:+.1%}, and a breath changes both alike")
        explained_by = "tissue_or_one_sided_change"
        text = "Not explained by the breath: " + "; ".join(why) + "."
    elif abs(dv) > p["volume_change_report_frac"] and not mass_comparable:
        explained_by = "volume_change_mass_not_comparable"
        text = (f"The lung volume differs by {dv:+.1%} ({m['volume_ml'] - r['volume_ml']:+.0f} mL) and the two lungs changed alike "
                f"({dl:+.1%} and {dr:+.1%}). The mass of the aerated lung is not compared: {mass_withheld_reason}.")
    elif abs(dv) > p["volume_change_report_frac"]:
        explained_by = "breath_depth"
        text = (f"The lung volume differs by {dv:+.1%} ({m['volume_ml'] - r['volume_ml']:+.0f} mL) while the mass of the "
                f"aerated lung differs by {dm:+.1%} and the two lungs changed alike ({dl:+.1%} and {dr:+.1%}): "
                "the pattern a breath held at a different depth gives.")
    else:
        explained_by = "no_meaningful_change"
        text = f"The lung volume differs by {dv:+.1%}, under the {p['volume_change_report_frac']:.0%} reporting line."
    if lobes and (real or abs(dv) > p["volume_change_report_frac"]):
        top = lobes[0]
        moved = abs(top["delta_mass_g"]) if mass_flag else abs(top["delta_ml"])
        if moved > 0:
            mf = top["delta_mass_frac"]
            text += (f" The largest change is in {top['lobe']}: volume {top['delta_ml']:+.0f} mL ({top['delta_frac']:+.1%}), "
                     f"aerated mass {top['delta_mass_g']:+.1f} g" + ("" if mf is None else f" ({mf:+.1%})") + ".")
    if not mass_comparable and explained_by != "volume_change_mass_not_comparable":
        text += f" The mass of the aerated lung is not compared: {mass_withheld_reason}."
    if mass_comparable and mass_caveat:
        text += f" Note: {mass_caveat}; the mass of two such scans of one patient differed by 5 to 8 percent with no known change."
    return {"computed": True, "real_change_supported": real, "explained_by": explained_by,
            "mass_comparable": bool(mass_comparable), "mass_withheld_reason": None if mass_comparable else mass_withheld_reason,
            "mass_caveat": mass_caveat,
            "delta_volume_ml": round(m["volume_ml"] - r["volume_ml"], 1), "delta_volume_frac": round(dv, 4),
            "delta_aerated_mass_frac": round(dm, 4),
            "delta_left_frac": None if dl is None else round(dl, 4), "delta_right_frac": None if dr is None else round(dr, 4),
            "left_right_asymmetry": None if asym is None else round(asym, 4),
            "reference": {"total": r, "left": ref["left"], "right": ref["right"]},
            "moving": {"total": m, "left": mov["left"], "right": mov["right"]},
            "lobes_by_change": lobes, "explanation": text, "params_status": p["status"],
            "decision_support_only": "Names a pattern and where the change is largest; not a diagnosis."}
