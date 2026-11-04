"""Offline gateway tests: validation and honest failure. No network."""
import io

from fastapi.testclient import TestClient
from PIL import Image

from gateway import server

client = TestClient(server.app)


def _png():
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), "red").save(buf, format="PNG")
    return buf.getvalue()


def test_health_lists_models():
    body = client.get("/v1/health").json()
    assert body["models"]["wonder"] == "muse-wonder-1.0" and "key_configured" in body


def test_transcribe_rejects_odd_or_empty_audio():
    assert client.post("/v1/transcribe", content=b"").status_code == 400
    assert client.post("/v1/transcribe", content=b"abc").status_code == 400


def test_no_key_is_503_not_fake(monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    r = client.post("/v1/segment", files={"image": ("a.png", _png(), "image/png")}, data={"concept": "shoe"})
    assert r.status_code == 503 and "MODEL_API_KEY" in r.json()["error"]
    r = client.post("/v1/json", json={"model": "wonder", "prompt": "hi"})
    assert r.status_code == 503


def test_bad_image_and_bad_model():
    r = client.post("/v1/segment", files={"image": ("a.png", b"nope", "image/png")}, data={"concept": "shoe"})
    assert r.status_code == 400
    assert client.post("/v1/json", json={"model": "gpt", "prompt": "x"}).status_code == 422


def test_wonder_rejects_images(monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "test")
    r = client.post("/v1/json", json={"model": "wonder", "prompt": "x", "images_b64": ["aGk="]})
    assert r.status_code == 400
