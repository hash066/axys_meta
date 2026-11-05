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


def test_plate_requires_key_and_valid_input(monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    assert client.post("/v1/plate", json={"backdrop": "x"}).status_code == 422
    r = client.post("/v1/plate", json={"backdrop": "a rustic kitchen shelf"})
    assert r.status_code == 503 and "MODEL_API_KEY" in r.json()["error"]


def test_union_masks_fills_gaps_and_holes():
    import numpy as np

    from gateway import meta_client as mc

    a = np.zeros((120, 120), dtype=np.uint8)
    a[30:90, 20:100] = 1            # main body
    a[50:60, 40:50] = 0             # interior hole
    b = np.zeros((120, 120), dtype=np.uint8)
    b[12:30, 40:70] = 1             # a topping touching the body
    merged = mc.union_masks([a, b, None], (120, 120))
    assert merged[55, 45] == 1, "interior hole is filled"
    assert merged[20, 55] == 1, "second concept is included"
    assert merged[5, 5] == 0, "background stays empty"
    assert mc.union_masks([None, None], (120, 120)) is None


def test_segment_multi_validates_input(monkeypatch):
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    files = {"image": ("a.png", _png(), "image/png")}
    assert client.post("/v1/segment_multi", files=files, data={"concepts": "not json"}).status_code == 400
    assert client.post("/v1/segment_multi", files=files, data={"concepts": "[]"}).status_code == 400
    r = client.post("/v1/segment_multi", files=files, data={"concepts": '["cake", "raspberries"]'})
    assert r.status_code == 503


def test_speak_validates_and_reports_missing_key(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert client.post("/v1/speak", json={"text": ""}).status_code == 422
    assert client.post("/v1/speak", json={"text": "x" * 401}).status_code == 422
    assert client.post("/v1/speak", json={"text": "hi there", "model": "not-a-model"}).status_code == 422
    r = client.post("/v1/speak", json={"text": "Hello there."})
    assert r.status_code == 503 and "ELEVENLABS_API_KEY" in r.json()["error"]
    assert client.get("/v1/speak/budget").status_code == 503


def test_speak_uses_cache_without_a_key(monkeypatch, tmp_path):
    from gateway import speech

    monkeypatch.setattr(speech, "CACHE", tmp_path)
    monkeypatch.setattr(speech, "voice_id", lambda name: "V" * 20)
    import hashlib

    digest = hashlib.sha256(f"{'V' * 20}|{speech.DEFAULT_MODEL}|Cached line.".encode()).hexdigest()[:32]
    (tmp_path / f"{digest}.mp3").write_bytes(b"ID3fake")
    r = client.post("/v1/speak", json={"text": "Cached   line."})
    assert r.status_code == 200 and r.json()["cached"] is True and r.json()["credits_charged"] == 0


def test_token_required_when_configured(monkeypatch):
    from fastapi.testclient import TestClient
    from gateway.server import app

    monkeypatch.setenv("GATEWAY_TOKEN", "s3cret")
    client = TestClient(app)
    assert client.get("/v1/health").status_code == 401
    assert client.get("/v1/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/v1/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_open_without_token(monkeypatch):
    from fastapi.testclient import TestClient
    from gateway.server import app

    monkeypatch.delenv("GATEWAY_TOKEN", raising=False)
    assert TestClient(app).get("/v1/health").status_code == 200
