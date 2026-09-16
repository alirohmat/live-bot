"""Orkestrasi podcast live dual avatar: host pria + guest wanita.

Dua sesi `client.aio.live.connect` paralel, key berbeda per avatar.
Relay utama forward audio PCM 24kHz -> resample 16kHz half-duplex.
Host pantau durasi, hard stop 10 menit default.

Rekaman server-side: PCM per speaker + timeline transcript.
Export MP4 via ffmpeg (wav campur + frame PIL + subtitle).
"""

import asyncio
import base64
import os
import subprocess
import time
import wave
from dataclasses import dataclass, field

import numpy as np

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PIL = True
except Exception:
    HAS_PIL = False

from google import genai

from server import (
    LIVE_MODEL,
    build_config,
    keys_for_slot,
    is_quota_error,
    remember,
    HANDLES,
)

PODCASTS: dict = {}


def _export_dir() -> str:
    """Dir export, fallback /tmp bila FS read-only (Vercel serverless)."""
    import tempfile

    d = os.environ.get("PODCAST_EXPORT_DIR", "exports")
    try:
        os.makedirs(d, exist_ok=True)
        return d
    except OSError:
        fb = os.path.join(tempfile.gettempdir(), "podcast_exports")
        os.makedirs(fb, exist_ok=True)
        return fb


EXPORT_DIR = _export_dir()


def resample_24k_to_16k(pcm24: bytes) -> bytes:
    """PCM int16 mono 24kHz -> 16kHz. Linear sederhana, cukup jernih."""
    if not pcm24:
        return b""
    a = np.frombuffer(pcm24, dtype=np.int16).astype(np.float32)
    n_out = int(len(a) * 16000 / 24000)
    if n_out < 1:
        return b""
    x_old = np.linspace(0, 1, len(a))
    x_new = np.linspace(0, 1, n_out)
    b = np.interp(x_new, x_old, a).astype(np.int16)
    return b.tobytes()


def _norm_segs(segs, pcm_bytes: bytes = b""):
    """Terima list (text,start,pcm) atau bytes mentah (offset 0)."""
    if isinstance(segs, (bytes, bytearray)):
        return [("", 0.0, bytes(segs))] if segs else []
    return list(segs or [])


