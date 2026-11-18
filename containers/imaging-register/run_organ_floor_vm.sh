#!/bin/bash
# GPU VM: organ volume floors (S1 perturbation of the operator's scans, S2 same-day repeats, S3 reconstruction pairs), the floors file, both packages
# rebuilt with the floors, and the real-data checks. Everything on the VM's persistent disk; nothing in the vault. Log: $ROOT/run.log. Run with bash.
set -u
CH=register-ef1676c3-6231-435d-a219-e12e1702ff87
AB=register-e05d1252-b3a6-4fcf-9aec-1765c1f6392b
ROOT=/mnt/scratch/organ_floor_20261106; T=/tmp/orgfloor
IMG=imaging-register:v27-20261105
JOBS=/mnt/scratch/organ_package_20261106/jobs
sudo mkdir -p $ROOT/s1 $ROOT/pkg $ROOT/reports && sudo chown -R "$(id -u):$(id -g)" $ROOT
exec > >(tee -a $ROOT/run.log) 2>&1
echo "== start $(date -u +%H:%M:%SZ)"
for J in $CH $AB; do [ -f $JOBS/$J/manifest.json ] || { echo "FAILED at: job $J is not staged"; exit 1; }; done
RUN="sudo docker run --rm --entrypoint python -v $T:/t:ro -v $JOBS:/jobs:ro -v $ROOT:/w"
echo "== 0 unit tests inside the image"
sudo docker run --rm --entrypoint python -v $T:/t:ro -e PYTHONPATH=/t $IMG -c "
import importlib
for mod in ('test_organ_package', 'test_organ_floor'):
    t = importlib.import_module(mod); bad = 0; n = 0
    for name in sorted(x for x in dir(t) if x.startswith('test_')):
        n += 1
        try: getattr(t, name)()
        except Exception as e: bad += 1; print('FAIL', mod, name, type(e).__name__, str(e)[:300])
    print(mod, n, 'tests', bad, 'failed')" 2>&1 | grep -E '^(FAIL|test_)'
echo "== 1 S2 same-day repeats, read from the labels already on disk"
sudo docker run --rm --entrypoint python -v $T:/t:ro -v /mnt/scratch/benchmarks/rider_repeat/data:/rr -v $ROOT:/w $IMG /t/organ_floor.py repeats --dir /rr --out /w/s2_repeats.json 2>&1 | grep -v Warning | tail -3
echo "== 1b S3 plan (headers only)"
sudo docker run --rm --entrypoint python -v $T:/t:ro -v /mnt/scratch/benchmarks/rider:/kd:ro $IMG /t/organ_floor.py kernel --dir /kd --out /dev/null --plan-only 2>&1 | grep -E '"pair"|"failed"|reason|lung and' | head -40
echo "== 2 S1 perturbation of the operator's scans, 7 segmentations per scan"
# A scan whose record already holds V0 to V6 with no failure is kept; a scan with a partial record is cleared and redone from V0.
scan_complete() { python3 - "$1" <<'PY'
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if sorted(r.get("variants", {})) == ["V0", "V1", "V2", "V3", "V4", "V5", "V6"] and not r.get("failed") else 1)
PY
}
for JOB in $AB $CH; do
  for SCAN in $(python3 -c "import json;print(' '.join(t['label'] for t in json.load(open('$JOBS/$JOB/manifest.json'))['timepoints']))"); do
    if scan_complete $ROOT/s1/${JOB:0:17}/s1_${JOB}_${SCAN}.json; then echo "   $JOB $SCAN: record complete, kept"; continue; fi
    sudo rm -rf $ROOT/s1/${JOB:0:17}/$SCAN $ROOT/s1/${JOB:0:17}/s1_${JOB}_${SCAN}.json
    S=$(date +%s)
    sudo docker run --rm --gpus all --shm-size 16g --entrypoint python -v $T:/t:ro -v $JOBS:/jobs:ro -v $ROOT:/w $IMG /t/organ_floor.py variants --job-out /jobs/$JOB --scan $SCAN --out /w/s1/${JOB:0:17} 2>&1 | grep -E "FAILED|Error|Traceback" | head -5
    echo "   $JOB $SCAN: $(( $(date +%s) - S )) s, $(ls $ROOT/s1/${JOB:0:17}/$SCAN 2>/dev/null | tr '\n' ' ')"
  done
done
echo "== 3 S3 reconstruction pairs (24 segmentations)"
S=$(date +%s)
sudo docker run --rm --gpus all --shm-size 16g --entrypoint python -v $T:/t:ro -v /mnt/scratch/benchmarks/rider:/kd -v $ROOT:/w $IMG /t/organ_floor.py kernel --dir /kd --out /w/s3_kernel.json 2>&1 | grep -E "FAILED|Error|Traceback|pair segmented" | tail -16
echo "   S3: $(( $(date +%s) - S )) s"
echo "== 4 floors file"
sudo docker run --rm --entrypoint bash -v $T:/t:ro -v $ROOT:/w $IMG -c "python /t/organ_floor.py combine --s1 /w/s1/*/s1_*.json --s2 /w/s2_repeats.json --s3 /w/s3_kernel.json --out /w/floors.json" 2>&1 | tail -3
echo "== 5 both packages rebuilt with the floors"
for JOB in $CH $AB; do
  sudo rm -rf $ROOT/pkg/$JOB
  S=$(date +%s)
  sudo docker run --rm --cpus 8 --entrypoint python -v $T:/t:ro -v $JOBS:/jobs:ro -v $ROOT:/w $IMG /t/organ_package.py build --job-out /jobs/$JOB --out /w/pkg/$JOB --organs default --floors /w/floors.json 2>&1 | grep -v '^\[organ_package\] [a-z_]*:' | tail -8
  echo "   $JOB: exit ${PIPESTATUS[0]}, $(( $(date +%s) - S )) s"
done
echo "== 6 real-data checks"
sudo docker run --rm --entrypoint bash -v $T:/t:ro -v $ROOT:/w $IMG -c "python /t/organ_floor_real_checks.py --s1 /w/s1/*/s1_*.json --s2 /w/s2_repeats.json --s3 /w/s3_kernel.json --floors /w/floors.json --pkg-abdomen /w/pkg/$AB --pkg-chest /w/pkg/$CH --out /w/reports/floor_real_report.json" 2>&1 | tail -30
sudo chmod -R a+r $ROOT/reports $ROOT/floors.json $ROOT/s2_repeats.json $ROOT/s3_kernel.json $ROOT/s1 2>/dev/null
echo "== ALL_DONE $(date -u +%H:%M:%SZ)"
