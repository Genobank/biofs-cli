# Tier-2 method 7: false-positive second-reader. FROM imaging-classifier (which already has CT-FM
# via lighter_zoo + PASTA + the checkpoint + scikit-learn + extract_embeddings.py + ctfm_runner.py /
# pasta_runner.py). Adds only the FP head trainer + inference runner. LUNA16 data prep runs in the
# separate CPU pylidc/SimpleITK venv. Default entrypoint = inference (fpreader_runner.py).
FROM imaging-classifier:latest
WORKDIR /app
COPY characterize_common.py /app/characterize_common.py
COPY train_fp_head.py /app/train_fp_head.py
COPY fpreader_runner.py /app/fpreader_runner.py
ENV FPREADER_HEAD_DIR=/scratch/characterize/fpreader FPREADER_ORGANS=lung
ENTRYPOINT ["python","/app/fpreader_runner.py"]
