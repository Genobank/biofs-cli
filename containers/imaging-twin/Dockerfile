# GenoBank imaging-twin executor container — the reproducible runtime the GPU
# executor runs for an `imaging-twin` biofs job. CUDA + torch base; the imaging
# stack baked in; GCS access via the VM service account's ADC (metadata server),
# so NO gcloud binary and NO keys inside the image.
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1

# google-cloud-cli so the runner's `gcloud storage` calls work unchanged inside
# the container (auth via the VM service account's metadata-server ADC; no keys).
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg ca-certificates build-essential \
 && echo "deb https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && sed -i 's# main# main#; s#deb #deb [signed-by=/usr/share/keyrings/cloud.google.gpg] #' /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
 && rm -rf /var/lib/apt/lists/*

RUN pip install "numpy<2" \
    SimpleITK nibabel pydicom scikit-image trimesh fast-simplification psutil \
    TotalSegmentator antspyx \
    pymongo

# pyradiomics (best-effort, NON-FATAL): powers the manifest delta_radiomics shape/texture
# deltas. Needs numpy<2 (pinned above) + a C toolchain (build-essential above). If it fails
# to build on this Python, the runner's radiomics_delta() already degrades to {} gracefully,
# so we must NEVER fail the image build over it.
RUN pip install "numpy<2" pyradiomics || echo "WARN: pyradiomics unavailable; delta_radiomics will be empty"

# TotalSegmentator/nnU-Net may upgrade torch to a CUDA-13 build, which a CUDA-12.x
# host driver can't run (silent CPU fallback). Pin torch to the cu124 build, purge
# any cu13 nvidia leftovers that would shadow the cu12 libs (the cudnn-cu13 -> cudnn-cu12
# shadowing causes CUDNN_STATUS_NOT_INITIALIZED), and restore nccl-cu12.
RUN pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124 \
 && (pip uninstall -y $(pip list 2>/dev/null | grep -iE 'cu13' | awk '{print $1}') || true) \
 && pip install --force-reinstall --no-cache-dir nvidia-nccl-cu12==2.21.5

# Pre-fetch TotalSegmentator weights into the image so jobs don't download at runtime.
ENV TOTALSEG_HOME_DIR=/opt/totalseg_weights
RUN python -c "from totalsegmentator.python_api import totalsegmentator" \
 && (totalsegmentator --download_weights 2>/dev/null || true)

COPY imaging_twin_runner.py /app/runner.py
COPY imaging_attribute_runner.py /app/attribute.py
WORKDIR /app
ENTRYPOINT ["python", "/app/runner.py"]
