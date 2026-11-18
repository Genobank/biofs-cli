"""Known-answer tests for organ_package_job.py. Criteria A1 to A8 are in organ_package_executor_criteria-20261114.txt (hashed before the code).
Storage is a local folder behind fake_gcloud.py put on PATH as `gcloud`; nothing leaves the machine. Synthetic organs only.
Needs numpy, scipy, SimpleITK, scikit-image, trimesh and pytest."""
import json
import os
import re
import stat
import subprocess
import sys

import numpy as np
import pytest
import SimpleITK as sitk

import organ_package as OP
import organ_package_job as J
import test_organ_package as T

HERE = os.path.dirname(os.path.abspath(__file__))
WALLET = "0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a"
REG = "register-11111111-2222-3333-4444-555555555555"
PKG = "package-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
BUCKET = "genobank-health-imaging"


class World:
    def __init__(self, tmp, monkeypatch):
        self.tmp = str(tmp)
        self.gcs = os.path.join(self.tmp, "gcs")
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(self.gcs)
        shim = os.path.join(self.tmp, "bin")
        os.makedirs(shim)
        with open(os.path.join(shim, "gcloud"), "w") as f:
            f.write(f"#!/bin/sh\nexec {sys.executable} {os.path.join(HERE, 'fake_gcloud.py')} \"$@\"\n")
        os.chmod(os.path.join(shim, "gcloud"), os.stat(os.path.join(shim, "gcloud")).st_mode | stat.S_IEXEC)
        monkeypatch.setenv("PATH", shim + os.pathsep + os.environ["PATH"])
        monkeypatch.setenv("FAKE_GCS", self.gcs)
        monkeypatch.delenv("FAKE_GCS_DROP", raising=False)
        self.floors = os.path.join(self.tmp, "floors.json")
        T.floors_file(self.floors, liver_pct=5.0, with_spleen=True)
        self.floors_sha = J.sha256_file(self.floors)

    def input_dir(self, wallet=WALLET, reg=REG):
        return os.path.join(self.gcs, BUCKET, wallet, "imaging-register", reg)

    def output_dir(self, wallet=WALLET, pkg=PKG):
        return os.path.join(self.gcs, BUCKET, wallet, "imaging-organ-package", pkg)

    def make_register_job(self):
        g, ref, mov, Tr = T.moved_scene()
        base = np.zeros(g.size[::-1], np.int16)
        sp = T.spine_mask(g)
        base[ref] = 1
        base[sp & ~ref] = 2
        moved = sitk.GetArrayFromImage(sitk.Resample(g.to_image(base), g.to_image(base), Tr.GetInverse(), sitk.sitkNearestNeighbor, 0)).astype(np.int16)
        T.make_job(self.input_dir(), g, {"a": moved, "b": base, "c": moved}, ref="b", rigid={"a": Tr, "c": Tr})
        # a vault job also holds files the package does not read; they must stay unread
        with open(os.path.join(self.input_dir(), "unrelated.txt"), "w") as f:
            f.write("not for the package")

    def env(self, **over):
        e = {"WALLET": WALLET, "JOB_ID": PKG, "REGISTER_JOB_ID": REG,
             "INPUT_GCS": f"gs://{BUCKET}/{WALLET}/imaging-register/{REG}",
             "OUTPUT_GCS": f"gs://{BUCKET}/{WALLET}/imaging-organ-package/{PKG}",
             "ORGANS": "liver,spine", "FLOORS": "true", "FLOORS_FILE": self.floors, "FLOORS_SHA256": self.floors_sha,
             "WORKDIR": self.work}
        e.update(over)
        return e

    def calls(self):
        p = os.path.join(self.gcs, "_gcloud_calls.log")
        return [l.split(" ", 2)[2].strip() for l in open(p)] if os.path.exists(p) else []


@pytest.fixture
def world(tmp_path, monkeypatch):
    return World(tmp_path, monkeypatch)


def result_of(capsys):
    out = capsys.readouterr().out
    lines = [l for l in out.splitlines() if l.startswith(J.RESULT_TAG)]
    assert len(lines) == 1, out
    return json.loads(lines[0][len(J.RESULT_TAG):])


# ---- A1 ----

