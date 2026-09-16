"""Backend web live chat: browser <-> Gemini 2.5 Flash Native Audio.

Browser kirim mic PCM 16kHz + teks via WebSocket.
Server teruskan ke Live API, kembalikan audio 24kHz + transkripsi.

Memori sesi (docs: live-api/session-management):
- context_window_compression sliding window: sesi audio tak terbatas,
  konteks lama diringkas bukan dibuang.
- session_resumption: handle disimpan per client, koneksi putus dalam
  2 jam bisa resume tanpa kehilangan konteks.
- MEMORY per client: ringkasan turn terakhir dikirim ulang saat koneksi
  baru tanpa handle (misal restart server).

Google Search grounding (docs: google-search):
- query param ?search=1 mengaktifkan tool google_search di setup.
- grounding_metadata diteruskan ke browser sebagai sitasi.

Jalan:
    export GEMINI_API_KEY='kunci-anda'
    pip install -r requirements.txt
    python server.py
    buka http://localhost:8000
"""

import asyncio
import base64
import json
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from google import genai

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
STATIC_DIR = Path(__file__).parent / "static"
MAX_MEMORY_TURNS = 20  # turn tersimpan per client (user+model)

# Memori proses: client_id -> list[{"role": "user"|"model", "text": str}]
MEMORY: dict = {}
# Handle resumption: client_id -> handle string (valid 2 jam)
HANDLES: dict = {}

VOICE_GENDER = {
    # pria
    "Puck": "pria", "Charon": "pria", "Fenrir": "pria", "Orus": "pria",
    "Algenib": "pria", "Rasalgethi": "pria", "Gacrux": "pria",
    "Sadaltager": "pria", "Alnilam": "pria", "Schedar": "pria",
    "Achernar": "pria", "Vindemiatrix": "pria", "Autonoe": "pria",
    "Umbriel": "pria", "Albiorix": "pria",
    # wanita
    "Kore": "wanita", "Aoede": "wanita", "Leda": "wanita",
    "Sulafat": "wanita", "Callirrhoe": "wanita", "Despina": "wanita",
    "Erinome": "wanita", "Laomedeia": "wanita", "Achird": "wanita",
    "Pulcherrima": "wanita", "Sadachbia": "wanita", "Zephyr": "wanita",
}
ALLOWED_VOICES = set(VOICE_GENDER.keys())
# alias lama agar kompatibel
MALE_VOICES = {v for v, g in VOICE_GENDER.items() if g == "pria"}
FEMALE_VOICES = {v for v, g in VOICE_GENDER.items() if g == "wanita"}

DEFAULT_VOICE = os.environ.get("LIVE_VOICE", "Charon")
DEFAULT_HOST_VOICE = os.environ.get("LIVE_VOICE_HOST", os.environ.get("LIVE_VOICE", "Charon"))
DEFAULT_GUEST_VOICE = os.environ.get("LIVE_VOICE_GUEST", "Kore")
if DEFAULT_VOICE not in ALLOWED_VOICES:
    DEFAULT_VOICE = "Charon"
if DEFAULT_HOST_VOICE not in ALLOWED_VOICES:
    DEFAULT_HOST_VOICE = "Charon"
if DEFAULT_GUEST_VOICE not in ALLOWED_VOICES:
    DEFAULT_GUEST_VOICE = "Kore"


