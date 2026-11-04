"""Thin wrappers over the Meta Model API (copied from the Telltale prototype built Nov 2-3) (https://api.meta.ai/v1).

Endpoint shapes follow Meta's public meta-model-cookbook:
  Muse Spark  -> Responses API, model muse-spark-1.3
  SAM 3.1     -> Responses API, model sam-3.1, one-bit masks parsed by meta_sam_parser
  Muse Image  -> Responses API with the image_generation tool, model muse-image-1.0
  Muse Voice  -> wss://api.meta.ai/v1/asr/realtime, model muse-voice-transcribe-1.0
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import math
import os
import re

BASE_URL = os.environ.get("MODEL_BASE_URL", "https://api.meta.ai/v1")
SPARK_MODEL = os.environ.get("SPARK_MODEL", "muse-spark-1.3")
SAM_MODEL = "sam-3.1"
IMAGE_MODEL = "muse-image-1.0"
VOICE_MODEL = "muse-voice-transcribe-1.0"
VOICE_URL = "wss://api.meta.ai/v1/asr/realtime"

MAX_EDGE = 1280


class MissingKey(RuntimeError):
    pass


def make_client(timeout: float = 120.0):
    from openai import OpenAI

    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise MissingKey("MODEL_API_KEY is not set. Add it to .env (see .env.example).")
    return OpenAI(base_url=BASE_URL, api_key=key, timeout=timeout, max_retries=1)


# ---------- image helpers ----------

def prepare_image(raw: bytes) -> tuple[bytes, tuple[int, int]]:
    """Validate, downscale and re-encode as PNG so every model sees the same pixels."""
    from PIL import Image, ImageOps

    try:
        with Image.open(io.BytesIO(raw)) as src:
            img = ImageOps.exif_transpose(src).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise ValueError("That file is not a readable image.") from exc
    img.thumbnail((MAX_EDGE, MAX_EDGE))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue(), img.size


def data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _field(value, name):
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


# ---------- Muse Spark ----------

def parse_json_loose(text: str) -> dict:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("Muse Spark did not return JSON.")
    return json.loads(text[start : end + 1])


def spark_json(client, prompt: str, images: list[bytes]) -> dict:
    content = [{"type": "input_text", "text": prompt}]
    for png in images:
        content.append({"type": "input_image", "image_url": data_url(png)})
    resp = client.responses.create(
        model=SPARK_MODEL,
        input=[{"role": "user", "content": content}],
        store=False,
    )
    text = _field(resp, "output_text")
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("Muse Spark returned no text.")
    return parse_json_loose(text)


# ---------- SAM 3.1 ----------

def sam_mask(client, png: bytes, size: tuple[int, int], concept: str):
    """Return a numpy uint8 (H, W) mask of `concept`, or None when nothing is found."""
    import numpy as np
    from meta_sam_parser import (
        CompletedOutcome,
        SegmentationMaskRecord,
        decode_mask_to_raster,
        image_segmentation_format,
    )
    from PIL import Image

    concept = re.sub(r"[^A-Za-z0-9 _-]", " ", concept).strip()[:80] or "product"
    width, height = size
    resp = client.responses.create(
        model=SAM_MODEL,
        input=[
            {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": concept},
                    {"type": "input_image", "image_url": data_url(png)},
                ],
            }
        ],
        metadata={"mask_encoding": "one_bit"},
        store=False,
    )
    status = _field(resp, "status")
    if status not in {None, "completed"}:
        raise RuntimeError(f"SAM did not complete: {status}")
    output_text = _field(resp, "output_text")
    if not isinstance(output_text, str) or not output_text:
        return None

    parser = image_segmentation_format().create_parser()
    parser.push(output_text)
    result = parser.finish(CompletedOutcome()).result

    combined = np.zeros((height, width), dtype=np.uint8)
    for record in result.records:
        if not isinstance(record, SegmentationMaskRecord):
            continue
        raster = decode_mask_to_raster(record.mask)
        mw, mh = record.mask.width, record.mask.height
        if len(raster) != mw * mh:
            raise RuntimeError("SAM returned an invalid mask raster.")
        tile = Image.frombytes("L", (mw, mh), raster)
        left = max(0, math.floor(record.bounds.left))
        top = max(0, math.floor(record.bounds.top))
        right = min(width, math.ceil(record.bounds.right))
        bottom = min(height, math.ceil(record.bounds.bottom))
        if right <= left or bottom <= top:
            continue
        if tile.size != (right - left, bottom - top):
            tile = tile.resize((right - left, bottom - top), Image.Resampling.NEAREST)
        layer = np.array(tile, dtype=np.uint8) > 0
        combined[top:bottom, left:right] |= layer.astype(np.uint8)
    return combined if combined.any() else None


def render_mask_views(png: bytes, mask) -> tuple[bytes, bytes, dict]:
    """(overlay png, transparent cutout png, stats). Pure PIL/numpy, no network."""
    import numpy as np
    from PIL import Image

    with Image.open(io.BytesIO(png)) as src:
        base = src.convert("RGBA")
    m = mask.astype(bool)
    arr = np.array(base)

    tint = arr.copy()
    tint[m] = (0.45 * tint[m] + 0.55 * np.array([0, 214, 170, 255])).astype(np.uint8)
    tint[~m] = (0.55 * tint[~m] + 0.45 * np.array([10, 10, 20, 255])).astype(np.uint8)
    overlay = io.BytesIO()
    Image.fromarray(tint).save(overlay, format="PNG")

    cut = arr.copy()
    cut[..., 3] = np.where(m, 255, 0).astype(np.uint8)
    ys, xs = np.where(m)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    cutout = io.BytesIO()
    Image.fromarray(cut).crop(box).save(cutout, format="PNG")

    stats = {
        "coverage": round(float(m.mean()), 4),
        "bbox": list(box),
    }
    return overlay.getvalue(), cutout.getvalue(), stats


# ---------- Muse Image ----------

def generate_scene(client, png: bytes, scene: str) -> bytes:
    prompt = (
        f"Professional product photograph. Place this exact product in this scene: {scene}. "
        "Keep the product itself unchanged: same shape, colour, proportions, text and labels. "
        "Do not add logos or text that are not on the product."
    )
    resp = client.responses.create(
        model=IMAGE_MODEL,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": data_url(png)},
                ],
            }
        ],
        tools=[{"type": "image_generation", "output_format": "png"}],
        store=False,
    )
    for item in _field(resp, "output") or []:
        if _field(item, "type") != "image_generation_call":
            continue
        result = _field(item, "result")
        if isinstance(result, str):
            try:
                return base64.b64decode(result, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise RuntimeError("Muse Image returned invalid image data.") from exc
    raise RuntimeError("Muse Image returned no image.")


# ---------- Muse Voice Transcribe ----------

async def transcribe_pcm16(pcm: bytes, token: str | None = None) -> str:
    """Stream 16 kHz mono PCM16 to Muse Voice Transcribe and return the final transcript."""
    import websockets

    token = token or os.environ.get("MODEL_API_KEY")
    if not token:
        raise MissingKey("MODEL_API_KEY is not set. Add it to .env (see .env.example).")
    credential = token if token.startswith("Bearer ") else f"Bearer {token}"
    handshake = {
        "mode": "PUSH_TO_TALK",
        "authorization": {"accessToken": credential},
        "audioEncoding": "PCM_16KHZ",
        "model": VOICE_MODEL,
        "partialMode": "CUMULATIVE",
        "emitAudioProgress": False,
    }
    async with websockets.connect(VOICE_URL, max_size=None) as ws:
        await ws.send(json.dumps(handshake))
        ack = json.loads(await ws.recv())
        if ack.get("type") == "error":
            raise RuntimeError(str(ack.get("message", "Muse Voice handshake rejected")))

        async def send_audio():
            step = 32_000 // 5  # 200 ms chunks
            for i in range(0, len(pcm), step):
                await ws.send(pcm[i : i + step])
            await ws.send(json.dumps({"type": "endStream"}))

        sender = asyncio.create_task(send_audio())
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                event = json.loads(raw)
                if event.get("type") == "error":
                    raise RuntimeError(str(event.get("message", "Muse Voice failed")))
                if event.get("type") == "transcript" and event.get("final") is True:
                    text = (event.get("transcript") or "").strip()
                    if not text:
                        raise RuntimeError("Muse Voice returned an empty transcript.")
                    return text
            raise RuntimeError("Muse Voice closed before a final transcript arrived.")
        finally:
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)


# ---------- Muse Wonder / generic JSON reasoning ----------

WONDER_MODEL = os.environ.get("WONDER_MODEL", "muse-wonder-1.0")
EFFORTS = {"minimal", "low", "medium", "high"}


def reasoning_json(client, model_key, prompt, images=None, effort="low"):
    """Run a JSON-only prompt on Muse Wonder (text) or Muse Spark (can take images)."""
    images = images or []
    if model_key == "wonder":
        if images:
            raise ValueError("Muse Wonder is text-only here; use spark for images.")
        resp = client.responses.create(
            model=WONDER_MODEL,
            input=prompt,
            reasoning={"effort": effort if effort in EFFORTS else "low"},
            max_output_tokens=4096,
            store=False,
        )
        text = _field(resp, "output_text")
        if not isinstance(text, str) or not text.strip():
            raise RuntimeError("Muse Wonder returned no text.")
        return parse_json_loose(text), WONDER_MODEL
    if model_key == "spark":
        return spark_json(client, prompt, images), SPARK_MODEL
    raise ValueError("model must be 'wonder' or 'spark'")