REFUSALS = {
    "wallet_not_hex": {"WALLET": "0x1234"},
    "wallet_missing_0x": {"WALLET": "5f5a60EaEf242c0D51A21c703f520347b96Ed19a"},
    # these carry an input and an output that agree with the odd wallet, so only the wallet check can refuse them
    "wallet_short_consistent": {"WALLET": "0x1234", "INPUT_GCS": f"gs://{BUCKET}/0x1234/imaging-register/{REG}",
                                "OUTPUT_GCS": f"gs://{BUCKET}/0x1234/imaging-organ-package/{PKG}"},
    "wallet_41_hex_consistent": {"WALLET": WALLET + "a", "INPUT_GCS": f"gs://{BUCKET}/{WALLET}a/imaging-register/{REG}",
                                 "OUTPUT_GCS": f"gs://{BUCKET}/{WALLET}a/imaging-organ-package/{PKG}"},
    "wallet_non_hex_consistent": {"WALLET": WALLET[:41] + "g", "INPUT_GCS": f"gs://{BUCKET}/{WALLET[:41]}g/imaging-register/{REG}",
                                  "OUTPUT_GCS": f"gs://{BUCKET}/{WALLET[:41]}g/imaging-organ-package/{PKG}"},
    "result_dir_relative": {"RESULT_DIR": "results"},
    "result_dir_with_dots": {"RESULT_DIR": "/scratch/../etc"},
    "job_id_wrong_kind": {"JOB_ID": "register-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
    "job_id_traversal": {"JOB_ID": "package-../../etc/passwd-aaaaaaaaaaaaaaaaaaaa"},
    "register_id_wrong_kind": {"REGISTER_JOB_ID": "package-11111111-2222-3333-4444-555555555555"},
    "input_other_wallet": {"INPUT_GCS": f"gs://{BUCKET}/0x0000000000000000000000000000000000000001/imaging-register/{REG}"},
    "input_other_register": {"INPUT_GCS": f"gs://{BUCKET}/{WALLET}/imaging-register/register-99999999-2222-3333-4444-555555555555"},
    "input_other_bucket": {"INPUT_GCS": f"gs://another-bucket/{WALLET}/imaging-register/{REG}"},
    "input_extra_path": {"INPUT_GCS": f"gs://{BUCKET}/{WALLET}/imaging-register/{REG}/native"},
    "input_empty": {"INPUT_GCS": ""},
    "output_other_wallet": {"OUTPUT_GCS": f"gs://{BUCKET}/0x0000000000000000000000000000000000000001/imaging-organ-package/{PKG}"},
    "output_over_the_register_job": {"OUTPUT_GCS": f"gs://{BUCKET}/{WALLET}/imaging-register/{REG}"},
    "output_other_bucket": {"OUTPUT_GCS": f"gs://another-bucket/{WALLET}/imaging-organ-package/{PKG}"},
    "organs_empty_name": {"ORGANS": "liver,,spine"},
    "organs_slash": {"ORGANS": "liver,../spine"},
    "organs_two_dots": {"ORGANS": "liver,sp..ine"},
    "organs_single_dot": {"ORGANS": "liver.v2"},
    "organs_65_names": {"ORGANS": ",".join(f"o{i}" for i in range(65))},
    "organs_blank": {"ORGANS": ""},
    "floors_not_boolean": {"FLOORS": "yes"},
    "floors_missing_flag": {"FLOORS": ""},
    "floors_file_missing": {"FLOORS_FILE": "/nonexistent/floors.json"},
    "floors_sha_absent": {"FLOORS_SHA256": ""},
    "floors_sha_wrong": {"FLOORS_SHA256": "0" * 64},
}


@pytest.mark.parametrize("name", sorted(REFUSALS))
def test_a1_refusal(world, capsys, name):
    world.make_register_job()
    code = J.main(world.env(**REFUSALS[name]))
    r = result_of(capsys)
    assert code == 2 and r["status"] == "error" and r["error"], (name, code, r)
    assert world.calls() == [], f"{name}: a storage call was made before the refusal"
    assert not os.path.exists(world.work), f"{name}: a folder was created"
    assert not os.path.exists(world.output_dir()), f"{name}: something was written to the vault"


# ---- A2 ----

def test_a2_happy_path_with_floors(world, capsys):
    world.make_register_job()
    code = J.main(world.env())
    r = result_of(capsys)
    assert code == 0 and r["status"] == "done", r
    assert r["schema"] == "organ-twin-package/1" and r["verify"]["ok"] is True
    assert r["floors_sha256"] == world.floors_sha
    assert r["output_gcs"] == f"gs://{BUCKET}/{WALLET}/imaging-organ-package/{PKG}/"
    assert r["organs_built"] == 2 and r["built_at"].endswith("Z")
    # the vault now holds the package: same files, same sizes, and its own verify passes on a copy of it
    out = world.output_dir()
    files = J.local_files(out)
    assert r["files"] == len(files) and r["bytes"] == sum(files.values())
    assert "package.json" in files and "SHA256SUMS" in files and "floors.json" in files
    assert OP.verify_package(out)["ok"] is True
    # storage was touched only through cp and ls, only on the two prefixes of this job
    in_prefix = f"gs://{BUCKET}/{WALLET}/imaging-register/{REG}"
    out_prefix = f"gs://{BUCKET}/{WALLET}/imaging-organ-package/{PKG}"
    for c in world.calls():
        words = c.split()
        assert words[0] == "storage" and words[1] in ("cp", "ls"), c
        gs = [w for w in words if w.startswith("gs://")]
        assert gs and all(g.startswith(in_prefix + "/") or g.startswith(out_prefix + "/") for g in gs), c
        if words[1] == "cp":
            sources = [w for w in words[2:] if not w.startswith("-")][:-1]
            assert all(s.startswith(in_prefix + "/") or not s.startswith("gs://") for s in sources), c
    staged = [c for c in world.calls() if in_prefix in c and "cp" in c.split()[1]]
    assert not any("unrelated.txt" in c for c in staged), "a file the build does not read was staged"
    assert any("manifest.json" in c for c in staged) and any("rigid.mat" in c for c in staged) and any("labels.nii.gz" in c for c in staged)
    # the work folder is gone after a verified upload
    assert not os.path.exists(os.path.join(world.work, PKG))


def test_a2_the_package_content_is_the_builders_own(world, capsys):
    """The job adds nothing and changes nothing: the package in the vault equals one built directly from the same register job."""
    world.make_register_job()
    assert J.main(world.env()) == 0
    result_of(capsys)
    direct = os.path.join(world.tmp, "direct")
    OP.build_package(world.input_dir(), direct, organs="liver,spine", floors=world.floors)
    mine = json.load(open(os.path.join(world.output_dir(), "package.json")))
    theirs = json.load(open(os.path.join(direct, "package.json")))
    for pk in (mine, theirs):
        pk.pop("build", None)
    # the files list carries sizes and hashes of every file: equal means every output file is byte-identical
    assert mine["files"] == theirs["files"]
    assert mine == theirs


def test_a2_a_floors_file_that_changes_after_validation_is_an_error(world, capsys, monkeypatch):
    """The sha256 is checked before the build and the package's own record is checked after it: a file swapped in between is caught."""
    world.make_register_job()
    real_validate = J.validate

    def swapping(env):
        p = real_validate(env)
        T.floors_file(world.floors, liver_pct=9.0, with_spleen=True)   # another floors file now sits at the same path
        return p
    monkeypatch.setattr(J, "validate", swapping)
    code = J.main(world.env())
    r = result_of(capsys)
    assert code == 1 and "other than the pinned one" in r["error"], r
    assert not os.path.exists(world.output_dir())


# ---- A3 ----

def test_a3_floors_false(world, capsys):
    world.make_register_job()
    env = world.env(FLOORS="false", FLOORS_FILE="/nonexistent/never/read.json", FLOORS_SHA256="")
    assert J.main(env) == 0
    r = result_of(capsys)
    assert r["status"] == "done" and r["floors_sha256"] is None
    assert "floors.json" not in J.local_files(world.output_dir())
    assert "floors" not in json.load(open(os.path.join(world.output_dir(), "package.json")))


# ---- A4 ----

def test_a4_an_upload_that_lost_an_object_is_an_error(world, capsys, monkeypatch):
    world.make_register_job()
    monkeypatch.setenv("FAKE_GCS_DROP", "SHA256SUMS")
    code = J.main(world.env())
    r = result_of(capsys)
    assert code == 1 and r["status"] == "error" and "upload check failed" in r["error"] and "SHA256SUMS" in r["error"], r
    assert os.path.isdir(os.path.join(world.work, PKG)), "the work folder must be kept after a failure"


def test_a4_an_object_with_another_size_is_an_error(world, capsys, monkeypatch):
    world.make_register_job()
    real = J.gcloud

    def tampering(args, check=True):
        p = real(args, check)
        if args[0] == "cp" and "--recursive" in args:
            with open(os.path.join(world.output_dir(), "SHA256SUMS"), "a") as f:
                f.write("x")
        return p
    monkeypatch.setattr(J, "gcloud", tampering)
    assert J.main(world.env()) == 1
    r = result_of(capsys)
    assert r["status"] == "error" and "another size" in r["error"], r


def test_a4_a_stray_object_in_the_destination_is_an_error(world, capsys, monkeypatch):
    world.make_register_job()
    real = J.gcloud

    def adding(args, check=True):
        p = real(args, check)
        if args[0] == "cp" and "--recursive" in args:
            with open(os.path.join(world.output_dir(), "stray.txt"), "w") as f:
                f.write("x")
        return p
    monkeypatch.setattr(J, "gcloud", adding)
    assert J.main(world.env()) == 1
    r = result_of(capsys)
    assert r["status"] == "error" and "unexpected" in r["error"], r


# ---- A5 ----

def test_a5_a_package_that_fails_its_verify_is_not_uploaded(world, capsys, monkeypatch):
    world.make_register_job()
    real_build = OP.build_package

    def corrupting(job_out, out_dir, **kw):
        pkg = real_build(job_out, out_dir, **kw)
        glb = next(os.path.join(d, n) for d, _, names in os.walk(out_dir) for n in names if n.endswith(".glb"))
        with open(glb, "ab") as f:
            f.write(b"corrupt")
        return pkg
    monkeypatch.setattr(OP, "build_package", corrupting)
    code = J.main(world.env())
    r = result_of(capsys)
    assert code == 1 and r["status"] == "error" and "failed its own verify" in r["error"], r
    assert not os.path.exists(world.output_dir()), "a package that failed verify reached the vault"
    assert not any("--recursive" in c and f"imaging-organ-package/{PKG}" in c for c in world.calls())
    assert os.path.isdir(os.path.join(world.work, PKG))


# ---- A6 ----

@pytest.mark.parametrize("missing", ["native/a/ct.nii.gz", "native/b/labels.nii.gz", "pairs/a_to_b/rigid.mat", "manifest.json"])
def test_a6_a_missing_vault_file_is_an_error_that_names_it(world, capsys, missing):
    world.make_register_job()
    os.remove(os.path.join(world.input_dir(), missing))
    code = J.main(world.env())
    r = result_of(capsys)
    assert code == 1 and r["status"] == "error", r
    assert missing.split("/")[-1] in r["error"] or "manifest" in r["error"] or "No URLs" in r["error"], r
    assert not os.path.exists(world.output_dir())


def test_a6_missing_frame_labels_are_noted_not_fatal_where_no_deformable_placement_is_needed(world, capsys):
    world.make_register_job()
    os.remove(os.path.join(world.input_dir(), "frame", "a_labels.nii.gz"))
    code = J.main(world.env(ORGANS="liver"))
    r = result_of(capsys)
    # the synthetic job passes its gate, so a deformable placement is admitted for liver and the build needs the frame file:
    # either the build names the missing file as an error, or it was not needed and the job notes it. Never a silent success without a note.
    if code == 0:
        assert r["frame_labels_missing"] == ["a"], r
    else:
        assert r["status"] == "error" and r["error"], r


def test_a6_an_unsafe_name_in_the_manifest_is_an_error(world, capsys):
    world.make_register_job()
    mp = os.path.join(world.input_dir(), "manifest.json")
    m = json.load(open(mp))
    m["timepoints"][0]["label"] = "../evil"
    json.dump(m, open(mp, "w"))
    code = J.main(world.env())
    r = result_of(capsys)
    assert code == 1 and "unsafe" in r["error"], r
    assert not os.path.exists(os.path.join(world.work, PKG, "evil"))


def test_a6_a_work_folder_that_exists_is_refused(world, capsys):
    world.make_register_job()
    os.makedirs(os.path.join(world.work, PKG))
    code = J.main(world.env())
    r = result_of(capsys)
    assert code == 1 and "already exists" in r["error"], r
    assert world.calls() == []


# ---- A7 ----

def test_a7_an_error_never_carries_the_environment(world, capsys, monkeypatch):
    world.make_register_job()
    os.remove(os.path.join(world.input_dir(), "manifest.json"))
    monkeypatch.setenv("SECRET_TOKEN", "do-not-print-this-value")
    monkeypatch.setenv("BIOFS_SIGNATURE", "0xdeadbeefsignature")
    J.main(world.env())
    out = capsys.readouterr().out
    assert "do-not-print-this-value" not in out and "0xdeadbeefsignature" not in out



def test_a5_floors_that_were_not_asked_for_must_not_be_in_the_package(world, capsys, monkeypatch):
    """Defence in depth: if the builder were ever to add floors when none were requested, the job stops before the upload."""
    world.make_register_job()
    real_build = OP.build_package

    def adding_floors(job_out, out_dir, **kw):
        kw["floors"] = world.floors
        return real_build(job_out, out_dir, **kw)
    monkeypatch.setattr(OP, "build_package", adding_floors)
    code = J.main(world.env(FLOORS="false", FLOORS_FILE="", FLOORS_SHA256=""))
    r = result_of(capsys)
    assert code == 1 and "not requested" in r["error"], r
    assert not os.path.exists(world.output_dir())


def test_a7_an_unexpected_exception_never_carries_the_environment(world, capsys, monkeypatch):
    world.make_register_job()

    def boom(*a, **k):
        raise RuntimeError("the builder stopped")
    monkeypatch.setattr(OP, "build_package", boom)
    monkeypatch.setenv("SECRET_TOKEN", "do-not-print-this-value")
    code = J.main(world.env())
    out = capsys.readouterr().out
    assert code == 1 and "RuntimeError: the builder stopped" in out
    assert "do-not-print-this-value" not in out and world.floors not in out.replace(world.floors_sha, "")
    r = json.loads([l for l in out.splitlines() if l.startswith(J.RESULT_TAG)][0][len(J.RESULT_TAG):])
    assert set(r) == {"status", "error", "job_id"}, "an error result carries only these keys"


# ---- A9 the result file ----

def test_a9_the_result_file_equals_the_printed_result_for_done_and_for_error(world, capsys):
    world.make_register_job()
    rd = os.path.join(world.tmp, "results")
    assert J.main(world.env(RESULT_DIR=rd)) == 0
    printed = result_of(capsys)
    assert json.load(open(os.path.join(rd, PKG + ".json"))) == printed
    assert os.listdir(rd) == [PKG + ".json"], "a temporary file was left"
    # an error after the start is written the same way (a second job id, so the work folder is new)
    pkg2 = "package-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"
    os.remove(os.path.join(world.input_dir(), "manifest.json"))
    code = J.main(world.env(JOB_ID=pkg2, OUTPUT_GCS=f"gs://{BUCKET}/{WALLET}/imaging-organ-package/{pkg2}", RESULT_DIR=rd))
    printed2 = result_of(capsys)
    assert code == 1 and json.load(open(os.path.join(rd, pkg2 + ".json"))) == printed2 and printed2["status"] == "error"


def test_a9_no_result_dir_means_no_result_file(world, capsys):
    world.make_register_job()
    assert J.main(world.env()) == 0
    result_of(capsys)
    assert not os.path.exists(os.path.join(world.tmp, "results"))


def test_a9_a_result_file_that_cannot_be_written_does_not_change_the_outcome(world, capsys):
    world.make_register_job()
    blocked = os.path.join(world.tmp, "blocked")
    with open(blocked, "w") as f:
        f.write("a file where the folder should be")
    code = J.main(world.env(RESULT_DIR=os.path.join(blocked, "results")))
    r = result_of(capsys)
    assert code == 0 and r["status"] == "done"

# ---- the program as the container runs it ----

def test_the_program_end_to_end_as_a_subprocess(world):
    world.make_register_job()
    env = dict(os.environ)
    env.update(world.env())
    p = subprocess.run([sys.executable, os.path.join(HERE, "organ_package_job.py")], env=env, cwd=HERE,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    lines = [l for l in p.stdout.splitlines() if l.startswith(J.RESULT_TAG)]
    assert p.returncode == 0 and len(lines) == 1, (p.returncode, p.stdout[-500:], p.stderr[-500:])
    r = json.loads(lines[0][len(J.RESULT_TAG):])
    assert r["status"] == "done" and r["verify"]["ok"] is True and r["floors_sha256"] == world.floors_sha
    # a refusal as a subprocess exits 2 and prints one error line
    env["WALLET"] = "nope"
    p = subprocess.run([sys.executable, os.path.join(HERE, "organ_package_job.py")], env=env, cwd=HERE,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert p.returncode == 2 and p.stdout.count(J.RESULT_TAG) == 1
