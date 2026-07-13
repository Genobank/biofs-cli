# Tier-2 method: Merlin embedding-change. FROM the existing imaging-merlin image (reuse the
# hard-won merlin-vlm + cu124 torch + transformers 4.44.2). Adds the characterize runner +
# scipy (characterize_common needs scipy.ndimage). Tagged imaging-merlin:latest (legacy
# twin-enrich entrypoint retired).
FROM imaging-merlin:latest
RUN pip install scipy 2>&1 | tail -1
COPY characterize_common.py /app/characterize_common.py
COPY merlin_char_runner.py /app/merlin_char_runner.py
ENTRYPOINT ["python","/app/merlin_char_runner.py"]
