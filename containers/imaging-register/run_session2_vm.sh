#!/bin/bash
# GPU VM, session 2: tracker rerun of D2 and D3 with the per-lesion tracking fix, and the liver landmark proposal, version 2. Log: $ROOT/run2.log
set -u
W0=0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a
ABD=gs://genobank-health-imaging/$W0/imaging-register/register-e05d1252-b3a6-4fcf-9aec-1765c1f6392b
ROOT=/mnt/scratch/benchmarks/detector_20261105; T=/tmp/v27c
WALLET=0xKNOWNANSWERDETECTOR; BUCKET=genobank-health-imaging
REG=imaging-register:v27-20261105; FIND0=imaging-findings:v27-20261105; FIND=imaging-findings:v27b-20261105
exec > >(tee -a $ROOT/run2.log) 2>&1
fail() { echo "FAILED at: $1"; exit 1; }
echo "== start $(date -u +%H:%M:%SZ)"
echo "== 1 thin image with the per-lesion tracking"
mkdir -p $T/imfind && cp $T/findings_runner.py $T/imfind/ && printf 'FROM %s\nCOPY findings_runner.py /app/findings_runner.py\n' $FIND0 > $T/imfind/Dockerfile
(cd $T/imfind && sudo docker build -q -t $FIND . | tail -1) || fail build
IMG_SHA=$(sudo docker run --rm --entrypoint sha256sum $FIND /app/findings_runner.py | cut -c1-16); SRC_SHA=$(sha256sum $T/findings_runner.py | cut -c1-16)
echo "image file $IMG_SHA source $SRC_SHA"; [ "$IMG_SHA" = "$SRC_SHA" ] || fail hash
echo "== 2 rerun D2 and D3"
HFARG="-e HF_HOME=/scratch/hf"
for P in D2 D3; do
  D=$ROOT/fake_gcs/$BUCKET/$WALLET/imaging-findings
  [ -d $D/ka-detector-$P.run1 ] || mv $D/ka-detector-$P $D/ka-detector-$P.run1
  cp $ROOT/logs/$P.log $ROOT/logs/$P.run1.log 2>/dev/null
  echo "== pair $P $(date -u +%H:%M:%SZ)"
  TP=$(python3 -c "import json;print(json.dumps(json.load(open('$ROOT/fake_gcs/_truth/pairs.json'))['$P']['timepoints']))")
  sudo docker run --rm --gpus all --shm-size 16g --entrypoint bash -v $T:/t:ro -v $ROOT/fake_gcs:/fake -v /mnt/scratch:/scratch $HFARG \
    -e FAKE_GCS=/fake -e WALLET=$WALLET -e JOB_ID=ka-detector-$P -e TIMEPOINTS="$TP" -e TREATMENT_CONTEXT=naive \
    -e IMAGING_BUCKET=$BUCKET -e OUTPUT_BUCKET=$BUCKET $FIND \
    -c 'mkdir -p /shim && printf "#!/bin/sh\nexec python /t/fake_gcloud.py \"\$@\"\n" > /shim/gcloud && chmod +x /shim/gcloud && export PATH=/shim:$PATH && python /app/findings_runner.py' \
    > $ROOT/logs/$P.log 2>&1
  echo "   exit $? ; $(grep -c 'LesionLocator' $ROOT/logs/$P.log) LesionLocator log lines"
  tail -2 $ROOT/logs/$P.log | cut -c1-240
done
python3 - <<PY
import json,subprocess
def sh(c): return subprocess.run(c,shell=True,capture_output=True,text=True).stdout.strip()
env=json.load(open("$ROOT/out/env.json")); env.update({"run2_findings_image":"$FIND","run2_findings_image_id":sh("sudo docker images --format '{{.ID}}' $FIND"),"run2_file_sha256_16":"$IMG_SHA"})
json.dump(env,open("$ROOT/out/env_run2.json","w"),indent=1); print(env)
PY
sudo docker run --rm --entrypoint python -v $ROOT:/w -v $T:/t:ro $REG /t/known_answer_detector.py evaluate --root /w/fake_gcs --wallet $WALLET --bucket $BUCKET --env /w/out/env_run2.json --out /w/out/detector_report_run2.json 2>&1 | tail -8
mkdir -p $ROOT/out/findings_run2; for P in D2 D3; do cp $ROOT/fake_gcs/$BUCKET/$WALLET/imaging-findings/ka-detector-$P/findings.json $ROOT/out/findings_run2/$P.json; done
cp $ROOT/fake_gcs/_gcloud_calls.log $ROOT/out/_gcloud_calls_run2.log
echo "== 3 liver landmarks, proposal version 2"
LM=$ROOT/lm; JD=$LM/job
for L in jan9 oct21; do gcloud storage cp $ABD/native/$L/labels.nii.gz $JD/native/$L/ >/dev/null || fail lm_labels_$L; done
cp $T/landmark_criteria_register-e05d1252-liver-amended1.json $LM/
sudo rm -rf $LM/out2; mkdir -p $LM/out2
sudo docker run --rm --entrypoint python -v $LM:/w -v $T:/t:ro $REG /t/landmark_check.py propose --job-dir /w/job --criteria /w/landmark_criteria_register-e05d1252-liver-amended1.json --out-dir /w/out2 2>&1 | tail -4
[ -f $LM/out2/landmarks_proposed.json ] || fail lm_propose_output
sudo docker run --rm --entrypoint python -v $LM:/w -v $T:/t:ro $REG /t/landmark_check.py review-page --job-dir /w/job --proposed /w/out2/landmarks_proposed.json --out-dir /w/out2 2>&1 | tail -3
[ -f $LM/out2/review_page.html ] || fail lm_page_output
ls -la $LM/out2 | awk '{print $5,$9}'
echo "== ALL_DONE $(date -u +%H:%M:%SZ)"