def _split_keys(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [k.strip() for k in raw.split(",") if k.strip()]


def keys_for_slot(slot: str) -> list[str]:
    """Urutan key untuk slot host/guest/single. Tanpa log isi key."""
    if slot == "host":
        keys = _split_keys(os.environ.get("GEMINI_API_KEY_HOST"))
        if not keys:
            keys = _split_keys(os.environ.get("GEMINI_API_KEYS"))
        if not keys:
            keys = _split_keys(os.environ.get("GEMINI_API_KEY"))
        return keys
    if slot == "guest":
        keys = _split_keys(os.environ.get("GEMINI_API_KEY_GUEST"))
        if not keys:
            pool = _split_keys(os.environ.get("GEMINI_API_KEYS"))
            # key kedua untuk guest bila pool berisi 2+
            if len(pool) >= 2:
                keys = [pool[1]] + [k for k in pool if k != pool[1]]
            elif pool:
                keys = pool
        if not keys:
            keys = _split_keys(os.environ.get("GEMINI_API_KEY"))
        return keys
    keys = _split_keys(os.environ.get("GEMINI_API_KEY"))
    if not keys:
        keys = _split_keys(os.environ.get("GEMINI_API_KEYS"))
    return keys


def is_quota_error(e: Exception) -> bool:
    s = f"{type(e).__name__}: {e}".lower()
    return any(k in s for k in ("429", "resource_exhausted", "quota", "rate limit", "rate_limit"))


def build_config(enable_search: bool = False, resume_handle=None, voice_name: str = DEFAULT_VOICE, role: str = "single"):
    if voice_name not in ALLOWED_VOICES:
        voice_name = DEFAULT_GUEST_VOICE if role == "guest" else DEFAULT_HOST_VOICE if role in ("host",) else DEFAULT_VOICE
    if role == "host":
        system = (
            "Kamu host podcast pria berbahasa Indonesia. "
            "Bicara hangat, pandu alur, lempar pertanyaan ke guest wanita. "
            "Jawab 2-4 kalimat per giliran. Ingat konteks podcast ini."
        )
    elif role == "guest":
        system = (
            "Kamu guest podcast wanita berbahasa Indonesia. "
            "Bicara ramah, jawab host, tambah wawasan. "
            "Jawab 2-4 kalimat per giliran. Ingat konteks podcast ini."
        )
    else:
        system = (
            "Kamu asisten suara berbahasa Indonesia. "
            "Jawab singkat, santai, maksimal 2-3 kalimat. "
            "Ingat konteks percakapan sebelumnya dalam sesi ini."
        )
    config = {
        "response_modalities": ["AUDIO"],
        "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": voice_name}}},
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        # Sesi audio tak terbatas: konteks lama diringkas otomatis.
        "context_window_compression": {"sliding_window": {}},
        # Kirim update handle agar sesi bisa di-resume.
        "session_resumption": {},
        "system_instruction": system,
    }
    if resume_handle:
        config["session_resumption"] = {"handle": resume_handle}
    if enable_search:
        config["tools"] = [{"google_search": {}}]
    return config


def remember(client_id: str, role: str, text: str):
    buf = MEMORY.setdefault(client_id, [])
    buf.append({"role": role, "text": text})
    del buf[: -MAX_MEMORY_TURNS]


def memory_summary(client_id: str) -> str:
    buf = MEMORY.get(client_id, [])
    if not buf:
        return ""
    lines = []
    for t in buf[-8:]:
        who = "Pengguna" if t["role"] == "user" else "Asisten"
        lines.append(f"{who}: {t['text']}")
    return "\n".join(lines)


app = FastAPI()


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


async def gemini_to_browser(session, ws: WebSocket, client_id: str, voice_name: str = DEFAULT_VOICE):
    """Teruskan audio + transkripsi + sitasi Gemini ke browser.

    Loop per-turn karena SDK receive() berhenti tiap turn_complete.
    """
    turn_text = ""
    while True:
        try:
            async for msg in session.receive():
                # Handle resumption: simpan untuk koneksi berikutnya.
                update = getattr(msg, "session_resumption_update", None)
                if update is not None and getattr(
                    update, "new_handle", None
                ):
                    HANDLES[client_id] = update.new_handle
                    HANDLES[client_id + ":voice"] = voice_name

                # GoAway: koneksi akan diputus, beri tahu browser.
                if getattr(msg, "go_away", None) is not None:
                    try:
                        await ws.send_json(
                            {
                                "type": "status",
                                "text": "Koneksi Live hampir berakhir, "
                                "menyambung ulang otomatis...",
                            }
                        )
                    except Exception:
                        pass

                sc = msg.server_content
                if sc is None:
                    continue
                if sc.input_transcription and sc.input_transcription.text:
                    text = sc.input_transcription.text
                    remember(client_id, "user", text)
                    await ws.send_json(
                        {"type": "transcript_in", "text": text}
                    )
                if sc.output_transcription and sc.output_transcription.text:
                    chunk = sc.output_transcription.text
                    turn_text += chunk
                    await ws.send_json(
                        {"type": "transcript_out", "text": chunk}
                    )
                model_turn = getattr(sc, "model_turn", None)
                if model_turn and model_turn.parts:
                    for part in model_turn.parts:
                        blob = getattr(part, "inline_data", None)
                        if blob is not None and getattr(blob, "data", None):
                            await ws.send_json(
                                {
                                    "type": "audio",
                                    "mime_type": "audio/pcm;rate=24000",
                                    "data": base64.b64encode(
                                        bytes(blob.data)
                                    ).decode("ascii"),
                                }
                            )
                # Sitasi Google Search grounding.
                gm = getattr(sc, "grounding_metadata", None)
                if gm is not None:
                    chunks = getattr(gm, "grounding_chunks", None) or []
                    sources = []
                    for c in chunks:
                        web = getattr(c, "web", None)
                        if web is not None and getattr(web, "uri", None):
                            sources.append(
                                {
                                    "title": getattr(web, "title", None)
                                    or web.uri,
                                    "url": web.uri,
                                }
                            )
                    if sources:
                        await ws.send_json(
                            {"type": "sources", "items": sources}
                        )
                if sc.turn_complete:
                    if turn_text.strip():
                        remember(client_id, "model", turn_text.strip())
                    turn_text = ""
                    await ws.send_json({"type": "turn_complete"})
                    break  # buka receive() untuk turn berikut
        except Exception as e:  # koneksi Gemini putus
            try:
                await ws.send_json(
                    {"type": "status", "text": f"live terputus: {e}"}
                )
            except Exception:
                pass
            break


