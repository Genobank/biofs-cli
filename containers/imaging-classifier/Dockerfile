# Tier-2 method 6: benign/malignant classifier head. FROM imaging-pasta (has CT-FM via lighter_zoo
# + PASTA + the checkpoint, and ctfm_runner.py / pasta_runner.py at /app) plus scikit-learn for the
# head. pylidc is intentionally NOT here (LIDC training-data prep runs in a separate CPU pylidc env);
# this image does GPU embedding extraction (extract_embeddings.py), CPU head training
# (train_classifier_head.py), and inference (classifier_runner.py, the default entrypoint).
FROM imaging-pasta:latest
RUN pip install --no-cache-dir "scikit-learn>=1.3" "pandas" "pyarrow" "joblib"
WORKDIR /app
COPY characterize_common.py /app/characterize_common.py
COPY extract_embeddings.py /app/extract_embeddings.py
COPY train_classifier_head.py /app/train_classifier_head.py
COPY classifier_runner.py /app/classifier_runner.py
ENV CLASSIFIER_HEAD_DIR=/scratch/characterize/classifier CLASSIFIER_ORGANS=lung
ENTRYPOINT ["python","/app/classifier_runner.py"]
