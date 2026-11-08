# Local voice transcription

Prepared for Ryzen 5 7430U / 16 GB RAM. No GPU/CUDA dependency: faster-whisper uses CPU int8, two inference threads, one model worker, one queued job at a time. The parent backend enforces a 32-job persisted queue and a ten-minute worker timeout. Model loading happens per job to release RAM afterwards; benchmark on the actual Mini-PC before adjusting this tradeoff.

Audio and transcript metadata live under the existing persistent uploads volume; include `.voice-messages` in backups. Run one backend replica against this directory. Metadata JSON uses atomic replacement; `queue.json` recovers interrupted jobs at restart. Backpressure marks excess jobs failed while retaining playable audio. Transient worker failures retry once after 30 seconds. Drafts attached during a crash recover when their metadata is next requested. This is a local subprocess in the backend container, with no public worker port.

The normal backend works without a worker configured: recordings still send/play and transcription eventually reports unavailable. To enable on the Mini-PC during a later authorized release:

1. Build the ordinary backend image using the project's existing release procedure.
2. Prepare an existing local CTranslate2 **small multilingual** Whisper model directory (for Russian and English). Set `VOICE_MODEL_DIRECTORY` to its absolute host path, readable by container user `node`. Provision/download model files separately; the running worker uses `local_files_only=True` and offline environment flags and will never fetch models or send audio externally.
3. Review `voice-worker/requirements.txt` and `voice-worker/Dockerfile`. The optional image installs Python dependencies, not model weights.
4. Validate then build/start the optional image with `docker compose -f docker-compose.yml -f docker-compose.voice.yml ...` using normal release authorization. This recipe was **not built or started** during implementation.
5. Test a short Russian/English recording, restart during a queued job, revoke channel access, delete the message, test a 300-second recording and measure inference latency/CPU/RAM alongside LiveKit. Do not infer real-time performance from the CPU specification alone.

For a non-container backend set `VOICE_TRANSCRIBE_PYTHON`, `VOICE_TRANSCRIBE_SCRIPT` and `VOICE_TRANSCRIBE_MODEL` to absolute local paths in its environment. Stop/restart the backend after enabling. No shell command or model path comes from a browser request.

The Python worker validates magic containers again through PyAV's decoder, rejects files over 20 MiB, video/multiple audio streams, empty audio and over 300 seconds of actual decoded samples before loading inference. Recorded MIME/duration are never treated as proof. The subprocess has a bounded output and timeout; for deployments accepting untrusted public users, apply the container's existing process/filesystem/network hardening as part of release operations.

References: [faster-whisper usage and CPU int8](https://github.com/SYSTRAN/faster-whisper), [PyAV audio frames/resampling](https://pyav.org/docs/stable/api/audio.html).
