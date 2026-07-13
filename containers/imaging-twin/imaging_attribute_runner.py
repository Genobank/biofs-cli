#!/usr/bin/env python3
"""
imaging_attribute_runner.py — organ attribution for an Image Time Machine comparison.

The MCP "organ-attribution cross-join": label every focal change in a compare job's
change_analysis.json with the ANATOMIC ORGAN it sits in, so the radiology read can say
"new 14mm focus in the right hepatic lobe" instead of an image-space position.

Frame-correct by construction: the comparator already wrote A.nii.gz (its REFERENCE CT)
in the EXACT grid the foci centroids live in (centroid_mm = voxel_index * A.spacing). So
we segment A.nii.gz directly with TotalSegmentator and look up the organ at each focus's
voxel — no cross-study registration, and it works for any compare with or without a twin.

GPU job (segmentation), dispatched by biofs-node's submit_imaging_attribute to this
container (reuses imaging-twin:latest, which has TotalSegmentator). Decision-support,
not a diagnosis. De-identified: only wallet + organ labels + the existing foci appear.

Env: WALLET, COMPARE_JOB, JOB_ID, IMAGING_BUCKET (default genobank-health-imaging).
"""
import os, sys, json, time, tempfile, subprocess, traceback
import numpy as np
import SimpleITK as sitk

def log(*a): print(f"[{time.strftime('%H:%M:%S')}] [attribute]", *a, flush=True)

BUCKET = os.getenv("IMAGING_BUCKET", "genobank-health-imaging")


