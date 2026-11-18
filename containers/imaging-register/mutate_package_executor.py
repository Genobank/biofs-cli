#!/usr/bin/env python3
"""Mutation check for the executor addition (criteria A8 and B9). Each mutant is one deliberate break applied to a THROWAWAY copy;
the real files are never touched. A mutant is caught when the test suite of that file fails on it.
  python3 mutate_package_executor.py py   <python with numpy, SimpleITK, trimesh, pytest>
  python3 mutate_package_executor.py js   <folder holding lib/organ_package_exec.js and test/organ_package_exec.test.mjs>
Prints one line per mutant and a total; exits 1 if any mutant survives."""
import glob
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

PY_MUTANTS = [
    ("skip the wallet and register check of INPUT_GCS", 'if env.get("INPUT_GCS", "").rstrip("/") != want_in:', "if False:"),
    ("skip the OUTPUT_GCS check", 'if env.get("OUTPUT_GCS", "").rstrip("/") != want_out:', "if False:"),
    ("accept a floors file with another sha256", "if sha256_file(floors_file) != floors_sha:", "if False:"),
    ("never check the package's own verify", 'if not verdict.get("ok"):', "if False:"),
    ("trust the upload without comparing the listing", "if missing or extra or wrong:", "if False:"),
    ("stage a file the build does not read", 'gcloud(["cp", f"{src}/manifest.json", job_out + "/"])',
     'gcloud(["cp", f"{src}/manifest.json", job_out + "/"])\n    gcloud(["cp", f"{src}/unrelated.txt", job_out + "/"], check=False)'),
    ("keep the work folder after a verified upload", "    shutil.rmtree(workdir, ignore_errors=True)\n    return result", "    return result"),
    ("read the floors file even when floors are not requested", "    if floors:\n        floors_file = env.get", "    if True:\n        floors_file = env.get"),
    ("allow dots in an organ name", 'ORGAN_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")', 'ORGAN_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")'),
    ("do not compare the package's floors record with the pinned sha256", 'if p["floors"] and floors_sha != p["floors_sha"]:', "if False:"),
    ("a refusal exits 1 instead of 2", '        emit({"status": "error", "error": str(e)[:300]})\n        return 2', '        emit({"status": "error", "error": str(e)[:300]})\n        return 1'),
    ("reuse a work folder that already exists", '    if os.path.exists(workdir):\n        raise Failure("the work folder of this job already exists")\n', ""),
    ("ignore a size difference in the upload", "if local[k] != remote[k])", "if False)"),
    ("accept any name from the manifest", 'if not isinstance(name, str) or not SAFE_NAME_RE.match(name) or ".." in name:', "if False:"),
    ("report no floors hash", 'floors_sha = (pkg.get("floors") or {}).get("sha256") if p["floors"] else None', "floors_sha = None"),
    ("report a made-up organ count", '"organs_built": len(pkg.get("organs") or {})', '"organs_built": 0'),
    ("accept FLOORS values other than true or false", 'if floors_flag not in ("true", "false"):', "if False:"),
    ("accept an unlisted extra object in the destination", "missing = sorted(set(local) - set(remote))\n    extra = sorted(set(remote) - set(local))",
     "missing = sorted(set(local) - set(remote))\n    extra = []"),
    ("upload even if the package carries floors that were not asked for", 'if not p["floors"] and pkg.get("floors"):', "if False:"),
    ("skip the wallet check", 'if not WALLET_RE.match(wallet):', "if False:"),
    ("accept a relative RESULT_DIR", 'if result_dir is not None and (not os.path.isabs(result_dir) or ".." in result_dir.split(os.sep)):', "if False:"),
    ("accept dots in RESULT_DIR", ' or ".." in result_dir.split(os.sep)):', "):"),
    ("never write the result file", 'if p and p.get("result_dir"):', "if False:"),
    ("write the result file under another name", 'final = os.path.join(p["result_dir"], p["job_id"] + ".json")', 'final = os.path.join(p["result_dir"], "result.json")'),
    ("leave a temporary file behind", "os.replace(final + \".tmp\", final)", "shutil.copy(final + \".tmp\", final)"),
    ("a result file that cannot be written ends the job as a failure", "except OSError as e:   # the printed line is the primary record", "except ZeroDivisionError as e:   # the printed line is the primary record"),
    ("print the environment in an error", 'emit({"status": "error", "error": f"{type(e).__name__}: {str(e)[:400]}", "job_id": p["job_id"]}, p)',
     'emit({"status": "error", "error": f"{type(e).__name__}: {str(e)[:400]}", "job_id": p["job_id"], "env": dict(env)}, p)'),
]


