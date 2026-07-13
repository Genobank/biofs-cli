# Build FROM the working VISTA-3D image (detector env already correct) and add the
# LesionLocator tracker. Far faster than rebuilding the MONAI/torch stack, and inherits
# the verified VISTA-3D auto-detection environment the findings runner imports.
FROM imaging-vista3d:latest
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends git unzip && rm -rf /var/lib/apt/lists/* || true
# LesionLocator (nnU-Net-based tracker). Non-fatal: a dependency clash never breaks the
# build; the runner falls back to overlap correspondence and reports tracker="overlap_fallback".
RUN git clone --depth 1 https://github.com/MIC-DKFZ/LesionLocator /opt/LesionLocator \
 && (pip install -e /opt/LesionLocator || echo "WARN LesionLocator install failed; runner will fall back")
# Guarantee the VISTA-3D-critical deps survive LesionLocator's install (last pip wins),
# cu124 torch for the A100.
RUN pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124 \
 && pip install "transformers==4.44.2" "numpy<2" gdown
COPY vista3d_runner.py /app/vista3d_runner.py
COPY findings_runner.py /app/findings_runner.py
ENTRYPOINT ["python","/app/findings_runner.py"]