def gcs_cp(src, dst):
    r = subprocess.run(["gcloud", "storage", "cp", src, dst], capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        raise RuntimeError(f"gcs cp {src}: {(r.stderr or '')[:300]}")


def main():
    wallet = os.environ["WALLET"]; cjob = os.environ["COMPARE_JOB"]
    jid = os.getenv("JOB_ID", "attr-" + str(int(time.time())))
    prefix = f"gs://{BUCKET}/{wallet}/imaging-compare/{cjob}"
    wd = tempfile.mkdtemp(prefix="attr_")
    try:
        log(f"=== organ attribution {jid} for compare {cjob} ===")
        gcs_cp(f"{prefix}/A.nii.gz", os.path.join(wd, "A.nii.gz"))
        gcs_cp(f"{prefix}/change_analysis.json", os.path.join(wd, "ca.json"))
        ca = json.load(open(os.path.join(wd, "ca.json")))
        foci = ca.get("foci") or []
        log(f"loaded change_analysis: {len(foci)} foci")

        # 1. segment the reference CT (multilabel, fast 3mm — output is in A's grid)
        from totalsegmentator.python_api import totalsegmentator
        from totalsegmentator.map_to_binary import class_map
        seg_out = os.path.join(wd, "seg.nii.gz")
        log("TotalSegmentator (fast, multilabel) on the compare reference CT ...")
        totalsegmentator(os.path.join(wd, "A.nii.gz"), seg_out, fast=True, ml=True)
        A = sitk.ReadImage(os.path.join(wd, "A.nii.gz")); spA = A.GetSpacing()  # (x,y,z) mm
        seg = sitk.ReadImage(seg_out)
        if seg.GetSize() != A.GetSize():                     # safety: resample seg onto A's grid
            seg = sitk.Resample(seg, A, sitk.Transform(), sitk.sitkNearestNeighbor, 0, seg.GetPixelID())
        segarr = sitk.GetArrayFromImage(seg).astype(np.int32)  # [z,y,x]
        cmap = dict(class_map["total"])                       # {label_int: organ_name}
        log(f"segmented: grid={segarr.shape}, {int((segarr>0).sum())} labeled voxels, {len(cmap)} classes")

        # 2. attribute each focus: centroid_mm -> voxel index in A's grid; majority organ
        #    in a small neighborhood (radius ~ half the focus short axis, capped) so a
        #    centroid landing in a vessel/edge still resolves to the dominant organ.
        nz, ny, nx = segarr.shape
        counts = {}
        for f in foci:
            cx, cy, cz = f.get("centroid_mm", [0, 0, 0])
            ix = int(round(cx / spA[0])); iy = int(round(cy / spA[1])); iz = int(round(cz / spA[2]))
            shrt = float(f.get("short_axis_mm") or 0)
            rmm = min(max(shrt / 2.0, 3.0), 10.0)             # 3-10 mm neighborhood
            rz = max(1, int(round(rmm / spA[2]))); ry = max(1, int(round(rmm / spA[1]))); rx = max(1, int(round(rmm / spA[0])))
            z0, z1 = max(0, iz - rz), min(nz, iz + rz + 1)
            y0, y1 = max(0, iy - ry), min(ny, iy + ry + 1)
            x0, x1 = max(0, ix - rx), min(nx, ix + rx + 1)
            organ = None; conf = 0.0
            if z1 > z0 and y1 > y0 and x1 > x0:
                sub = segarr[z0:z1, y0:y1, x0:x1].ravel()
                sub = sub[sub > 0]
                if sub.size:
                    bc = np.bincount(sub)
                    lab = int(bc.argmax())
                    organ = cmap.get(lab)
                    conf = round(float(bc[lab]) / float((z1 - z0) * (y1 - y0) * (x1 - x0)), 2)
            f["organ"] = organ or "interstitial/unsegmented"
            f["organ_confidence"] = conf
            counts[f["organ"]] = counts.get(f["organ"], 0) + 1

        # 3. organ_attribution summary + enriched change_analysis -> GCS
        attribution = {
            "schema": "imaging-organ-attribution/1",
            "compare_job": cjob, "wallet": wallet, "job_id": jid,
            "anatomy": ca.get("anatomy"),
            "method": ("TotalSegmentator (fast) on the comparator's own reference CT (A.nii.gz); "
                       "each focus labeled by the majority organ in a short-axis neighborhood of "
                       "its centroid. Frame-exact: A.nii.gz IS the foci grid, no registration."),
            "n_foci": len(foci),
            "organ_focus_counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
            "foci": [{"id": f.get("id"), "polarity": f.get("polarity"), "organ": f.get("organ"),
                      "organ_confidence": f.get("organ_confidence"), "long_axis_mm": f.get("long_axis_mm"),
                      "volume_ml": f.get("volume_ml"), "mean_delta_hu": f.get("mean_delta_hu")} for f in foci],
            "disclaimer": "Decision-support only, not a diagnosis. Organ labels are automated "
                          "(fast segmentation); confirm against the source images.",
        }
        ca["organ_attribution"] = {"organ_focus_counts": attribution["organ_focus_counts"],
                                   "method": attribution["method"], "job_id": jid}
        ap = os.path.join(wd, "organ_attribution.json"); open(ap, "w").write(json.dumps(attribution, indent=2))
        cap = os.path.join(wd, "change_analysis.json"); open(cap, "w").write(json.dumps(ca, indent=2))
        gcs_cp(ap, f"{prefix}/organ_attribution.json")
        gcs_cp(cap, f"{prefix}/change_analysis.json")     # enriched in place (foci now carry `organ`)
        log(f"DONE — organ_focus_counts={attribution['organ_focus_counts']}")
        print("ATTRIBUTE_RESULT " + json.dumps({"status": "done", "job_id": jid, "compare_job": cjob,
              "n_foci": len(foci), "organ_focus_counts": attribution["organ_focus_counts"],
              "output_gcs": f"{prefix}/organ_attribution.json"}))
    except Exception as e:
        log("ERROR", e); traceback.print_exc()
        print("ATTRIBUTE_RESULT " + json.dumps({"status": "error", "error": str(e), "job_id": jid}))
        sys.exit(1)


if __name__ == "__main__":
    main()
