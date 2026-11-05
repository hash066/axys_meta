# Running the Muse gateway on Modal

The gateway (`gateway/server.py`) is the only part of Axys that holds the Meta key. `gateway/modal_app.py` runs it as a Modal web endpoint.

1. `pip install modal` then `modal setup`.
2. `modal secret create axys-gateway MODEL_API_KEY=... GATEWAY_TOKEN=<long random string>` (add `ELEVENLABS_API_KEY=...` for voice).
3. `modal deploy gateway/modal_app.py` prints the endpoint URL.
4. On the Axys service set `MUSE_GATEWAY_URL=<endpoint url>` and `MUSE_GATEWAY_TOKEN=<the same token>`.

With `GATEWAY_TOKEN` set the gateway rejects calls without `Authorization: Bearer <token>` (tests: `tests_py/test_gateway.py`). Without it nothing changes, so local and Docker setups are untouched.

Status: the auth path and the Python/TypeScript changes are tested locally. The Modal deployment itself has not been run (it needs a Modal account), so treat `modal_app.py` as untested until you deploy it.
