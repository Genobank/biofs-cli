#!/usr/bin/env python3
"""organ_package_job.py: the program the GPU executor runs, inside the imaging-register image, for `biofs imaging package`.

It takes one finished imaging-register job from the vault, builds its organ package (organ_package.py), verifies the package, uploads it
and prints one line: ORGAN_PACKAGE_RESULT {json}. Decision support for a radiologist, not a diagnosis.

Input is the process environment, set by the executor (never by the caller of the HTTP endpoint directly):
  WALLET, JOB_ID (package-<uuid>), REGISTER_JOB_ID (register-<uuid>), INPUT_GCS, OUTPUT_GCS,
  ORGANS (default, all, or a comma list), FLOORS (true or false), FLOORS_FILE, FLOORS_SHA256, WORKDIR,
  RESULT_DIR (optional, an absolute folder: the final result is also written there as <JOB_ID>.json, so the executor can settle a job
  whose process it lost).
Storage is touched only through `gcloud storage cp` and `gcloud storage ls`, only on the two prefixes of this job.
A refusal (exit 2) happens before any storage call; a failure after that exits 1 and keeps the work folder for diagnosis.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

SCHEMA = "organ-twin-package/1"
RESULT_TAG = "ORGAN_PACKAGE_RESULT "
BUCKET = "genobank-health-imaging"
WALLET_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
PACKAGE_ID_RE = re.compile(r"^package-[0-9a-f-]{36}$")
REGISTER_ID_RE = re.compile(r"^register-[0-9a-f-]{36}$")
ORGAN_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")   # a timepoint label, a pair name, a file name from the manifest
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_ORGANS = 64
LS_OBJECT_RE = re.compile(r"^\s*(\d+)\s+\S+\s+(gs://\S+)\s*$")


class Refusal(Exception):
    """The request is refused before any storage call."""


class Failure(Exception):
    """The job failed after it started."""


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_organs(value):
    v = (value or "").strip()
    if v in ("default", "all"):
        return v
    parts = v.split(",")
    if not v or len(parts) > MAX_ORGANS or any(not ORGAN_NAME_RE.match(p) for p in parts):
        raise Refusal("ORGANS must be default, all, or 1 to 64 organ names of letters, digits, underscore and hyphen")
    return ",".join(parts)


def validate(env):
    """Returns the parameters, or raises Refusal. Touches nothing."""
    wallet = env.get("WALLET", "")
    job_id = env.get("JOB_ID", "")
    register_id = env.get("REGISTER_JOB_ID", "")
    if not WALLET_RE.match(wallet):
        raise Refusal("WALLET is not a 0x address of 40 hex characters")
    if not PACKAGE_ID_RE.match(job_id):
        raise Refusal("JOB_ID must be package-<uuid>")
    if not REGISTER_ID_RE.match(register_id):
        raise Refusal("REGISTER_JOB_ID must be register-<uuid>")
    want_in = f"gs://{BUCKET}/{wallet}/imaging-register/{register_id}"
    want_out = f"gs://{BUCKET}/{wallet}/imaging-organ-package/{job_id}"
    if env.get("INPUT_GCS", "").rstrip("/") != want_in:
        raise Refusal("INPUT_GCS is not the register job of this wallet in the imaging bucket")
    if env.get("OUTPUT_GCS", "").rstrip("/") != want_out:
        raise Refusal("OUTPUT_GCS is not the package folder of this wallet and this job in the imaging bucket")
    organs = parse_organs(env.get("ORGANS", "default"))
    floors_flag = env.get("FLOORS", "")
    if floors_flag not in ("true", "false"):
        raise Refusal("FLOORS must be true or false")
    floors = floors_flag == "true"
    floors_file = floors_sha = None
    if floors:
        floors_file = env.get("FLOORS_FILE", "")
        floors_sha = env.get("FLOORS_SHA256", "")
        if not SHA256_RE.match(floors_sha):
            raise Refusal("FLOORS is true and FLOORS_SHA256 is not a sha256")
        if not floors_file or not os.path.isfile(floors_file):
            raise Refusal("FLOORS is true and the floors file is missing")
        if sha256_file(floors_file) != floors_sha:
            raise Refusal("the floors file does not have the sha256 the executor pins")
    workdir_root = env.get("WORKDIR", "/scratch/organ_package")
    result_dir = env.get("RESULT_DIR") or None
    if result_dir is not None and (not os.path.isabs(result_dir) or ".." in result_dir.split(os.sep)):
        raise Refusal("RESULT_DIR must be an absolute folder")
    return {"wallet": wallet, "job_id": job_id, "register_job_id": register_id, "input": want_in, "output": want_out,
            "organs": organs, "floors": floors, "floors_file": floors_file, "floors_sha": floors_sha,
            "workdir": os.path.join(workdir_root, job_id), "result_dir": result_dir}


def gcloud(args, check=True):
    p = subprocess.run(["gcloud", "storage"] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if check and p.returncode != 0:
        raise Failure((p.stderr or p.stdout or "gcloud failed").strip()[-300:])
    return p


def _safe(name, what):
    if not isinstance(name, str) or not SAFE_NAME_RE.match(name) or ".." in name:
        raise Failure(f"the register manifest holds an unsafe {what}")
    return name


def stage(p, job_out):
    """Copies from the vault what the build reads: the manifest, per timepoint the native CT and labels and the frame labels,
    per pair the rigid transform. Frame labels are optional (the build reads them only where it places a mesh in the deformable frame)."""
    os.makedirs(job_out, exist_ok=True)
    src = p["input"]
    gcloud(["cp", f"{src}/manifest.json", job_out + "/"])
    with open(os.path.join(job_out, "manifest.json")) as f:
        manifest = json.load(f)
    staged, frame_missing = 1, []
    for tp in manifest.get("timepoints") or []:
        label = _safe(tp.get("label"), "timepoint label")
        os.makedirs(os.path.join(job_out, "native", label), exist_ok=True)
        for name in ("ct.nii.gz", "labels.nii.gz"):
            r = gcloud(["cp", f"{src}/native/{label}/{name}", os.path.join(job_out, "native", label) + "/"], check=False)
            if r.returncode != 0:
                raise Failure(f"the register job lacks native/{label}/{name}")
            staged += 1
        os.makedirs(os.path.join(job_out, "frame"), exist_ok=True)
        r = gcloud(["cp", f"{src}/frame/{label}_labels.nii.gz", os.path.join(job_out, "frame") + "/"], check=False)
        if r.returncode == 0:
            staged += 1
        else:
            frame_missing.append(label)
    for pr in manifest.get("pairs") or []:
        pair = _safe(pr.get("pair"), "pair name")
        rig = (pr.get("transforms") or {}).get("rigid")
        if not rig:
            continue
        rig = _safe(rig, "transform name")
        os.makedirs(os.path.join(job_out, "pairs", pair), exist_ok=True)
        r = gcloud(["cp", f"{src}/pairs/{pair}/{rig}", os.path.join(job_out, "pairs", pair) + "/"], check=False)
        if r.returncode != 0:
            raise Failure(f"the register job lacks pairs/{pair}/{rig}")
        staged += 1
    return {"staged": staged, "frame_labels_missing": frame_missing}


def local_files(pkg_dir):
    out = {}
    for d, _, names in os.walk(pkg_dir):
        for n in names:
            fp = os.path.join(d, n)
            out[os.path.relpath(fp, pkg_dir)] = os.path.getsize(fp)
    return out


def upload_and_check(pkg_dir, output):
    """Uploads the package and lists the destination: every file must be there with the size it has here, and nothing else."""
    gcloud(["cp", "--recursive", pkg_dir + "/*", output + "/"])
    listing = gcloud(["ls", "--recursive", "--long", output + "/"]).stdout
    remote = {}
    prefix = output + "/"
    for line in listing.splitlines():
        m = LS_OBJECT_RE.match(line)
        if m and m.group(2).startswith(prefix):
            remote[m.group(2)[len(prefix):]] = int(m.group(1))
    local = local_files(pkg_dir)
    missing = sorted(set(local) - set(remote))
    extra = sorted(set(remote) - set(local))
    wrong = sorted(k for k in set(local) & set(remote) if local[k] != remote[k])
    if missing or extra or wrong:
        raise Failure(f"upload check failed: {len(missing)} missing, {len(extra)} unexpected, {len(wrong)} with another size"
                      + (f" (first missing: {missing[0]})" if missing else ""))
    return {"files": len(local), "bytes": sum(local.values())}


def run(p):
    t0 = time.time()
    import organ_package as OP   # imported late so a refusal needs nothing but the standard library
    workdir = p["workdir"]
    if os.path.exists(workdir):
        raise Failure("the work folder of this job already exists")
    job_out, pkg_dir = os.path.join(workdir, "in"), os.path.join(workdir, "pkg")
    notes = stage(p, job_out)
    OP.build_package(job_out, pkg_dir, organs=p["organs"], floors=p["floors_file"] if p["floors"] else None)
    verdict = OP.verify_package(pkg_dir)
    if not verdict.get("ok"):
        raise Failure("the package failed its own verify: " + "; ".join(str(x) for x in (verdict.get("problems") or [])[:3]))
    with open(os.path.join(pkg_dir, "package.json")) as f:
        pkg = json.load(f)
    floors_sha = (pkg.get("floors") or {}).get("sha256") if p["floors"] else None
    if p["floors"] and floors_sha != p["floors_sha"]:
        raise Failure("the package names a floors file other than the pinned one")
    if not p["floors"] and pkg.get("floors"):
        raise Failure("floors were not requested and the package carries some")
    up = upload_and_check(pkg_dir, p["output"])
    result = {"status": "done", "schema": SCHEMA, "job_id": p["job_id"], "register_job_id": p["register_job_id"],
              "output_gcs": p["output"] + "/", "files": up["files"], "bytes": up["bytes"],
              "verify": {"ok": True, "files_checked": verdict.get("files_checked")},
              "floors_sha256": floors_sha, "built_at": (pkg.get("build") or {}).get("built_at_utc"),
              "organs_built": len(pkg.get("organs") or {}), "frame_labels_missing": notes["frame_labels_missing"],
              "elapsed_sec": round(time.time() - t0, 1)}
    shutil.rmtree(workdir, ignore_errors=True)
    return result


def emit(result, p=None):
    print(RESULT_TAG + json.dumps(result), flush=True)
    if p and p.get("result_dir"):
        try:
            os.makedirs(p["result_dir"], exist_ok=True)
            final = os.path.join(p["result_dir"], p["job_id"] + ".json")
            with open(final + ".tmp", "w") as f:
                json.dump(result, f)
            os.replace(final + ".tmp", final)
        except OSError as e:   # the printed line is the primary record; say so on stderr and go on
            print(f"could not write the result file: {e}", file=sys.stderr)


def main(env=None):
    env = os.environ if env is None else env
    try:
        p = validate(env)
    except Refusal as e:
        emit({"status": "error", "error": str(e)[:300]})
        return 2
    try:
        emit(run(p), p)
        return 0
    except Failure as e:
        emit({"status": "error", "error": str(e)[:500], "job_id": p["job_id"]}, p)
        return 1
    except Exception as e:   # the build itself can raise; the message is kept, the environment is not
        emit({"status": "error", "error": f"{type(e).__name__}: {str(e)[:400]}", "job_id": p["job_id"]}, p)
        return 1


if __name__ == "__main__":
    sys.exit(main())
