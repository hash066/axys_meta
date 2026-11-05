"""Runs the Muse gateway on Modal (https://modal.com) instead of inside the Axys container.

    pip install modal && modal setup
    modal secret create axys-gateway MODEL_API_KEY=... GATEWAY_TOKEN=<long random string> [ELEVENLABS_API_KEY=...]
    modal deploy gateway/modal_app.py

Modal prints the endpoint URL. Point Axys at it:  MUSE_GATEWAY_URL=<that url>  MUSE_GATEWAY_TOKEN=<the same token>.
The Meta key then lives only in Modal's secret store, and the web app no longer needs Python, SAM or the key at all.
Containers scale to zero when idle; the first call after a pause pays a cold start of a few seconds.
"""
from __future__ import annotations

import modal

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install_from_requirements("gateway/requirements.txt")
    .env({"SPEECH_CACHE_DIR": "/cache"})
    .add_local_python_source("gateway")
)
app = modal.App("axys-muse-gateway", image=image)
SPEECH_CACHE = modal.Volume.from_name("axys-speech-cache", create_if_missing=True)


@app.function(
    secrets=[modal.Secret.from_name("axys-gateway")],
    volumes={"/cache": SPEECH_CACHE},
    scaledown_window=300,
    timeout=600,
)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def gateway():
    from gateway.server import app as fastapi_app

    return fastapi_app
