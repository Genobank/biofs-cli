#!/bin/bash
# GPU VM (CPU work only): build the organ package for the chest job and the abdomen job, verify it, run the real-data checks RD1 to RD6.
# Everything stays on the VM's persistent disk. Nothing is written to the vault. Log: $ROOT/run.log. Run with bash.
set -u
W0=0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
CH=register-ef1676c3-6231-435d-a219-e12e1702ff87
AB=register-e05d1252-b3a6-4fcf-9aec-1765c1f6392b
ROOT=/mnt/scratch/organ_package_20261106; T=/tmp/orgpkg
IMG=imaging-register:v27-20261105
sudo mkdir -p $ROOT/jobs $ROOT/pkg $ROOT/reports && sudo chown -R "$(id -u):$(id -g)" $ROOT
exec > >(tee -a $ROOT/run.log) 2>&1
fail() { echo "FAILED at: $1"; exit 1; }
echo "== start $(date -u +%H:%M:%SZ)"
echo "== 0 what the image has"
sudo docker run --rm --entrypoint python $IMG -c "
import importlib.util as u, trimesh, skimage, scipy, SimpleITK
print('trimesh', trimesh.__version__, 'skimage', skimage.__version__, 'scipy', scipy.__version__, 'SimpleITK', SimpleITK.Version.VersionString())
print('fast_simplification', u.find_spec('fast_simplification') is not None)" || fail image_imports
echo "== 0b the unit tests inside this image (its trimesh and SimpleITK are not the laptop's)"
sudo docker run --rm --entrypoint python -v $T:/t:ro -e PYTHONPATH=/t $IMG -c "
import sys, importlib, time
t = importlib.import_module('test_organ_package'); bad = 0; n = 0
for name in sorted(x for x in dir(t) if x.startswith('test_')):
    n += 1
    try: getattr(t, name)(); print('PASS', name)
    except Exception as e: bad += 1; print('FAIL', name, type(e).__name__, str(e)[:300])
print(n, 'tests', bad, 'failed')" 2>&1 | grep -E '^(PASS|FAIL|[0-9]+ tests)'
echo "== 1 stage the two job outputs from the vault, server side"
for JOB in $CH $AB; do
  D=$ROOT/jobs/$JOB; SRC=gs://genobank-health-imaging/$W0/imaging-register/$JOB
  mkdir -p $D
  [ -f $D/manifest.json ] || gcloud storage cp $SRC/manifest.json $D/ >/dev/null || fail manifest_$JOB
  TPS=$(python3 -c "import json;print(' '.join(t['label'] for t in json.load(open('$D/manifest.json'))['timepoints']))")
  PAIRS=$(python3 -c "import json;print(' '.join(p['pair'] for p in json.load(open('$D/manifest.json'))['pairs']))")
  for TP in $TPS; do
    mkdir -p $D/native/$TP $D/frame
    [ -f $D/native/$TP/ct.nii.gz ] || gcloud storage cp $SRC/native/$TP/ct.nii.gz $SRC/native/$TP/labels.nii.gz $D/native/$TP/ >/dev/null || fail native_${JOB}_$TP
    [ -f $D/frame/${TP}_labels.nii.gz ] || gcloud storage cp $SRC/frame/${TP}_labels.nii.gz $D/frame/ >/dev/null || fail frame_${JOB}_$TP
  done
  for P in $PAIRS; do
    mkdir -p $D/pairs/$P
    [ -f $D/pairs/$P/rigid.mat ] || gcloud storage cp $SRC/pairs/$P/rigid.mat $D/pairs/$P/ >/dev/null || fail rigid_${JOB}_$P
  done
  gcloud storage cp $SRC/lung_volume_report.json $ROOT/lung_$JOB.json >/dev/null 2>&1 || true
  echo "   $JOB staged: $(du -sh $D | cut -f1), timepoints $TPS"
done
[ -f $ROOT/lung_$CH.json ] || cp $T/lung_volume_report_chest.json $ROOT/lung_$CH.json
echo "== 2 build and verify"
for JOB in $CH $AB; do
  sudo rm -rf $ROOT/pkg/$JOB
  S=$(date +%s)
  sudo docker run --rm --cpus 8 --entrypoint python -v $T:/t:ro -v $ROOT:/w $IMG /t/organ_package.py build --job-out /w/jobs/$JOB --out /w/pkg/$JOB --organs default 2>&1 | grep -v '^\[organ_package\] [a-z_]*:' | tail -12
  echo "   build+verify of $JOB: exit ${PIPESTATUS[0]}, $(( $(date +%s) - S )) s, $(sudo du -sh $ROOT/pkg/$JOB 2>/dev/null | cut -f1), $(sudo find $ROOT/pkg/$JOB -type f 2>/dev/null | wc -l) files"
done
echo "== 3 real-data checks"
for JOB in $CH $AB; do
  sudo docker run --rm --entrypoint python -v $T:/t:ro -v $ROOT:/w $IMG /t/organ_package_real_checks.py --job-out /w/jobs/$JOB --package /w/pkg/$JOB --lung-report /w/lung_$JOB.json --out /w/reports/$JOB.json 2>&1 | tail -12
done
sudo chmod -R a+r $ROOT/reports
echo "== ALL_DONE $(date -u +%H:%M:%SZ)"
