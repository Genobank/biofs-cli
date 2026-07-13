# Tier-2 method: MedGemma zero-shot interpretive read. FROM the existing imaging-medgemma base
# (working gemma3 transformers + torch). Adds the characterize runner + SimpleITK/scipy/Pillow.
# Tagged imaging-medgemma:latest (the legacy twin-enrich entrypoint is retired).
FROM imaging-medgemma:latest
RUN pip install SimpleITK scipy Pillow nibabel 2>&1 | tail -1
COPY characterize_common.py /app/characterize_common.py
COPY medgemma_char_runner.py /app/medgemma_char_runner.py
ENTRYPOINT ["python","/app/medgemma_char_runner.py"]
