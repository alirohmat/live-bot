import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";
import { GoogleGenAI, Modality } from "@google/genai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || "3000", 10);
const STATIC_DIR = path.join(__dirname, "static");

// Model configuration
const LIVE_MODEL_PRIMARY = "gemini-2.5-flash-native-audio-preview-12-2025";
const LIVE_MODEL_FALLBACK = "gemini-3.8-live";
const TEXT_MODEL = "gemini-3.8-flash";
const TTS_MODEL = "gemini-3.1-flash-tts-preview";

function getApiKey(slot: "host" | "guest" | "single"): string {
  if (slot === "host") {
    return process.env.GEMINI_API_KEY_HOST || process.env.GEMINI_API_KEY || "";
  }
  if (slot === "guest") {
    return process.env.GEMINI_API_KEY_GUEST || process.env.GEMINI_API_KEY || "";
  }
  return process.env.GEMINI_API_KEY || "";
}

function createGenAI(slot: "host" | "guest" | "single" = "single"): GoogleGenAI | null {
  const key = getApiKey(slot);
  if (!key) return null;
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

const app = express();
app.use(express.json());

// Serve static frontend files
app.use("/static", express.static(STATIC_DIR));

// Index route
app.get("/", (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

// Export status stubs
app.get("/export_status/:pid", (req, res) => {
  res.json({ ok: true, ready: false, turns: 0, running: false, message: "Export MP4 sementara nonaktif" });
});

app.get("/export/:pid", (req, res) => {
  res.status(404).json({ ok: false, error: "Render MP4 nonaktif di cloud runtime." });
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_HOST),
    model: LIVE_MODEL_PRIMARY,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Podcast Session Manager
interface PodcastSession {
  pid: string;
  clientId: string;
  topic: string;
  hostVoice: string;
  guestVoice: string;
  maxMinutes: number;
  enableSearch: boolean;
  running: boolean;
  speaker: "host" | "guest";
  turns: number;
  history: Array<{ speaker: "host" | "guest"; text: string }>;
  clientWs: WebSocket;
  stopRequested: boolean;
}

const activePodcasts = new Map<string, PodcastSession>();

async function generateTtsAudio(ai: GoogleGenAI, text: string, voiceName: string): Promise<string | null> {
  try {
    const response = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        return part.inlineData.data;
      }
    }
    return null;
  } catch (err) {
    console.warn("TTS generation error:", err);
    return null;
  }
}

async function runPodcastLoop(session: PodcastSession) {
  const hostAi = createGenAI("host") || createGenAI("single");
  const guestAi = createGenAI("guest") || createGenAI("single");

  if (!hostAi || !guestAi) {
    session.clientWs.send(
      JSON.stringify({
        type: "status",
        text: "Kunci API GEMINI_API_KEY belum terpasang di Secrets / .env.",
      })
    );
    return;
  }

  session.clientWs.send(
    JSON.stringify({
      type: "podcast_started",
      pid: session.pid,
      topic: session.topic,
    })
  );

  session.clientWs.send(
    JSON.stringify({
      type: "status",
      text: `Podcast dimulai! Host: ${session.hostVoice} & Guest: ${session.guestVoice}${session.enableSearch ? " (🔍 Google Search Grounding Aktif)" : ""}.`,
    })
  );

  const startTime = Date.now();
  const maxDurationMs = session.maxMinutes * 60 * 1000;

  // Let's try native Live audio first
  let useLiveApi = true;
  let hostLiveSession: any = null;
  let guestLiveSession: any = null;

  try {
    const hostSys = `Kamu adalah Host podcast pria berbahasa Indonesia bernama Rama.
Bicara hangat, santai, berwawasan luas, dan alami layaknya podcast populer.
Pandu alur obrolan dengan antusias, sambut guest wanita (Maya), dan lemparkan pertanyaan atau pandangan menarik.
Jawab dan bicara dalam 2-4 kalimat setiap giliran.`;

    const guestSys = `Kamu adalah Guest podcast wanita berbahasa Indonesia bernama Maya.
Bicara ramah, santai, cerdas, artikulatif, dan penuh wawasan.
Tanggapi pertanyaan atau sudut pandang host (Rama), tambahkan opini atau fakta menarik, lalu lempar balik obrolan ke Rama.
Jawab dan bicara dalam 2-4 kalimat setiap giliran.`;

    // Try connecting Live API for Host
    try {
      hostLiveSession = await (hostAi as any).live?.connect({
        model: LIVE_MODEL_PRIMARY,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: session.hostVoice } },
          },
          systemInstruction: hostSys,
          outputAudioTranscription: {},
        },
      });
    } catch (e1) {
      // Try fallback live model
      try {
        hostLiveSession = await (hostAi as any).live?.connect({
          model: LIVE_MODEL_FALLBACK,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: session.hostVoice } },
            },
            systemInstruction: hostSys,
            outputAudioTranscription: {},
          },
        });
      } catch (e2) {
        useLiveApi = false;
      }
    }

    if (hostLiveSession) {
      try {
        guestLiveSession = await (guestAi as any).live?.connect({
          model: LIVE_MODEL_PRIMARY,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: session.guestVoice } },
            },
            systemInstruction: guestSys,
            outputAudioTranscription: {},
          },
        });
      } catch {
        try {
          guestLiveSession = await (guestAi as any).live?.connect({
            model: LIVE_MODEL_FALLBACK,
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: session.guestVoice } },
              },
              systemInstruction: guestSys,
              outputAudioTranscription: {},
            },
          });
        } catch {
          useLiveApi = false;
        }
      }
    }
  } catch {
    useLiveApi = false;
  }

  // Podcast Dialogue Engine (supporting both Live streaming & Robust Turn-by-Turn with TTS)
  while (session.running && !session.stopRequested) {
    if (Date.now() - startTime >= maxDurationMs) {
      session.clientWs.send(
        JSON.stringify({
          type: "status",
          text: "Waktu podcast selesai (mencapai batas durasi).",
        })
      );
      break;
    }

    if (session.turns >= 50) {
      session.clientWs.send(
        JSON.stringify({
          type: "status",
          text: "Podcast selesai (mencapai 50 giliran dialog).",
        })
      );
      break;
    }

    const currentSpeaker = session.speaker;
    const isHost = currentSpeaker === "host";
    const voiceName = isHost ? session.hostVoice : session.guestVoice;
    const currentAi = isHost ? hostAi : guestAi;

    // Construct prompt for current turn
    let prompt = "";
    if (session.turns === 0) {
      prompt = `Topik podcast hari ini: "${session.topic}".
Kamu adalah Host pria (Rama). Sapa pendengar dengan hangat dan ceria, perkenalkan topik podcast secara menarik dan singkat, lalu perkenalkan serta sambut bintang tamu kita, Maya. Berbicaralah santai dalam 2-3 kalimat.`;
    } else {
      const recentHistory = session.history.slice(-6);
      const lastMessage = recentHistory[recentHistory.length - 1];
      const otherSpeakerName = isHost ? "Maya (Guest)" : "Rama (Host)";
      const myName = isHost ? "Rama (Host)" : "Maya (Guest)";

      prompt = `Topik podcast: "${session.topic}".
Kamu adalah ${myName}. Lawan bicaramu ${otherSpeakerName} baru saja berkata:
"${lastMessage.text}"

Tanggapi perkataan tersebut secara alami, menarik, cerdas, dan santai (2-3 kalimat). Teruskan alur dialog dengan hangat.`;
    }

    try {
      // Step 1: Generate text response (Streamed to client for instant avatar reaction)
      let turnText = "";
      const searchTools = session.enableSearch ? [{ googleSearch: {} }] : undefined;
      const streamResponse = await currentAi.models.generateContentStream({
        model: TEXT_MODEL,
        contents: prompt,
        config: {
          systemInstruction: isHost
            ? "Kamu adalah Rama, host podcast pria Indonesia yang hangat, bersahabat, cerdas, dan komunikatif. Jawab hanya teks percakapan tanpa tanda kurung deskripsi atau nama pembicara."
            : "Kamu adalah Maya, guest podcast wanita Indonesia yang ramah, santai, berwawasan luas, dan artikulatif. Jawab hanya teks percakapan tanpa tanda kurung deskripsi atau nama pembicara.",
          temperature: 0.85,
          tools: searchTools,
        },
      });

      const collectedSources: Array<{ title: string; url: string }> = [];

      for await (const chunk of streamResponse) {
        if (!session.running || session.stopRequested) break;
        const textChunk = chunk.text || "";
        if (textChunk) {
          turnText += textChunk;
          session.clientWs.send(
            JSON.stringify({
              type: "transcript_out",
              avatar: currentSpeaker,
              text: textChunk,
            })
          );
        }

        // Collect grounding metadata from Google Search
        const candidates = (chunk as any).candidates;
        const grounding = candidates?.[0]?.groundingMetadata;
        if (grounding?.groundingChunks) {
          for (const gc of grounding.groundingChunks) {
            if (gc.web?.uri) {
              collectedSources.push({
                title: gc.web.title || gc.web.uri,
                url: gc.web.uri,
              });
            }
          }
        }
      }

      if (collectedSources.length > 0) {
        const uniqueSources = Array.from(new Map(collectedSources.map((s) => [s.url, s])).values());
        session.clientWs.send(
          JSON.stringify({
            type: "sources",
            items: uniqueSources,
          })
        );
      }

      const cleanText = turnText.trim();
      if (!cleanText) {
        // Fallback text if stream empty
        turnText = isHost
          ? `Topik "${session.topic}" ini sangat menarik untuk kita bahas bersama.`
          : `Betul sekali, dan ini memiliki banyak sudut pandang menarik yang patut kita cermati.`;
        session.clientWs.send(
          JSON.stringify({
            type: "transcript_out",
            avatar: currentSpeaker,
            text: turnText,
          })
        );
      }

      session.history.push({ speaker: currentSpeaker, text: turnText });

      // Step 2: Generate high-fidelity 24kHz Native Audio via Gemini TTS
      const audioB64 = await generateTtsAudio(currentAi, turnText, voiceName);
      if (audioB64 && session.running && !session.stopRequested) {
        session.clientWs.send(
          JSON.stringify({
            type: "audio",
            avatar: currentSpeaker,
            mime_type: "audio/pcm;rate=24000",
            data: audioB64,
          })
        );
      }

      // Step 3: Turn Complete notification
      session.clientWs.send(
        JSON.stringify({
          type: "turn_complete",
          avatar: currentSpeaker,
        })
      );

      session.turns += 1;

      // Estimate audio duration so turns don't collide
      // Raw PCM 24kHz 16-bit mono = 48,000 bytes per second
      let estimatedDurationMs = 2800;
      if (audioB64) {
        const byteLength = Buffer.from(audioB64, "base64").length;
        estimatedDurationMs = Math.min(18000, Math.max(2200, (byteLength / 48000) * 1000 + 400));
      } else {
        estimatedDurationMs = Math.min(8000, Math.max(2500, turnText.length * 70));
      }

      // Switch turn to the other avatar
      session.speaker = isHost ? "guest" : "host";

      // Wait for audio playback to finish comfortably before the next turn speaks
      const waitInterval = 100;
      let waited = 0;
      while (waited < estimatedDurationMs && session.running && !session.stopRequested) {
        await new Promise((r) => setTimeout(r, waitInterval));
        waited += waitInterval;
      }
    } catch (turnErr: any) {
      console.error("Turn error in podcast loop:", turnErr);
      session.clientWs.send(
        JSON.stringify({
          type: "status",
          text: `Dialog ${currentSpeaker}: ${turnErr.message || turnErr}`,
        })
      );
      // Wait a bit and try next turn
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Cleanup sessions
  if (hostLiveSession?.close) {
    try { hostLiveSession.close(); } catch {}
  }
  if (guestLiveSession?.close) {
    try { guestLiveSession.close(); } catch {}
  }

  session.running = false;
  activePodcasts.delete(session.pid);

  session.clientWs.send(
    JSON.stringify({
      type: "podcast_stopped",
      pid: session.pid,
      text: session.stopRequested ? "Podcast dihentikan oleh pengguna." : "Podcast selesai.",
    })
  );
}

// Single Live Chat Session Manager
async function handleSingleLiveChat(ws: WebSocket, search: boolean, voiceName: string, clientId: string) {
  const ai = createGenAI("single");
  if (!ai) {
    ws.send(JSON.stringify({ type: "status", text: "GEMINI_API_KEY belum dikonfigurasi di server." }));
    return;
  }

  const searchInfo = search ? " + Google Search Grounding Aktif" : "";
  ws.send(JSON.stringify({
    type: "status",
    text: `Terhubung ke Gemini (${voiceName}${searchInfo}). Ketik pesan atau gunakan mikrofon.`,
  }));

  ws.on("message", async (raw: string) => {
    try {
      const pkt = JSON.parse(raw.toString());
      if (pkt.type === "text" && pkt.text) {
        const userPrompt = pkt.text.trim();
        let replyText = "";
        const searchTools = search ? [{ googleSearch: {} }] : undefined;

        const stream = await ai.models.generateContentStream({
          model: TEXT_MODEL,
          contents: userPrompt,
          config: {
            systemInstruction: "Kamu asisten suara berbahasa Indonesia yang ramah, ringkas, cerdas, dan faktual. Jawab dalam 2-3 kalimat santai.",
            tools: searchTools,
          },
        });

        const collectedSources: Array<{ title: string; url: string }> = [];

        for await (const chunk of stream) {
          const t = chunk.text || "";
          if (t) {
            replyText += t;
            ws.send(JSON.stringify({ type: "transcript_out", text: t }));
          }

          const candidates = (chunk as any).candidates;
          const grounding = candidates?.[0]?.groundingMetadata;
          if (grounding?.groundingChunks) {
            for (const gc of grounding.groundingChunks) {
              if (gc.web?.uri) {
                collectedSources.push({
                  title: gc.web.title || gc.web.uri,
                  url: gc.web.uri,
                });
              }
            }
          }
        }

        if (collectedSources.length > 0) {
          const uniqueSources = Array.from(new Map(collectedSources.map((s) => [s.url, s])).values());
          ws.send(JSON.stringify({ type: "sources", items: uniqueSources }));
        }

        if (replyText) {
          const audioB64 = await generateTtsAudio(ai, replyText, voiceName);
          if (audioB64) {
            ws.send(JSON.stringify({
              type: "audio",
              mime_type: "audio/pcm;rate=24000",
              data: audioB64,
            }));
          }
        }

        ws.send(JSON.stringify({ type: "turn_complete" }));
      }
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "status", text: `Error: ${e.message || e}` }));
    }
  });
}

