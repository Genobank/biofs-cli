#!/usr/bin/env python3
"""Test-only stand-in for `gcloud storage cp`, so an executor can run unchanged with its storage on a local folder.

The executors (findings_runner, vista3d_runner, the lesion tracker) touch storage only through `gcloud storage cp`. Put this file on PATH
under the name `gcloud` and set FAKE_GCS to a folder: gs://bucket/path is read from and written to $FAKE_GCS/bucket/path. Nothing leaves the
machine. Every call is appended to $FAKE_GCS/_gcloud_calls.log, so the run itself shows that no other storage call was made. Any other
gcloud command, and any flag it does not know, stops with an error instead of being ignored."""
import glob
import os
import shutil
import sys
import time

KNOWN_FLAGS = ("--recursive", "-r", "--quiet", "-q", "--long", "-l")


def local(p, root):
    return os.path.join(root, p[5:]) if p.startswith("gs://") else p


def run(argv, root):
    with open(os.path.join(root, "_gcloud_calls.log"), "a") as log:
        log.write(f"{time.strftime('%H:%M:%SZ', time.gmtime())} gcloud {' '.join(argv)}\n")
    if argv[:2] == ["storage", "ls"]:
        return ls(argv[2:], root)
    if argv[:2] != ["storage", "cp"]:
        sys.exit(f"fake gcloud: unsupported command: {argv}")
    args = [a for a in argv[2:] if a not in KNOWN_FLAGS]
    if any(a.startswith("-") for a in args):
        sys.exit(f"fake gcloud: unsupported flag in {argv}")
    if len(args) < 2:
        sys.exit("fake gcloud: need a source and a destination")
    *srcs, dest = args
    dest_l = local(dest, root)
    files = []
    for s in srcs:
        found = sorted(glob.glob(local(s, root)))
        if not found:
            sys.exit(f"fake gcloud: no URLs matched: {s}")
        files += found
    to_dir = dest.endswith("/") or len(files) > 1 or os.path.isdir(dest_l)
    drop = os.environ.get("FAKE_GCS_DROP") if dest.startswith("gs://") else None
    for f in files:
        if os.path.isdir(f):
            ignore = (lambda d, names: [n for n in names if drop in os.path.join(d, n)]) if drop else None
            shutil.copytree(f, os.path.join(dest_l, os.path.basename(f.rstrip("/"))), dirs_exist_ok=True, ignore=ignore)
        elif drop and drop in f:
            continue
        elif to_dir:
            os.makedirs(dest_l, exist_ok=True)
            shutil.copy2(f, os.path.join(dest_l, os.path.basename(f)))
        else:
            os.makedirs(os.path.dirname(dest_l) or ".", exist_ok=True)
            shutil.copy2(f, dest_l)
    return 0


def ls(argv, root):
    """`gcloud storage ls [--recursive] [--long] gs://...`, in the format the real tool prints (checked against the real tool 2026-11-14):
    a directory header line ending in ':' followed by its objects, a blank line between directories; with --long each object line is
    '<size>  <time>  <url>'. Without --recursive only the direct children are listed."""
    recursive = any(a in ("--recursive", "-r") for a in argv)
    long_ = any(a in ("--long", "-l") for a in argv)
    urls = [a for a in argv if not a.startswith("-")]
    if len(urls) != 1 or any(a.startswith("-") and a not in KNOWN_FLAGS for a in argv):
        sys.exit(f"fake gcloud: unsupported ls arguments: {argv}")
    base = urls[0].rstrip("/")
    base_l = local(base, root)
    if not os.path.isdir(base_l):
        sys.exit(f"fake gcloud: ls: no URLs matched: {urls[0]}")
    walk = sorted(os.walk(base_l)) if recursive else [next(os.walk(base_l))]
    for d, dirs, names in walk:
        rel = os.path.relpath(d, base_l)
        url = base if rel == "." else base + "/" + rel
        print(url + "/:")
        for n in sorted(names):
            fp = os.path.join(d, n)
            print(f"{os.path.getsize(fp):>10}  2026-11-14T00:00:00Z  {url}/{n}" if long_ else f"{url}/{n}")
        if not recursive:
            for dn in sorted(dirs):
                print(f"{url}/{dn}/")
        print()
    return 0


if __name__ == "__main__":
    root = os.environ.get("FAKE_GCS")
    if not root or not os.path.isdir(root):
        sys.exit("fake gcloud: FAKE_GCS must name an existing folder")
    sys.exit(run(sys.argv[1:], root))