def apply(src, old, new):
    if src.count(old) != 1:
        raise SystemExit(f"mutant anchor found {src.count(old)} times, expected 1: {old[:70]!r}")
    return src.replace(old, new)


def run_py(python):
    tmp = tempfile.mkdtemp(prefix="mut_base_")
    try:
        for f in glob.glob(os.path.join(HERE, "*.py")):
            shutil.copy(f, tmp)
        p = subprocess.run([python, "-m", "pytest", "-q", "-p", "no:cacheprovider", "test_organ_package_job.py"], cwd=tmp,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if p.returncode != 0:
            raise SystemExit("the unmutated copy does not pass its own tests, so no mutant result means anything:\n" + p.stdout[-600:])
        print("baseline: the unmutated copy passes all its tests", flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    results = []
    only = sys.argv[3] if len(sys.argv) > 3 else None   # optional: run only the mutants whose name contains this text
    for name, old, new in PY_MUTANTS:
        if only and only not in name:
            continue
        tmp = tempfile.mkdtemp(prefix="mut_job_")
        try:
            for f in glob.glob(os.path.join(HERE, "*.py")):
                shutil.copy(f, tmp)
            target = os.path.join(tmp, "organ_package_job.py")
            src = open(target).read()
            open(target, "w").write(apply(src, old, new))
            chk = subprocess.run([python, "-m", "py_compile", target], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if chk.returncode != 0:
                raise SystemExit(f"mutant '{name}' does not compile, so it proves nothing: {chk.stdout[:200]}")
            p = subprocess.run([python, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", "test_organ_package_job.py"], cwd=tmp,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            caught = p.returncode != 0
            tail = [l for l in p.stdout.splitlines() if l.startswith("FAILED")]
            results.append((name, caught, tail[0][:110] if tail else ""))
            print(f"{'CAUGHT  ' if caught else 'SURVIVED'} {name}   {tail[0][:90] if tail else ''}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return results


JS_MUTANTS = []   # filled from mutate_package_exec_js_list.py when the executor module exists


def _js_tree(folder, tmp):
    """A throwaway copy of the work folder with its siblings the wiring tests read (the VM snapshot and the patch)."""
    shutil.copytree(folder, os.path.join(tmp, "work"), ignore=shutil.ignore_patterns("node_modules", ".git"))
    parent = os.path.dirname(os.path.abspath(folder))
    shutil.copytree(os.path.join(parent, "vm_snapshot"), os.path.join(tmp, "vm_snapshot"))
    shutil.copy(os.path.join(parent, "organ_package_executor.patch"), tmp)
    return os.path.join(tmp, "work")


def _js_tests(w):
    tests = sorted(glob.glob(os.path.join(w, "test", "*.test.mjs")))
    p = subprocess.run(["node", "--test", "--test-reporter=tap"] + tests, cwd=w, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    fails = [l.strip() for l in p.stdout.splitlines() if l.strip().startswith("not ok")]
    return p.returncode, fails


def run_js(folder):
    sys.path.insert(0, HERE)
    from mutate_package_exec_js_list import JS_MUTANTS as MUT  # noqa
    tmp = tempfile.mkdtemp(prefix="mut_base_")
    try:
        w = _js_tree(folder, tmp)
        code, fails = _js_tests(w)
        if code != 0 or fails:
            raise SystemExit(f"the unmutated copy does not pass its own tests ({len(fails)} fail), so no mutant result means anything: {fails[:3]}")
        print("baseline: the unmutated copy passes all its tests", flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    results = []
    for name, old, new in MUT:
        tmp = tempfile.mkdtemp(prefix="mut_exec_")
        try:
            w = _js_tree(folder, tmp)
            target = os.path.join(w, "lib", "organ_package_exec.js")
            src = open(target).read()
            open(target, "w").write(apply(src, old, new))
            chk = subprocess.run(["node", "--check", target], cwd=w, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if chk.returncode != 0:
                raise SystemExit(f"mutant '{name}' does not parse, so it proves nothing: {chk.stdout[:200]}")
            code, fails = _js_tests(w)
            caught = code != 0 and bool(fails)
            results.append((name, caught, fails[0][:110] if fails else ""))
            print(f"{'CAUGHT  ' if caught else 'SURVIVED'} {name}   {len(fails)} tests fail; first: {fails[0][:100] if fails else ''}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return results


if __name__ == "__main__":
    kind = sys.argv[1]
    res = run_py(sys.argv[2]) if kind == "py" else run_js(sys.argv[2])
    caught = sum(1 for _, c, _ in res if c)
    print(f"{caught} of {len(res)} mutants caught")
    sys.exit(0 if caught == len(res) else 1)
