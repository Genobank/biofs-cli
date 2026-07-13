# Tier-2 method: PASTA pan-tumor embedding-change. Reuses the CT-FM base (its working cu124
# torch + characterize_common's SimpleITK / scipy / gcloud deps), and adds only the official
# PASTA repo (for the authentic Generic_UNet_classify architecture, so the checkpoint loads).
# The checkpoint PASTA_final.pth is mounted from /scratch at runtime, never baked into the image.
FROM imaging-ctfm:latest
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/LWHYC/PASTA /opt/PASTA
WORKDIR /app
COPY characterize_common.py /app/characterize_common.py
COPY pasta_runner.py /app/pasta_runner.py
ENV PASTA_DIR=/opt/PASTA PASTA_CKPT=/scratch/pasta/PASTA_final.pth
ENTRYPOINT ["python","/app/pasta_runner.py"]
