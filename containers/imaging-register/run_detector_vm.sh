#!/bin/bash
# Runs on the GPU VM. Detector known-answer test (4 pairs through the real findings executor, storage on a local folder) and the liver
# landmark proposal for the abdomen job. Patient-derived files stay under /mnt/scratch. Log: $ROOT/run.log. Ends with ALL_DONE or FAILED.
set -u
# on the VM gcloud uses the VM's attached service account (instance metadata); the Mac account is not activated here
W0=0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
GB=gs://genobank-health-imaging/$W0/imaging-register
CHEST=$GB/register-ef1676c3-6231-435d-a219-e12e1702ff87
ABD=$GB/register-e05d1252-b3a6-4fcf-9aec-1765c1f6392b
ROOT=/mnt/scratch/benchmarks/detector_20261105; T=/tmp/v27b
WALLET=0xKNOWNANSWERDETECTOR; BUCKET=genobank-health-imaging
REG=imaging-register:v27-20261105; FIND=imaging-findings:v27-20261105
sudo mkdir -p $ROOT && sudo chown "$(id -u):$(id -g)" $ROOT
mkdir -p $ROOT/src/native/jun17 $ROOT/fake_gcs $ROOT/logs $ROOT/out $ROOT/lm/job/frame $ROOT/lm/out
exec > >(tee -a $ROOT/run.log) 2>&1
fail() { echo "FAILED at: $1"; exit 1; }
echo "== start $(date -u +%H:%M:%SZ)"
echo "== image ids"; sudo docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -E "v27-20261105"
echo "== 1 pull the source CT of the chest job (server side)"
gcloud storage cp $CHEST/manifest.json $ROOT/src/ >/dev/null || fail pull_manifest
gcloud storage cp $CHEST/native/jun17/ct.nii.gz $CHEST/native/jun17/labels.nii.gz $ROOT/src/native/jun17/ >/dev/null || fail pull_ct
echo "== 2 build the 7 DICOM series"
sudo docker run --rm --entrypoint python -v $ROOT:/w -v $T:/t:ro $REG /t/known_answer_detector.py build --src-dir /w/src --root /w/fake_gcs --wallet $WALLET --bucket $BUCKET 2>&1 | tail -12 || fail build
[ -f $ROOT/fake_gcs/_truth/pairs.json ] || fail build_output
HFARG=""; [ -d /mnt/scratch/hf ] && HFARG="-e HF_HOME=/scratch/hf"
echo "== LesionLocator checkpoint: $([ -d /mnt/scratch/LesionLocatorCheckpoint ] && echo present || echo absent)  HF cache: $([ -d /mnt/scratch/hf ] && echo present || echo absent)"
for P in D0 D1 D2 D3; do
  echo "== 3 pair $P $(date -u +%H:%M:%SZ)"
  TP=$(python3 -c "import json;print(json.dumps(json.load(open('$ROOT/fake_gcs/_truth/pairs.json'))['$P']['timepoints']))")
  sudo docker run --rm --gpus all --shm-size 16g --entrypoint bash -v $T:/t:ro -v $ROOT/fake_gcs:/fake -v /mnt/scratch:/scratch $HFARG \
    -e FAKE_GCS=/fake -e WALLET=$WALLET -e JOB_ID=ka-detector-$P -e TIMEPOINTS="$TP" -e TREATMENT_CONTEXT=naive \
    -e IMAGING_BUCKET=$BUCKET -e OUTPUT_BUCKET=$BUCKET $FIND \
    -c 'mkdir -p /shim && printf "#!/bin/sh\nexec python /t/fake_gcloud.py \"\$@\"\n" > /shim/gcloud && chmod +x /shim/gcloud && export PATH=/shim:$PATH && python /app/findings_runner.py' \
    > $ROOT/logs/$P.log 2>&1
  echo "   exit $? ; $(grep -c FINDINGS_RESULT $ROOT/logs/$P.log) result line(s); $(grep -o 'tracker.\{0,60\}' $ROOT/logs/$P.log | head -1)"
  tail -3 $ROOT/logs/$P.log | cut -c1-240
done
echo "== 4 environment record"
python3 - <<PY
import json,subprocess
def sh(c): return subprocess.run(c,shell=True,capture_output=True,text=True).stdout.strip()
env={"findings_image":"$FIND","findings_image_id":sh("sudo docker images --format '{{.ID}}' $FIND"),"register_image":"$REG","gpu":sh("nvidia-smi --query-gpu=name,driver_version --format=csv,noheader"),
     "lesionlocator_checkpoint":"present" if sh("[ -d /mnt/scratch/LesionLocatorCheckpoint ] && echo y")=="y" else "absent",
     "hf_vista3d_snapshot":sh("ls /mnt/scratch/hf/hub 2>/dev/null | grep -i vista | head -3"),"gcloud_calls":sum(1 for _ in open("$ROOT/fake_gcs/_gcloud_calls.log")) if True else 0}
json.dump(env,open("$ROOT/out/env.json","w"),indent=1); print(env)
PY
echo "== 5 evaluate"
sudo docker run --rm --entrypoint python -v $ROOT:/w -v $T:/t:ro $REG /t/known_answer_detector.py evaluate --root /w/fake_gcs --wallet $WALLET --bucket $BUCKET --env /w/out/env.json --out /w/out/detector_report.json 2>&1 | tail -12 || fail evaluate
mkdir -p $ROOT/out/findings; for P in D0 D1 D2 D3; do cp $ROOT/fake_gcs/$BUCKET/$WALLET/imaging-findings/ka-detector-$P/findings.json $ROOT/out/findings/$P.json 2>/dev/null; done
cp $ROOT/fake_gcs/_gcloud_calls.log $ROOT/fake_gcs/_truth/truth.json $ROOT/out/ 2>/dev/null
echo "== 6 liver landmarks: proposal and review page for the abdomen job"
LM=$ROOT/lm; JD=$LM/job
gcloud storage cp $ABD/manifest.json $JD/ >/dev/null || fail lm_manifest
gcloud storage cp $ABD/frame/mar3_ct.nii.gz $ABD/frame/mar3_labels.nii.gz $JD/frame/ >/dev/null || fail lm_frame
for L in jan9 oct21; do mkdir -p $JD/native/$L $JD/pairs/${L}_to_mar3; gcloud storage cp $ABD/native/$L/ct.nii.gz $JD/native/$L/ >/dev/null || fail lm_native_$L; gcloud storage cp $ABD/pairs/${L}_to_mar3/rigid.mat $JD/pairs/${L}_to_mar3/ >/dev/null || fail lm_rigid_$L; done
cp $T/landmark_criteria_register-e05d1252-liver.json $LM/
sudo docker run --rm --entrypoint python -v $LM:/w -v $T:/t:ro $REG /t/landmark_check.py propose --job-dir /w/job --criteria /w/landmark_criteria_register-e05d1252-liver.json --out-dir /w/out 2>&1 | tail -4 || fail lm_propose
sudo docker run --rm --entrypoint python -v $LM:/w -v $T:/t:ro $REG /t/landmark_check.py review-page --job-dir /w/job --proposed /w/out/landmarks_proposed.json --out-dir /w/out 2>&1 | tail -3 || fail lm_page
[ -f $LM/out/landmarks_proposed.json ] || fail lm_propose_output
[ -f $LM/out/review_page.html ] || fail lm_page_output
ls -la $LM/out | awk '{print $5,$9}'
echo "== ALL_DONE $(date -u +%H:%M:%SZ)"