async def browser_to_gemini(session, ws: WebSocket, client_id: str):
    """Teruskan teks + audio browser ke Gemini."""
    while True:
        raw = await ws.receive_text()
        try:
            pkt = json.loads(raw)
        except json.JSONDecodeError:
            continue
        kind = pkt.get("type")
        if kind == "text" and pkt.get("text", "").strip():
            text = pkt["text"].strip()
            remember(client_id, "user", text)
            await session.send_client_content(
                turns={"parts": [{"text": text}]}
            )
        elif kind == "audio" and pkt.get("data"):
            pcm = base64.b64decode(pkt["data"])
            await session.send_realtime_input(
                audio={"data": pcm, "mime_type": "audio/pcm;rate=16000"}
            )


@app.websocket("/ws")
async def ws_bridge(ws: WebSocket):
    await ws.accept()
    params = ws.query_params
    client_id = params.get("client", "default")
    enable_search = params.get("search", "0") == "1"
    voice_name = params.get("voice", DEFAULT_VOICE)
    if voice_name not in ALLOWED_VOICES:
        voice_name = DEFAULT_VOICE
    keys = keys_for_slot("single")
    if not keys:
        await ws.send_json(
            {"type": "status", "text": "Server belum set GEMINI_API_KEY di .env."}
        )
        await ws.close()
        return
    # Resume sesi sebelumnya bila handle masih valid (< 2 jam).
    last_voice = HANDLES.get(client_id + ":voice")
    handle = HANDLES.get(client_id)
    if last_voice is not None and last_voice != voice_name:
        handle = None
    for _attempt, _key in enumerate(keys):
        client = genai.Client(api_key=_key)
        resumed = bool(handle)
        try:
            async with client.aio.live.connect(
                model=LIVE_MODEL,
                config=build_config(enable_search, handle, voice_name),
            ) as session:
                mode = " + Google Search" if enable_search else ""
                mode += f" + suara {voice_name}"
                if resumed:
                    await ws.send_json(
                        {
                            "type": "status",
                            "text": f"Sesi dilanjutkan{mode}.",
                        }
                    )
                else:
                    await ws.send_json(
                        {
                            "type": "status",
                            "text": f"Terhubung ke {LIVE_MODEL}{mode}.",
                        }
                    )
                summary = memory_summary(client_id)
                if summary:
                    # Konteks dikirim sebagai bagian turn yang belum
                    # selesai (turn_complete=False), jadi model menunggu
                    # pesan user berikutnya dalam turn yang sama.
                    # Tidak perlu drain receive() di sini karena itu
                    # berebut dengan gemini_to_browser.
                    await session.send_client_content(
                        turns={
                            "parts": [
                                {
                                    "text": "Konteks percakapan sebelumnya "
                                    "dengan pengguna ini (jadikan memori):\n"
                                    + summary
                                }
                            ]
                        },
                        turn_complete=False,
                    )
                if not MEMORY.get(client_id):
                    # Sapaan awal hanya untuk client benar-benar baru.
                    await session.send_client_content(
                        turns={
                            "parts": [
                                {"text": "Halo! Perkenalkan dirimu singkat."}
                            ]
                        }
                    )
                recv_task = asyncio.create_task(
                    gemini_to_browser(session, ws, client_id, voice_name)
                )
                try:
                    await browser_to_gemini(session, ws, client_id)
                except WebSocketDisconnect:
                    pass
                finally:
                    recv_task.cancel()
                    try:
                        await recv_task
                    except asyncio.CancelledError:
                        pass
            return  # browser tutup normal
        except Exception as e:
            # Handle basi -> hapus agar koneksi berikut mulai sesi baru.
            HANDLES.pop(client_id, None)
            handle = None
            if is_quota_error(e) and _attempt + 1 < len(keys):
                try:
                    await ws.send_json({"type": "status", "text": "Key limit tercapai, coba key cadangan..."})
                except Exception:
                    pass
                continue
            try:
                await ws.send_json({"type": "status", "text": f"Gagal: {e}"})
                await ws.close()
            except Exception:
                pass
            return