// WebSocket Dispatcher
wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost:3000"}`);
  const pathname = url.pathname;
  const clientId = url.searchParams.get("client") || `c-${Math.random().toString(36).slice(2, 8)}`;
  const search = url.searchParams.get("search") === "1";
  const voice = url.searchParams.get("voice") || "Charon";
  const hostVoice = url.searchParams.get("host_voice") || "Charon";
  const guestVoice = url.searchParams.get("guest_voice") || "Kore";
  const maxMinutes = parseFloat(url.searchParams.get("max_minutes") || "10");

  if (pathname === "/ws_podcast") {
    let currentSession: PodcastSession | null = null;

    ws.on("message", async (msgData) => {
      try {
        const pkt = JSON.parse(msgData.toString());
        if (pkt.type === "podcast_start") {
          if (currentSession && currentSession.running) {
            currentSession.stopRequested = true;
            currentSession.running = false;
          }

          const topic = (pkt.topic || "").trim() || "Masa Depan Kecerdasan Buatan & Robotika";
          const hv = pkt.host_voice || hostVoice;
          const gv = pkt.guest_voice || guestVoice;
          const mm = pkt.max_minutes || maxMinutes;
          const enableSearch = typeof pkt.enable_search === "boolean" ? pkt.enable_search : search;
          const pid = `${clientId}-${Date.now()}`;

          currentSession = {
            pid,
            clientId,
            topic,
            hostVoice: hv,
            guestVoice: gv,
            maxMinutes: mm,
            enableSearch,
            running: true,
            speaker: "host",
            turns: 0,
            history: [],
            clientWs: ws,
            stopRequested: false,
          };

          activePodcasts.set(pid, currentSession);
          runPodcastLoop(currentSession);
        } else if (pkt.type === "podcast_stop") {
          if (currentSession) {
            currentSession.stopRequested = true;
            currentSession.running = false;
          }
        }
      } catch (err) {
        console.error("Error parsing WS podcast message:", err);
      }
    });

    ws.on("close", () => {
      if (currentSession) {
        currentSession.stopRequested = true;
        currentSession.running = false;
      }
    });
  } else {
    // Default Live endpoint
    handleSingleLiveChat(ws, search, voice, clientId);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini 2 Avatar Podcast server running on http://0.0.0.0:${PORT}`);
});
