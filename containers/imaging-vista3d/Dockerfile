FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg ca-certificates \
 && echo "deb https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && sed -i 's#deb #deb [signed-by=/usr/share/keyrings/cloud.google.gpg] #' /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
 && rm -rf /var/lib/apt/lists/*
RUN pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124 \
 && (pip uninstall -y torchaudio || true)
RUN pip install "numpy<2" "torch==2.5.1" "torchvision==0.20.1" "monai>=1.4" nibabel SimpleITK \
    fire huggingface_hub einops "transformers==4.44.2" scipy pydicom scikit-image
WORKDIR /app
COPY vista3d_runner.py /app/runner.py
COPY vista3d_runner.py /app/vista3d_runner.py
COPY imaging_lesion_track_runner.py /app/lesion_track.py
ENTRYPOINT ["python","/app/runner.py"]