@app.websocket("/ws_podcast")
async def ws_podcast(ws: WebSocket):
    """Satu WS browser -> orkestrasi dual Live (host+guest)."""
    import time as _time
    import podcast as _pod

    await ws.accept()
    params = ws.query_params
    client_id = params.get("client", "default")
    enable_search = params.get("search", "0") == "1"
    host_voice = params.get("host_voice", DEFAULT_HOST_VOICE)
    guest_voice = params.get("guest_voice", DEFAULT_GUEST_VOICE)
    if host_voice not in ALLOWED_VOICES:
        host_voice = DEFAULT_HOST_VOICE
    if guest_voice not in ALLOWED_VOICES:
        guest_voice = DEFAULT_GUEST_VOICE
    try:
        max_minutes = min(10.0, max(1.0, float(params.get("max_minutes", "10"))))
    except Exception:
        max_minutes = 10.0
    pid = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                pkt = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = pkt.get("type")
            if kind == "podcast_start" and pid is not None:
                await _pod.stop_podcast(pid, reason="Podcast sebelumnya dihentikan, mulai baru.")
                pid = None
            if kind == "podcast_start" and pid is None:
                topic = (pkt.get("topic") or "").strip() or "Obrolan santai"
                hv = pkt.get("host_voice", host_voice)
                gv = pkt.get("guest_voice", guest_voice)
                if hv not in ALLOWED_VOICES:
                    hv = host_voice
                if gv not in ALLOWED_VOICES:
                    gv = guest_voice
                try:
                    mm = min(10.0, max(1.0, float(pkt.get("max_minutes", max_minutes))))
                except Exception:
                    mm = max_minutes
                pid = f"{client_id}-{int(_time.time())}"
                try:
                    await _pod.start_podcast(pid, client_id, ws, topic, hv, gv, mm, enable_search)
                except Exception as e:
                    await ws.send_json({"type": "status", "text": f"Gagal mulai podcast: {e}"})
                    pid = None
            elif kind == "podcast_stop" and pid is not None:
                await _pod.stop_podcast(pid, reason="Podcast dihentikan manual.")
                pid = None
    except WebSocketDisconnect:
        pass
    finally:
        if pid is not None:
            try:
                await _pod.stop_podcast(pid, reason="Browser terputus.")
            except Exception:
                pass


@app.get("/export/{pid}")
async def export_podcast(pid: str):
    """Render + unduh MP4 server-side bila podcast selesai."""
    from fastapi.responses import JSONResponse

    import podcast as _pod

    safe = "".join(c for c in pid if c.isalnum() or c in ("-", "_"))
    if not safe:
        return JSONResponse({"ok": False, "error": "pid tidak valid"}, status_code=400)
    mp4 = os.path.join(_pod.EXPORT_DIR, f"{safe}.mp4")
    if os.path.exists(mp4):
        return FileResponse(mp4, media_type="video/mp4", filename=f"{safe}.mp4")
    pod = _pod.PODCASTS.get(pid) or _pod.PODCASTS.get(safe)
    if pod is None:
        return JSONResponse({"ok": False, "error": "podcast tidak ditemukan"}, status_code=404)
    if pod.turns == 0:
        return JSONResponse({"ok": False, "error": "belum ada audio, podcast terlalu singkat"}, status_code=409)
    try:
        path = await asyncio.to_thread(_pod.render_export, pod)
        return FileResponse(path, media_type="video/mp4", filename=f"{safe}.mp4")
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"render gagal: {e}"}, status_code=500)


@app.get("/export_status/{pid}")
async def export_status(pid: str):
    """Status ringan untuk frontend sebelum unduh."""
    from fastapi.responses import JSONResponse

    import podcast as _pod

    safe = "".join(c for c in pid if c.isalnum() or c in ("-", "_"))
    mp4 = os.path.join(_pod.EXPORT_DIR, f"{safe}.mp4")
    if os.path.exists(mp4):
        return {"ok": True, "ready": True, "turns": None}
    pod = _pod.PODCASTS.get(pid) or _pod.PODCASTS.get(safe)
    if pod is None:
        return JSONResponse({"ok": False, "error": "podcast tidak ditemukan"}, status_code=404)
    return {"ok": True, "ready": False, "turns": pod.turns, "running": pod.running}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