def mix_wav(path: str, host_pcm, guest_pcm: list, rate: int = 24000, stereo: bool = False):
    """Campur audio per offset timeline akurat. host_pcm boleh bytes lama atau list segs."""
    host_segs = _norm_segs(host_pcm)
    guest_segs = _norm_segs(guest_pcm)
    total = 0
    for _, start_s, chunk in host_segs + guest_segs:
        end = int(max(0.0, start_s) * rate) + len(chunk) // 2
        total = max(total, end)
    total = max(total, 1)
    if stereo:
        buf = np.zeros((total, 2), dtype=np.float32)
    else:
        buf = np.zeros(total, dtype=np.float32)
    for _, start_s, chunk in host_segs:
        if not chunk:
            continue
        h = np.frombuffer(chunk, dtype=np.int16).astype(np.float32)
        i = int(max(0.0, start_s) * rate)
        j = min(total, i + len(h))
        if j <= i:
            continue
        if stereo:
            buf[i:j, 0] += h[: j - i]
        else:
            buf[i:j] += h[: j - i]
    for _, start_s, chunk in guest_segs:
        if not chunk:
            continue
        g = np.frombuffer(chunk, dtype=np.int16).astype(np.float32)
        i = int(max(0.0, start_s) * rate)
        j = min(total, i + len(g))
        if j <= i:
            continue
        if stereo:
            buf[i:j, 1] += g[: j - i]
        else:
            buf[i:j] += g[: j - i]
    buf = np.clip(buf, -32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2 if stereo else 1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(buf.tobytes())
    return path


MAX_TURNS = 60  # cap giliran ~10 mnt, pengaman kedua selain timer


@dataclass
class PodcastSession:
    pid: str
    topic: str
    client_id: str
    host_voice: str = "Charon"
    guest_voice: str = "Kore"
    max_minutes: float = 10.0
    ws: object = None
    enable_search: bool = False
    running: bool = False
    speaker: str = "host"  # half-duplex: siapa boleh bicara
    t0: float = 0.0
    host_pcm: bytearray = field(default_factory=bytearray)  # legacy: gabungan mentah
    host_segs: list = field(default_factory=list)  # (text, start_s, pcm) offset akurat
    guest_segs: list = field(default_factory=list)  # (text, start_s, pcm)
    timeline: list = field(default_factory=list)  # {avatar,text,t0,t1}
    host_text: str = ""
    guest_text: str = ""
    host_audio: bytearray = field(default_factory=bytearray)
    guest_audio: bytearray = field(default_factory=bytearray)
    turns: int = 0
    _tasks: list = field(default_factory=list)

    def elapsed(self) -> float:
        return time.time() - self.t0 if self.t0 else 0.0

    def remaining(self) -> float:
        return max(0.0, self.max_minutes * 60 - self.elapsed())


async def _send(ws, pkt: dict):
    try:
        await ws.send_json(pkt)
    except Exception:
        pass


async def _relay_turn(pod: PodcastSession, src: str, sessions: dict):
    """Forward audio turn src -> lawan. Half-duplex."""
    dst = "guest" if src == "host" else "host"
    sess = sessions.get(dst)
    if sess is None or not pod.running:
        return
    # snapshot + kosongkan dulu agar chunk baru turn berikut tidak ikut dobel
    if src == "host":
        audio = bytes(pod.host_audio)
        text = pod.host_text.strip()
        pod.host_audio = bytearray()
        pod.host_text = ""
    else:
        audio = bytes(pod.guest_audio)
        text = pod.guest_text.strip()
        pod.guest_audio = bytearray()
        pod.guest_text = ""
    if not audio and not text:
        return
    # echo guard: turn hampa (audio <0.3 dtk + teks <3 kata) jangan direlay,
    # itu gema/noise, bukan ucapan lawan
    if len(audio) < 24000 * 2 * 2 // 10 * 3 and len(text.split()) < 3:
        return
    # kunci giliran ke lawan agar tidak rebutan
    pod.speaker = dst
    try:
        if audio:
            pcm16 = resample_24k_to_16k(audio)
            # kirim per 100ms agar realtime input stabil; abort bila pod berhenti
            step = 16000 * 2 // 10
            for i in range(0, len(pcm16), step):
                if not pod.running:
                    return
                await sess.send_realtime_input(
                    audio={"data": pcm16[i : i + step], "mime_type": "audio/pcm;rate=16000"}
                )
                await asyncio.sleep(0.02)
        elif text:
            if not pod.running:
                return
            # fallback bila audio kosong: teks pendek, Live API dukung send_client_content
            await sess.send_client_content(turns={"parts": [{"text": f"Lawan bicara berkata: {text}. Tanggapi 2-3 kalimat."}]})
    except Exception as e:
        await _send(pod.ws, {"type": "status", "text": f"relay {src}->{dst} gagal: {e}"})


async def _pump(pod: PodcastSession, role: str, session, sessions: dict):
    """Terima audio+transkrip satu sesi, teruskan ke browser + simpan + relay saat turn_complete."""
    turn_text = ""
    turn_audio = bytearray()
    t_start = time.time()
    mem_key = f"{pod.client_id}:{role}"
    try:
        while pod.running:
            try:
                async for msg in session.receive():
                    if not pod.running:
                        return
                    upd = getattr(msg, "session_resumption_update", None)
                    if upd is not None and getattr(upd, "new_handle", None):
                        HANDLES[mem_key] = upd.new_handle
                    sc = msg.server_content
                    if sc is None:
                        continue
                    if sc.output_transcription and sc.output_transcription.text:
                        chunk = sc.output_transcription.text
                        turn_text += chunk
                        if role == "host":
                            pod.host_text += chunk
                        else:
                            pod.guest_text += chunk
                        await _send(pod.ws, {"type": "transcript_out", "avatar": role, "text": chunk})
                    mt = getattr(sc, "model_turn", None)
                    if mt and mt.parts:
                        for part in mt.parts:
                            blob = getattr(part, "inline_data", None)
                            if blob is not None and getattr(blob, "data", None):
                                raw = bytes(blob.data)
                                turn_audio += raw
                                if role == "host":
                                    pod.host_audio += raw
                                else:
                                    pod.guest_audio += raw
                                await _send(pod.ws, {
                                    "type": "audio", "avatar": role,
                                    "mime_type": "audio/pcm;rate=24000",
                                    "data": base64.b64encode(raw).decode("ascii"),
                                })
                    if sc.turn_complete:
                        dur = time.time() - t_start
                        txt = turn_text.strip()
                        if txt:
                            remember(mem_key, "model", txt)
                        # simpan rekaman
                        now_s = pod.elapsed()
                        if role == "host":
                            pod.host_pcm += turn_audio
                            pod.host_segs.append((txt, now_s - dur, bytes(turn_audio)))
                        else:
                            pod.guest_segs.append((txt, now_s - dur, bytes(turn_audio)))
                        pod.timeline.append({"avatar": role, "text": txt, "t0": now_s - dur, "t1": now_s})
                        pod.turns += 1
                        await _send(pod.ws, {"type": "turn_complete", "avatar": role})
                        turn_text = ""
                        turn_audio = bytearray()
                        t_start = time.time()
                        # relay ke lawan bila masih ada waktu dan belum cap
                        if pod.remaining() > 5 and pod.turns < MAX_TURNS:
                            await _relay_turn(pod, role, sessions)
                        elif pod.turns >= MAX_TURNS:
                            await _send(pod.ws, {"type": "status", "text": "Cap 60 giliran tercapai, menutup."})
                            asyncio.create_task(stop_podcast(pod.pid, reason="Cap giliran tercapai."))
                        break
            except Exception as e:
                await _send(pod.ws, {"type": "status", "text": f"live {role} terputus: {e}"})
                return
    except asyncio.CancelledError:
        pass


async def _timer(pod: PodcastSession, sessions: dict):
    """Host pantau durasi: warning 30 detik akhir, hard stop tepat waktu."""
    warned = False
    while pod.running:
        await asyncio.sleep(1)
        rem = pod.remaining()
        if rem <= 30 and not warned:
            warned = True
            await _send(pod.ws, {"type": "status", "text": "30 detik tersisa. Host menutup podcast."})
            try:
                hs = sessions.get("host")
                if hs is not None:
                    await hs.send_client_content(turns={"parts": [
                        {"text": "Waktu hampir habis. Tutup podcast dengan 1-2 kalimat penutup hangat."}
                    ]})
            except Exception:
                pass
        if rem <= 0:
            await stop_podcast(pod.pid, reason="Durasi 10 menit tercapai.")
            return


async def _connect_slot(keys: list, slot_key: str, voice: str, role: str,
                      enable_search: bool):
    """Buka 1 sesi Live, coba tiap key. Stale handle -> bersihkan, coba lagi."""
    last_err = None
    tried_stale_retry = False
    for key in keys:
        handle = HANDLES.get(slot_key)
        cfg = build_config(enable_search, handle, voice, role)
        try:
            client = genai.Client(api_key=key)
            ctx = client.aio.live.connect(model=LIVE_MODEL, config=cfg)
            sess = await ctx.__aenter__()
            return ctx, sess
        except Exception as e:
            last_err = e
            msg = f"{type(e).__name__}: {e}".lower()
            if ("handle" in msg or "resum" in msg or "invalid" in msg) and not tried_stale_retry:
                tried_stale_retry = True
                HANDLES.pop(slot_key, None)
                continue
            if not is_quota_error(e):
                raise
    raise last_err


async def start_podcast(pid: str, client_id: str, ws, topic: str, host_voice: str,
                        guest_voice: str, max_minutes: float = 10.0,
                        enable_search: bool = False) -> PodcastSession:
    host_keys = keys_for_slot("host")
    guest_keys = keys_for_slot("guest")
    if not host_keys or not guest_keys:
        raise RuntimeError("Set GEMINI_API_KEY_HOST dan GEMINI_API_KEY_GUEST di .env.")
    pod = PodcastSession(pid=pid, topic=topic, client_id=client_id, ws=ws,
                         host_voice=host_voice, guest_voice=guest_voice,
                         max_minutes=max_minutes, enable_search=enable_search)
    PODCASTS[pid] = pod
    if len(PODCASTS) > 5:
        for old_pid, old_pod in list(PODCASTS.items()):
            if old_pid != pid and not getattr(old_pod, "running", False):
                PODCASTS.pop(old_pid, None)
                if len(PODCASTS) <= 5:
                    break

    try:
        h_ctx, h_sess = await _connect_slot(
            host_keys, f"{client_id}:host", host_voice, "host", enable_search)
    except Exception as e:
        PODCASTS.pop(pid, None)
        raise RuntimeError(f"Gagal buka sesi host: {e}")
    try:
        g_ctx, g_sess = await _connect_slot(
            guest_keys, f"{client_id}:guest", guest_voice, "guest", enable_search)
    except Exception as e:
        try:
            await h_ctx.__aexit__(None, None, None)
        except Exception:
            pass
        PODCASTS.pop(pid, None)
        raise RuntimeError(f"Gagal buka sesi guest: {e}")
    try:
        pod.running = True
        pod.t0 = time.time()
        sessions = {"host": h_sess, "guest": g_sess}
        pod._ctxs = (h_ctx, g_ctx)
        pod._sessions = sessions
        # konteks topik ke dua agen
        intro = f"Topik podcast: {topic}. Host pria buka dulu 2-3 kalimat, lalu guest wanita menanggapi. Bergantian."
        await h_sess.send_client_content(turns={"parts": [{"text": intro}]})
        await g_sess.send_client_content(
            turns={"parts": [{"text": intro + " Tunggu host bicara dulu."}]},
            turn_complete=False,
        )
        pod._tasks = [
            asyncio.create_task(_pump(pod, "host", h_sess, sessions)),
            asyncio.create_task(_pump(pod, "guest", g_sess, sessions)),
            asyncio.create_task(_timer(pod, sessions)),
        ]
        await _send(ws, {"type": "podcast_started", "pid": pid, "topic": topic})
        return pod
    except Exception as e:
        try:
            await h_ctx.__aexit__(None, None, None)
        except Exception:
            pass
        try:
            await g_ctx.__aexit__(None, None, None)
        except Exception:
            pass
        PODCASTS.pop(pid, None)
        raise RuntimeError(f"Gagal mulai podcast: {e}")


async def stop_podcast(pid: str, reason: str = "Podcast dihentikan."):
    pod = PODCASTS.get(pid)
    if not pod:
        return None
    pod.running = False
    try:
        cur = asyncio.current_task()
    except Exception:
        cur = None
    others = [t for t in pod._tasks if t is not cur]
    for t in pod._tasks:
        if t is not cur:
            t.cancel()
    if others:
        try:
            await asyncio.gather(*others, return_exceptions=True)
        except Exception:
            pass
    try:
        h_ctx, g_ctx = pod._ctxs
        await h_ctx.__aexit__(None, None, None)
        await g_ctx.__aexit__(None, None, None)
    except Exception:
        pass
    pod.host_text = ""
    pod.guest_text = ""
    pod.host_audio = bytearray()
    pod.guest_audio = bytearray()
    pod._tasks = []
    await _send(pod.ws, {"type": "podcast_stopped", "pid": pid, "text": reason})
    return pod


def render_export(pod: PodcastSession) -> str:
    """Render MP4 server-side: wav campur + frame PIL + ffmpeg mux. Return path."""
    export_dir = _export_dir()
    out_mp4 = os.path.join(export_dir, f"{pod.pid}.mp4")
    wav_path = os.path.join(export_dir, f"{pod.pid}.wav")
    host_src = pod.host_segs if getattr(pod, "host_segs", None) else bytes(pod.host_pcm)
    stereo = os.environ.get("PODCAST_STEREO", "0") == "1"
    mix_wav(wav_path, host_src, pod.guest_segs, stereo=stereo)
    # durasi dari wav
    import wave as wv
    with wv.open(wav_path, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        dur = frames / float(rate)
    dur = max(dur, 1.0)
    W, H = 1280, 720
    fps = 10
    n = int(dur * fps)
    frames_dir = os.path.join(export_dir, f"{pod.pid}_frames")
    os.makedirs(frames_dir, exist_ok=True)
    font = None
    if HAS_PIL:
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
            small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
        except Exception:
            font = ImageFont.load_default()
            small = font
    # subtitle lookup
    def sub_at(t: float) -> str:
        for seg in pod.timeline:
            if seg["t0"] <= t <= seg["t1"] + 0.5 and seg["text"]:
                who = "HOST" if seg["avatar"] == "host" else "GUEST"
                return f"{who}: {seg['text'][:120]}"
        return pod.topic[:120]
    # speaker aktif lookup
    def active_at(t: float) -> str:
        for seg in pod.timeline:
            if seg["t0"] <= t <= seg["t1"]:
                return seg["avatar"]
        return "host" if int(t) % 2 == 0 else "guest"
    for i in range(n):
        t = i / fps
        act = active_at(t)
        img = Image.new("RGB", (W, H), (11, 18, 32))
        d = ImageDraw.Draw(img)
        # dua panel avatar netral modern
        for idx, (name, col, hi) in enumerate([
            ("HOST", (56, 189, 248), act == "host"),
            ("GUEST", (244, 114, 182), act == "guest"),
        ]):
            x0 = 60 + idx * 610
            y0 = 90
            bw, bh = 560, 420
            d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], 24, fill=(22, 33, 58),
                                outline=col if hi else (51, 65, 85), width=4 if hi else 2)
            # kepala
            cx, cy = x0 + bw // 2, y0 + 170
            skin = (245, 195, 150) if idx == 0 else (240, 190, 150)
            d.ellipse([cx - 70, cy - 80, cx + 70, cy + 80], fill=skin)
            if idx == 0:
                # rambut pendek pria modern
                d.arc([cx - 70, cy - 95, cx + 70, cy + 20], 180, 360, fill=(30, 30, 35), width=22)
                d.rectangle([cx - 70, cy + 60, cx + 70, cy + 200], fill=(30, 58, 95))
            else:
                # rambut panjang wanita modern
                d.ellipse([cx - 85, cy - 95, cx + 85, cy + 60], fill=(90, 50, 30))
                d.ellipse([cx - 70, cy - 80, cx + 70, cy + 80], fill=skin)
                d.rectangle([cx - 80, cy + 60, cx + 80, cy + 200], fill=(120, 40, 70))
            # mata + mulut bicara bila aktif
            d.ellipse([cx - 35, cy - 15, cx - 15, cy + 5], fill=(20, 20, 20))
            d.ellipse([cx + 15, cy - 15, cx + 35, cy + 5], fill=(20, 20, 20))
            mh = 22 if hi else 6
            d.ellipse([cx - 18, cy + 35, cx + 18, cy + 35 + mh], fill=(127, 29, 29))
            d.text((x0 + 24, y0 + 16), name, fill=col, font=font)
        # subtitle bawah
        d.rounded_rectangle([60, 540, 1220, 660], 16, fill=(2, 6, 23))
        d.text((90, 565), sub_at(t), fill=(226, 232, 240), font=small)
        img.save(os.path.join(frames_dir, f"f{i:05d}.png"))
    if dur < 1.0:
        # tanpa audio valid ffmpeg gagal; buat nada hening 1 detik agar MP4 tetap jadi
        silence = (np.zeros(rate, dtype=np.int16)).tobytes()
        mix_wav(wav_path, silence, [])
        dur = 1.0
        n = int(dur * fps)
        for i in range(len(pod.timeline), n):
            pass
    cmd = ["ffmpeg", "-y", "-framerate", str(fps), "-i", os.path.join(frames_dir, "f%05d.png"),
           "-i", wav_path, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
           "-shortest", out_mp4]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    finally:
        import shutil
        try:
            shutil.rmtree(frames_dir, ignore_errors=True)
        except Exception:
            pass
    return out_mp4
