# protein-impact plm: masked-marginal scores from a protein language model. CPU image; weights are fetched at the
# commit pinned in tools.lock.json, never from a floating tag. Build, push, then write the image digest into tools.lock.json.
FROM python:3.11-slim

RUN pip install --no-cache-dir torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir transformers==4.45.2 huggingface_hub==0.25.2 numpy==1.26.4

WORKDIR /app
COPY run.py /app/run.py
ENTRYPOINT ["python", "/app/run.py"]
