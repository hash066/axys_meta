"""ElevenLabs text to speech for the Axys gateway.

Meta's Model API has no speech synthesis model (Muse Voice Transcribe only transcribes), so spoken audio is produced by ElevenLabs.
The words themselves are written by a Meta model upstream (Muse Wonder) and validated in code; this module only voices them.

- Every clip is cached on disk by (voice, model, text), so repeating a line costs nothing.
- A local ledger and the account's reported quota guard against running out of credits mid-demo.
- The key is read from ELEVENLABS_API_KEY and never logged or returned.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.elevenlabs.io/v1"
DEFAULT_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")  # costs 0.5 credit per character
CACHE = Path(os.environ.get("SPEECH_CACHE_DIR", Path(__file__).resolve().parent / ".speech-cache"))
MAX_CHARS = 400
RESERVE_CREDITS = 40  # never spend the last few credits

# Friendly names mapped to ElevenLabs premade voice names (ids are looked up from the account's voice list).
PRESETS = {
    "narrator": "Sarah",   # mature, reassuring, confident
    "merchant": "Jessica",  # playful, bright, warm (used for the simulated merchant voice note)
    "reel": "Liam",        # energetic social media creator
    "calm": "Eric",
}


class SpeechError(RuntimeError):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise SpeechError("ELEVENLABS_API_KEY is not set.", 503)
    return key


def _request(path: str, *, method="GET", body: dict | None = None, accept="application/json"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("xi-api-key", _key())
    req.add_header("Accept", accept)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode()).get("detail", {})
            detail = detail.get("message", "") if isinstance(detail, dict) else str(detail)
        except Exception:  # noqa: BLE001
            pass
        raise SpeechError(f"ElevenLabs rejected the request ({exc.code}). {detail}"[:240], 502 if exc.code >= 500 else 400) from exc
    except urllib.error.URLError as exc:
        raise SpeechError(f"ElevenLabs is unreachable: {exc.reason}", 502) from exc


_voices: dict[str, str] | None = None


def voice_id(name_or_id: str) -> str:
    """Accepts a preset ('narrator'), a premade voice name ('Sarah') or a raw voice id."""
    global _voices
    wanted = PRESETS.get(name_or_id.lower(), name_or_id)
    if re.fullmatch(r"[A-Za-z0-9]{20}", wanted):
        return wanted
    if _voices is None:
        raw, _ = _request("/voices")
        _voices = {v["name"].split(" - ")[0].strip().lower(): v["voice_id"] for v in json.loads(raw).get("voices", [])}
    found = _voices.get(wanted.lower())
    if not found:
        raise SpeechError(f"Unknown voice '{name_or_id}'. Available: {', '.join(sorted(_voices))}", 400)
    return found


def _ledger_path() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    return CACHE / "ledger.json"


def _ledger() -> dict:
    p = _ledger_path()
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return {"credits_spent_by_axys": 0.0}


def budget() -> dict:
    raw, _ = _request("/user/subscription")
    d = json.loads(raw)
    limit, used = int(d.get("character_limit", 0)), int(d.get("character_count", 0))
    led = _ledger()
    spent = float(led.get("credits_spent_by_axys", 0.0))
    if "baseline_used" not in led:
        led["baseline_used"] = used  # the account's counter when Axys first spent anything
        _ledger_path().write_text(json.dumps(led, indent=1))
    # The account counter can lag behind a just-made request, so assume the larger of the reported figure and baseline + our own spending.
    effective_used = max(used, int(led["baseline_used"]) + int(round(spent)))
    return {"tier": d.get("tier"), "limit": limit, "used": effective_used, "remaining": max(0, limit - effective_used),
            "credits_spent_by_axys": spent, "model_credit_per_char": 0.5}


def speak(text: str, voice: str = "narrator", model: str | None = None) -> dict:
    text = re.sub(r"\s+", " ", text).strip()
    if not text or len(text) > MAX_CHARS:
        raise SpeechError(f"Text must be 1 to {MAX_CHARS} characters.", 400)
    model = model or DEFAULT_MODEL
    vid = voice_id(voice)
    digest = hashlib.sha256(f"{vid}|{model}|{text}".encode()).hexdigest()[:32]
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{digest}.mp3"
    if path.exists():
        return {"audio": path.read_bytes(), "cached": True, "credits_charged": 0, "voice_id": vid, "model": model, "sha": digest}
    per_char = 0.5 if model.startswith(("eleven_flash", "eleven_turbo")) else 1.0
    need = len(text) * per_char
    remaining = budget()["remaining"]
    if remaining - need < RESERVE_CREDITS:
        raise SpeechError(f"Not enough ElevenLabs credits left ({remaining:.0f}) for this line ({need:.0f}). Add credits or shorten the text.", 402)
    body, headers = _request(
        f"/text-to-speech/{vid}?output_format=mp3_44100_64",
        method="POST",
        body={"text": text, "model_id": model, "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.15}},
        accept="audio/mpeg",
    )
    charged = float(headers.get("character-cost", need) or need)
    path.write_bytes(body)
    led = _ledger()
    led["credits_spent_by_axys"] = float(led.get("credits_spent_by_axys", 0.0)) + charged
    led.setdefault("clips", {})[digest] = {"chars": len(text), "credits": charged, "voice": voice, "at": int(time.time())}
    _ledger_path().write_text(json.dumps(led, indent=1))
    return {"audio": body, "cached": False, "credits_charged": charged, "voice_id": vid, "model": model, "sha": digest}
