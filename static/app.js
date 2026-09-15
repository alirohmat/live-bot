/* Web live chat: mic 16kHz -> server, audio 24kHz <- server. */

const log = document.getElementById("log");
const statusEl = document.getElementById("status");
const form = document.getElementById("form");
const input = document.getElementById("input");
const micBtn = document.getElementById("micBtn");
const stopBtn = document.getElementById("stopBtn");
const searchBox = document.getElementById("searchBox");
const voiceBox = document.getElementById("voiceBox");

let clientId = localStorage.getItem("live_client_id");
if (!clientId) {
  clientId = "c-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("live_client_id", clientId);
}
let useVoice = localStorage.getItem("live_voice") || "Charon";
if (voiceBox) {
  voiceBox.value = useVoice;
  voiceBox.addEventListener("change", () => {
    localStorage.setItem("live_voice", voiceBox.value);
    location.reload();
  });
}
let useSearch = localStorage.getItem("live_search") === "1";
if (searchBox) {
  searchBox.checked = useSearch;
  searchBox.addEventListener("change", () => {
    localStorage.setItem("live_search", searchBox.checked ? "1" : "0");
    location.reload();
  });
}

let ws = null;
let reconnectTimer = null;
let audioCtx = null;
let micStream = null;
let micProc = null;
let playCursor = 0;
let modelLine = null;

function addLine(who, text) {
  const div = document.createElement("div");
  div.className = "msg " + who;
  const b = document.createElement("b");
  b.textContent = who === "kamu" ? "Kamu: " : "Gemini: ";
  div.appendChild(b);
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function appendModel(text) {
  if (!modelLine) modelLine = addLine("gemini", "");
  modelLine.childNodes[1].textContent += text;
  log.scrollTop = log.scrollHeight;
}

function addSources(items) {
  if (!items.length) return;
  const div = document.createElement("div");
  div.className = "msg sources";
  const b = document.createElement("b");
  b.textContent = "Sumber: ";
  div.appendChild(b);
  items.slice(0, 5).forEach((s, i) => {
    if (i > 0) div.appendChild(document.createTextNode(" · "));
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.title || s.url;
    div.appendChild(a);
  });
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function connect() {
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const search = localStorage.getItem("live_search") === "1" ? "1" : "0";
  const voice = localStorage.getItem("live_voice") || "Charon";
  ws = new WebSocket(
    `${wsProto}://${location.host}/ws?client=${clientId}&search=${search}&voice=${voice}`
  );

  ws.onmessage = (ev) => {
    const pkt = JSON.parse(ev.data);
    if (pkt.type === "status") {
      statusEl.textContent = pkt.text;
    } else if (pkt.type === "transcript_in") {
      addLine("kamu", pkt.text);
    } else if (pkt.type === "transcript_out") {
      appendModel(pkt.text);
    } else if (pkt.type === "turn_complete") {
      modelLine = null;
    } else if (pkt.type === "sources") {
      addSources(pkt.items || []);
    } else if (pkt.type === "audio") {
      playPcm24k(pkt.data);
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "Koneksi putus. Menyambung ulang...";
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch (e) {}
  };
}

connect();

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  addLine("kamu", text);
  ws.send(JSON.stringify({ type: "text", text }));
  input.value = "";
});

function playPcm24k(b64) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  const samples = new Int16Array(buf);
  const out = audioCtx.createBuffer(1, samples.length, 24000);
  const ch = out.getChannelData(0);
  for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
  const src = audioCtx.createBufferSource();
  src.buffer = out;
  src.connect(audioCtx.destination);
  const now = Math.max(audioCtx.currentTime, playCursor);
  src.start(now);
  playCursor = now + out.duration;
  stopBtn.disabled = false;
}

stopBtn.addEventListener("click", () => {
  // hentikan audio yang sedang antre dengan menutup konteks
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  playCursor = 0;
  stopBtn.disabled = true;
});

micBtn.addEventListener("click", async () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    statusEl.textContent = "Mic ditolak browser: " + e.message;
    return;
  }
  const src = audioCtx.createMediaStreamSource(micStream);
  // downsample ke 16kHz int16
  const proc = audioCtx.createScriptProcessor(4096, 1, 1);
  const inRate = audioCtx.sampleRate;
  proc.onaudioprocess = (ev) => {
    const ch = ev.inputBuffer.getChannelData(0);
    const step = inRate / 16000;
    const out = [];
    for (let i = 0; i < ch.length; i += step) {
      const s = Math.max(-1, Math.min(1, ch[Math.floor(i)]));
      out.push(s < 0 ? s * 32768 : s * 32767);
    }
    const pcm = new Int16Array(out);
    const bytes = new Uint8Array(pcm.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "audio", data: btoa(bin) }));
    }
  };
  src.connect(proc);
  proc.connect(audioCtx.destination);
  micProc = proc;
  micBtn.textContent = "Mic Aktif";
  micBtn.disabled = true;
  statusEl.textContent = "Mic aktif. Bicara saja...";
});
