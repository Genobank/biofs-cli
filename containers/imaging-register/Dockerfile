# GenoBank imaging-register executor container: the runtime the GPU executor runs for a
# `biofs imaging register` job (staged CT registration with a quality gate). It reuses the
# imaging-twin image (CUDA + torch, SimpleITK, ANTsPy, TotalSegmentator with baked weights,
# gcloud with the VM service account's metadata-server ADC; no keys inside the image).
#   docker build -t imaging-twin:latest containers/imaging-twin
#   docker build -t imaging-register:latest containers/imaging-register
# Tests: python test_register.py (numpy + scipy only); inside the image,
#   docker run --rm --entrypoint python -v $PWD:/t:ro imaging-register:latest /t/smoke_ants_api.py
#   docker run --rm --entrypoint python -v $PWD:/t:ro imaging-register:latest /t/smoke_pair.py
FROM imaging-twin:latest
COPY register.py /app/register.py
ENTRYPOINT ["python", "/app/register.py"]
