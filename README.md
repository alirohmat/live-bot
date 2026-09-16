# gemini-live

Live API demo with `google-genai` SDK.

## Setup

```bash
pip install -r requirements.txt
export GEMINI_API_KEY='your-key'
```

## Run

```bash
python live_text_demo.py
python list_models.py
# live chat audio dua arah (butuh mic + speaker)
python live_audio_chat.py
# versi web (browser mic + speaker, server bridge)
python server.py
# buka http://localhost:8000
```

Di dalam `live_audio_chat.py`: ketik teks + Enter untuk kirim pesan,
`/quit` untuk keluar. Di server tanpa mic/speaker otomatis mode teks.

## Notes

- `gemini-2.5-flash` retired for new users. Use `gemini-3.6-flash` for `generateContent`.
- Live models use `bidiGenerateContent`, need `AUDIO` modality:
  - `gemini-2.5-flash-native-audio-preview-12-2025` works with `output_audio_transcription`.
  - `gemini-3.1-flash-live-preview` rejects `AUDIO` + transcription combo on this key.
- `TEXT` modality rejected on native-audio Live models.

## Suara

Default pria `Charon` (env `LIVE_VOICE`). Web: dropdown Suara di footer. CLI `live_audio_chat.py` / `live_text_demo.py`: set `LIVE_VOICE` atau ubah `VOICE_NAME`. Pilihan pria: `Puck`, `Charon`, `Fenrir`, `Orus`, `Algenib`, `Rasalgethi`, `Gacrux`, `Sadaltager`. Ganti voice = sesi Live baru.

## Avatar santri

Web tampilkan avatar kartun santri putra (peci hitam, baju koko putih) di atas log chat.
Mulut gerak ikut level suara Gemini (RMS PCM 24kHz). Status: Santai (idle + kedip),
Mendengar (mic aktif), Bicara (audio/transkrip model masuk). Toggle Avatar sembunyikan
panel tanpa reload, pilihan tersimpan di `live_avatar`. Ini visual lokal canvas 2D,
bukan video generatif Google. Server tak berubah.

## Podcast live dual avatar

Studio podcast: host pria + guest wanita, masing-masing 1 sesi Live Audio
(`client.aio.live.connect`), key berbeda per avatar. Relay utama forward
audio PCM antar sesi (24kHz -> resample 16kHz, half-duplex). Bukan TTS.

```bash
cp .env.example .env  # isi GEMINI_API_KEY_HOST + GEMINI_API_KEY_GUEST
pip install -r requirements.txt  # butuh ffmpeg sistem untuk export MP4
python server.py
# buka http://localhost:8000 -> tab Podcast
```

- Isi topik, pilih suara host/guest, klik Mulai. Timer maks 10 menit,
  host beri penutup otomatis 30 detik terakhir, lalu sesi ditutup.
- Tombol Stop akhiri manual. Setelah selesai muncul link Unduh MP4
  (`GET /export/{pid}`), render server-side: WAV campur + frame avatar
  + subtitle via ffmpeg (h264 + aac).
- Key: `GEMINI_API_KEY_HOST` (host), `GEMINI_API_KEY_GUEST` (guest),
  fallback `GEMINI_API_KEYS=k1,k2` lalu `GEMINI_API_KEY` lama.
  Saat 429/quota, otomatis coba key cadangan. Isi key tak pernah di-log.
- Voice tidak bisa ganti mid-session, jadi 2 sesi paralel wajib.
  Default host `Charon`, guest `Kore` (env `LIVE_VOICE_HOST/GUEST`).
- File export tersimpan di `exports/` (gitignored).
- Stereo opsional: `PODCAST_STEREO=1` pisah host kiri / guest kanan.
