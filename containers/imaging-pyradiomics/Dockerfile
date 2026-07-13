# Tier-2 method: PyRadiomics (IBSI radiomics + delta-radiomics). CPU only, lightweight.
# pyradiomics 3.0.1 has no cp39 wheel, so it builds from source: install numpy+Cython first,
# then build with --no-build-isolation against them (build-essential provides gcc).
FROM python:3.9-slim
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends curl gnupg ca-certificates build-essential \
 && echo "deb https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && sed -i 's#deb #deb [signed-by=/usr/share/keyrings/cloud.google.gpg] #' /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
 && rm -rf /var/lib/apt/lists/*
RUN pip install "numpy==1.23.5" "Cython==0.29.36" setuptools wheel
RUN pip install "SimpleITK==2.3.1" "scipy==1.10.1" "PyWavelets==1.4.1" pykwalify six
RUN pip install "pyradiomics==3.0.1" --no-build-isolation
WORKDIR /app
COPY characterize_common.py /app/characterize_common.py
COPY pyradiomics_runner.py /app/pyradiomics_runner.py
ENTRYPOINT ["python","/app/pyradiomics_runner.py"]
