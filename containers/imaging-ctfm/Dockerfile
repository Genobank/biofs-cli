# Tier-2 method: CT-FM learned embedding (project-lighter, apache-2.0). GPU.
# lighter-zoo 0.1.3 hard-deps on jupyter (pip backtrack hang) -> install with --no-deps.
# monai's install aggressively UPGRADES torch to cu130 (CUDA 13) which the A100's 12.8
# driver can't run -> RE-PIN torch cu124 as the FINAL layer so it wins.
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
 && echo "deb https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && sed -i 's#deb #deb [signed-by=/usr/share/keyrings/cloud.google.gpg] #' /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
 && rm -rf /var/lib/apt/lists/*
RUN pip install "huggingface-hub>=0.27.1" "monai[itk,nibabel,skimage]>=1.4.0" "safetensors>=0.5.2" \
    "numpy<2" SimpleITK scipy nibabel
RUN pip install "lighter-zoo==0.1.3" --no-deps
# FINAL re-pin: force cu124 torch (overrides the cu130 monai dragged in); the A100 driver is CUDA 12.8.
RUN pip install --force-reinstall torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124 \
 && (pip uninstall -y torchaudio || true)
WORKDIR /app
COPY characterize_common.py /app/characterize_common.py
COPY ctfm_runner.py /app/ctfm_runner.py
ENTRYPOINT ["python","/app/ctfm_runner.py"]
