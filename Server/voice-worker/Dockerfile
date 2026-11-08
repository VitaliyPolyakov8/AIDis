# Build the ordinary backend image first, then opt in through docker-compose.voice.yml.
ARG BACKEND_IMAGE=aidis-backend:latest
FROM ${BACKEND_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && python3 -m venv /opt/voice-venv && rm -rf /var/lib/apt/lists/*
COPY voice-worker/requirements.txt /opt/voice-worker/requirements.txt
RUN /opt/voice-venv/bin/pip install --no-cache-dir -r /opt/voice-worker/requirements.txt
COPY voice-worker/worker.py /opt/voice-worker/worker.py
ENV VOICE_TRANSCRIBE_PYTHON=/opt/voice-venv/bin/python \
    VOICE_TRANSCRIBE_SCRIPT=/opt/voice-worker/worker.py \
    VOICE_TRANSCRIBE_MODEL=/opt/voice-model \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    OMP_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=1
USER node
