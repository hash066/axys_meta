"""Muse gateway: the only process that holds MODEL_API_KEY and talks to Meta's Model API.

The Axys Node server calls these endpoints (see docs/META_CONTRACT.md). Failures are honest:
503 without a key, 502 when Meta's API fails, never fabricated output.
"""
from __future__ import annotations

import asyncio
import base64
import os
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent


def _load_env() -> None:
    for env in (HERE.parent / ".env", HERE.parent.parent / ".env"):
        if not env.exists():
            continue
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env()

from . import meta_client as mc  # noqa: E402

app = FastAPI(title="Muse gateway")
MAX_UPLOAD = 12 * 1024 * 1024
MAX_PCM = 16_000 * 2 * 60

FIDELITY_PROMPT = """Image 1 is the real product photo. Image 2 is an AI-generated marketing shot.
Is the product in image 2 faithful to image 1 (shape, colour, proportions, printed text/labels)?
Return ONLY JSON: {"faithful": true|false, "differences": ["short list of visible differences, empty if none"]}"""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _err(message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.get("/v1/health")
def health():
    return {
        "key_configured": bool(os.environ.get("MODEL_API_KEY")),
        "models": {
            "spark": mc.SPARK_MODEL,
            "wonder": mc.WONDER_MODEL,
            "image": mc.IMAGE_MODEL,
            "sam": mc.SAM_MODEL,
            "voice": mc.VOICE_MODEL,
        },
    }


@app.post("/v1/transcribe")
async def transcribe(request: Request):
    pcm = await request.body()
    if not pcm or len(pcm) > MAX_PCM or len(pcm) % 2:
        return _err("Send 1-60 seconds of 16 kHz mono PCM16 audio.", 400)
    try:
        return {"transcript": await mc.transcribe_pcm16(pcm)}
    except mc.MissingKey as exc:
        return _err(str(exc), 503)
    except Exception as exc:  # noqa: BLE001
        return _err(f"Muse Voice: {exc}", 502)


async def _read_image(image: UploadFile):
    raw = await image.read()
    if not raw or len(raw) > MAX_UPLOAD:
        raise ValueError("Upload one image under 12 MB.")
    return mc.prepare_image(raw)


@app.post("/v1/segment")
async def segment(image: UploadFile = File(...), concept: str = Form(...)):
    try:
        png, size = await _read_image(image)
    except ValueError as exc:
        return _err(str(exc), 400)
    concept = concept.strip()[:80]
    if not concept:
        return _err("concept is required.", 400)
    try:
        client = mc.make_client()
        mask = await asyncio.to_thread(mc.sam_mask, client, png, size, concept)
        if mask is None:
            return {"found": False, "concept": concept, "coverage": 0.0, "bbox": None, "size": list(size),
                    "overlay_png_b64": None, "cutout_png_b64": None}
        overlay, cutout, stats = mc.render_mask_views(png, mask)
        return {"found": True, "concept": concept, "coverage": stats["coverage"], "bbox": stats["bbox"],
                "size": list(size), "overlay_png_b64": _b64(overlay), "cutout_png_b64": _b64(cutout)}
    except mc.MissingKey as exc:
        return _err(str(exc), 503)
    except Exception as exc:  # noqa: BLE001
        return _err(f"SAM 3.1: {exc}", 502)


@app.post("/v1/scene")
async def scene(image: UploadFile = File(...), scene: str = Form(...)):
    try:
        png, _ = await _read_image(image)
    except ValueError as exc:
        return _err(str(exc), 400)
    scene = scene.strip()[:300]
    if not scene:
        return _err("scene is required.", 400)
    try:
        client = mc.make_client()
        out = await asyncio.to_thread(mc.generate_scene, client, png, scene)
    except mc.MissingKey as exc:
        return _err(str(exc), 503)
    except Exception as exc:  # noqa: BLE001
        return _err(f"Muse Image: {exc}", 502)
    fidelity = {"faithful": None, "differences": []}
    try:
        judged = await asyncio.to_thread(mc.spark_json, client, FIDELITY_PROMPT, [png, out])
        fidelity = {
            "faithful": bool(judged.get("faithful")),
            "differences": [str(d)[:160] for d in judged.get("differences", [])][:6],
        }
    except Exception:  # noqa: BLE001  advisory check: report unknown, never success
        pass
    return {"image_png_b64": _b64(out), "fidelity": fidelity}


class JsonCall(BaseModel):
    model: str = Field(pattern="^(wonder|spark)$")
    prompt: str = Field(min_length=1, max_length=60000)
    images_b64: list[str] = Field(default_factory=list, max_length=4)
    effort: str = "low"


@app.post("/v1/json")
async def json_call(body: JsonCall):
    try:
        images = [base64.b64decode(b, validate=True) for b in body.images_b64]
    except Exception:  # noqa: BLE001
        return _err("images_b64 must be valid base64.", 400)
    try:
        client = mc.make_client()
        data, model = await asyncio.to_thread(mc.reasoning_json, client, body.model, body.prompt, images, body.effort)
    except mc.MissingKey as exc:
        return _err(str(exc), 503)
    except ValueError as exc:
        return _err(str(exc), 400)
    except Exception as exc:  # noqa: BLE001
        return _err(f"{body.model}: {exc}", 502)
    return {"json": data, "model": model}


class PlateCall(BaseModel):
    backdrop: str = Field(min_length=3, max_length=300)


@app.post("/v1/plate")
async def plate(body: PlateCall):
    try:
        client = mc.make_client()
        out = await asyncio.to_thread(mc.generate_plate, client, body.backdrop.strip())
    except mc.MissingKey as exc:
        return _err(str(exc), 503)
    except Exception as exc:  # noqa: BLE001
        return _err(f"Muse Image: {exc}", 502)
    return {"image_png_b64": _b64(out)}


@app.post("/v1/segment_multi")
async def segment_multi(image: UploadFile = File(...), concepts: str = Form(...)):
    """Union of several concepts (e.g. the product plus its visible parts) as one cutout."""
    import json as _json

    try:
        png, size = await _read_image(image)
    except ValueError as exc:
        return _err(str(exc), 400)
    try:
        items = [str(c).strip()[:80] for c in _json.loads(concepts)][:4]
    except Exception:  # noqa: BLE001
        return _err("concepts must be a JSON list of up to 4 short phrases.", 400)
    items = [c for c in items if c]
    if not items:
        return _err("concepts must not be empty.", 400)
    try:
        client = mc.make_client()

        async def one(concept):
            try:
                return await asyncio.to_thread(mc.sam_mask, client, png, size, concept)
            except mc.MissingKey:
                raise
            except Exception:  # noqa: BLE001  a missing part must not sink the whole cutout
                return None

        masks = await asyncio.gather(*[one(c) for c in items])
        merged = mc.union_masks(masks, size)
        if merged is None:
            return {"found": False, "concept": " + ".join(items), "coverage": 0.0, "bbox": None, "size": list(size),
                    "overlay_png_b64": None, "cutout_png_b64": None}
        overlay, cutout, stats = mc.render_mask_views(png, merged)
        return {"found": True, "concept": " + ".join(items), "coverage": stats["coverage"], "bbox": stats["bbox"],
                "size": list(size), "overlay_png_b64": _b64(overlay), "cutout_png_b64": _b64(cutout)}
    except mc.MissingKey as exc:
        return _err(str(exc), 503)
    except Exception as exc:  # noqa: BLE001
        return _err(f"SAM 3.1: {exc}", 502)


from . import speech as sp  # noqa: E402


class SpeakCall(BaseModel):
    text: str = Field(min_length=1, max_length=400)
    voice: str = Field(default="narrator", min_length=2, max_length=40)
    model: str | None = Field(default=None, pattern="^eleven_[a-z0-9_]+$")


@app.get("/v1/speak/budget")
async def speak_budget():
    try:
        return await asyncio.to_thread(sp.budget)
    except sp.SpeechError as exc:
        return _err(str(exc), exc.status)


@app.post("/v1/speak")
async def speak(body: SpeakCall):
    """Spoken audio via ElevenLabs (Meta's Model API has no speech synthesis). Cached by (voice, model, text)."""
    try:
        r = await asyncio.to_thread(sp.speak, body.text, body.voice, body.model)
    except sp.SpeechError as exc:
        return _err(str(exc), exc.status)
    return {
        "audio_mp3_b64": _b64(r["audio"]),
        "cached": r["cached"],
        "credits_charged": r["credits_charged"],
        "voice_id": r["voice_id"],
        "model": r["model"],
    }
