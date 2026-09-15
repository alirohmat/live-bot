/* Web live chat: mic 16kHz -> server, audio 24kHz <- server. */

const log = document.getElementById("log");
const tabAvatar = document.getElementById("tabAvatar");
const tabText = document.getElementById("tabText");
const statusEl = document.getElementById("status");
const form = document.getElementById("form");
const input = document.getElementById("input");
const micBtn = document.getElementById("micBtn");
const stopBtn = document.getElementById("stopBtn");
const searchBox = document.getElementById("searchBox");
const voiceBox = document.getElementById("voiceBox");
const avatarCanvas = document.getElementById("avatar");
const avatarStateEl = document.getElementById("avatarState");
const avatarToggle = document.getElementById("avatarToggle");
const avatarPanel = document.getElementById("avatarPanel");

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

let activeTab = localStorage.getItem("live_tab") || "avatar";
function applyTab() {
  document.body.dataset.tab = activeTab;
  if (tabAvatar) tabAvatar.classList.toggle("active", activeTab === "avatar");
  if (tabText) tabText.classList.toggle("active", activeTab === "text");
  if (activeTab === "avatar" && typeof applyAvatarToggle === "function") applyAvatarToggle();
}
if (tabAvatar) tabAvatar.addEventListener("click", () => { activeTab = "avatar"; localStorage.setItem("live_tab", "avatar"); applyTab(); });
if (tabText) tabText.addEventListener("click", () => { activeTab = "text"; localStorage.setItem("live_tab", "text"); applyTab(); });

let ws = null;
let reconnectTimer = null;
let audioCtx = null;
let micStream = null;
let micProc = null;
let playCursor = 0;
let modelLine = null;

/* Avatar santri: canvas 2D, lip-sync ikut suara terdengar. */
let avatarMode = "idle"; // idle | listening | speaking
let avatarLevel = 0; // fallback saat analyser tak ada
let avatarMouth = 0;
let avatarBlinkAt = 0;
let avatarAnalyser = null;
let avatarWave = null;
let avatarQueue = []; // {start, end, level} jadwal suara terdengar
let avatarSpeakingUntil = 0;
let avatarOn = localStorage.getItem("live_avatar") !== "0";
const AVATAR_LABEL = { idle: "Santai", listening: "Mendengar", speaking: "Bicara" };

function setAvatarMode(m) {
  avatarMode = m;
  if (avatarStateEl) avatarStateEl.textContent = AVATAR_LABEL[m] || m;
}

function drawSantri(now) {
  if (!avatarCanvas || !avatarOn) return;
  const ctx = avatarCanvas.getContext("2d");
  const W = avatarCanvas.width, H = avatarCanvas.height;
  const t = now / 1000;
  // level ikut suara yang SEDANG terdengar: analyser live, fallback antre jadwal
  let heard = 0;
  if (avatarAnalyser && avatarWave) {
    avatarAnalyser.getByteTimeDomainData(avatarWave);
    let s = 0;
    for (let i = 0; i < avatarWave.length; i += 2) { const v = (avatarWave[i] - 128) / 128; s += v * v; }
    heard = Math.min(1, Math.sqrt(s / (avatarWave.length / 2)) * 4);
  } else {
    const nowS = audioCtx ? audioCtx.currentTime : t;
    for (const q of avatarQueue) {
      if (nowS >= q.start && nowS <= q.end) { heard = Math.max(heard, q.level); }
    }
    avatarQueue = avatarQueue.filter((q) => q.end > nowS - 0.1);
  }
  heard = Math.max(heard, avatarLevel);
  avatarLevel *= 0.7;
  // buka cepat, tutup lambat agar hidup
  const k = heard > avatarMouth ? 0.6 : 0.25;
  avatarMouth += (heard - avatarMouth) * k;
  if (avatarMouth < 0.01) avatarMouth = 0;
  // tahan speaking selama antre suara belum habis
  if (avatarMode === "speaking" && performance.now() > avatarSpeakingUntil && heard < 0.05) {
    setAvatarMode("idle");
  }
  const speaking = avatarMode === "speaking";
  // gerak kalem: napas halus, angguk kecil, beda fase idle vs speaking
  const breath = Math.sin(t * 1.4) * 1.8;
  const bob = Math.sin(t * 1.8) * 1.2 + (speaking ? Math.sin(t * 6.5) * 1.5 + Math.sin(t * 11.3) * 0.6 : Math.sin(t * 0.8) * 0.8);
  const sway = Math.sin(t * 0.7) * 1;
  const browLift = speaking ? Math.min(3, avatarMouth * 6) : 0;
  if (avatarBlinkAt === 0) avatarBlinkAt = t + 3 + Math.random() * 3;
  let blink = 0;
  if (t >= avatarBlinkAt) {
    blink = 1;
    if (t > avatarBlinkAt + 0.12) avatarBlinkAt = t + 3 + Math.random() * 3;
  }
  ctx.clearRect(0, 0, W, H);
  const vg = ctx.createRadialGradient(W/2, H*0.42, H*0.15, W/2, H*0.5, H*0.62);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(4,8,18,0.35)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2 + sway, 128 + bob + breath * 0.4);
  // badan: koko putih hangat + bayangan lembut
  ctx.fillStyle = "#f8fafc";
  ctx.beginPath();
  ctx.moveTo(-72, 132); ctx.lineTo(-52, 40); ctx.quadraticCurveTo(0, 24, 52, 40);
  ctx.lineTo(72, 132); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 2; ctx.stroke();
  // kerah koko + bayangan bawah kerah
  ctx.fillStyle = "#eef2f7";
  ctx.beginPath();
  ctx.moveTo(-18, 36); ctx.lineTo(0, 56); ctx.lineTo(18, 36);
  ctx.lineTo(10, 30); ctx.lineTo(0, 40); ctx.lineTo(-10, 30); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1.5; ctx.stroke();
  // kancing
  ctx.fillStyle = "#64748b";
  [66, 82, 98].forEach((y) => { ctx.beginPath(); ctx.arc(0, y, 3, 0, 7); ctx.fill(); });
  // leher
  ctx.fillStyle = "#dfa26e";
  ctx.fillRect(-14, 14, 28, 26);
  // kepala: kulit teduh, outline tipis senada
  ctx.fillStyle = "#eebd85";
  ctx.beginPath(); ctx.ellipse(0, -38, 46, 54, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = "#c98d54"; ctx.lineWidth = 1.5; ctx.stroke();
  // pipi semburat tipis
  ctx.fillStyle = "rgba(224,122,95,0.25)";
  ctx.beginPath(); ctx.ellipse(-26, -22, 9, 6, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(26, -22, 9, 6, 0, 0, 7); ctx.fill();
  // telinga
  ctx.fillStyle = "#eebd85";
  ctx.beginPath(); ctx.ellipse(-46, -34, 7, 11, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(46, -34, 7, 11, 0, 0, 7); ctx.fill();
  // peci pas: duduk rendah, highlight + bayangan bawah
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath(); ctx.ellipse(0, -72, 40, 6, 0, 0, 7); ctx.fill();
  ctx.fillStyle = "#1c2433";
  ctx.beginPath(); ctx.ellipse(0, -80, 40, 22, 0, Math.PI, 0); ctx.fill();
  ctx.fillRect(-40, -82, 80, 10);
  ctx.fillStyle = "#2b3648";
  ctx.beginPath(); ctx.ellipse(-11, -91, 13, 4.5, -0.25, 0, 7); ctx.fill();
  // alis (naik saat bicara)
  ctx.strokeStyle = "#4a3527"; ctx.lineWidth = 2; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-30, -52 - browLift); ctx.lineTo(-10, -54 - browLift); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(10, -54 - browLift); ctx.lineTo(30, -52 - browLift); ctx.stroke();
  // mata (blink = garis)
  if (blink) {
    ctx.strokeStyle = "#1f2937"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-30, -40); ctx.lineTo(-12, -40); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(12, -40); ctx.lineTo(30, -40); ctx.stroke();
  } else {
    ctx.fillStyle = "#232a35";
    ctx.beginPath(); ctx.arc(-22, -40, 5, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(22, -40, 5, 0, 7); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(-20.5, -41.5, 1.6, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(23.5, -41.5, 1.6, 0, 7); ctx.fill();
  }
  // hidung
  ctx.strokeStyle = "#b97a45"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -32); ctx.quadraticCurveTo(3, -22, -2, -18); ctx.stroke();
  // mulut 3 bentuk: tutup / setengah / buka, gigi atas saat buka lebar
  const open = Math.min(1, Math.max(0, avatarMouth));
  const mw = 8 + open * 5;
  const mh = open < 0.25 ? 2.5 + open * 5 : open < 0.6 ? 3.7 + open * 9 : 6 + open * 9;
  ctx.fillStyle = "#7c2d12";
  ctx.beginPath(); ctx.ellipse(0, 0, mw, mh, 0, 0, 7); ctx.fill();
  if (open > 0.45) {
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.ellipse(0, -mh + 3, mw * 0.7, 2.5, 0, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function avatarLoop(now) {
  drawSantri(now || performance.now());
  if (avatarOn) requestAnimationFrame(avatarLoop);
}

function applyAvatarToggle() {
  if (avatarToggle) avatarToggle.checked = avatarOn;
  if (avatarPanel) avatarPanel.classList.toggle("hidden", !avatarOn);
  if (avatarOn) requestAnimationFrame(avatarLoop);
}
if (avatarToggle) {
  avatarToggle.checked = avatarOn;
  avatarToggle.addEventListener("change", () => {
    avatarOn = avatarToggle.checked;
    localStorage.setItem("live_avatar", avatarOn ? "1" : "0");
    applyAvatarToggle();
  });
}
applyAvatarToggle();

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
      setAvatarMode("speaking");
    } else if (pkt.type === "turn_complete") {
      modelLine = null;
      setAvatarMode("idle");
    } else if (pkt.type === "sources") {
      addSources(pkt.items || []);
    } else if (pkt.type === "audio") {
      setAvatarMode("speaking");
      playPcm24k(pkt.data);
    }
  };

  ws.onclose = () => {
    statusEl.textContent = "Koneksi putus. Menyambung ulang...";
    setAvatarMode("idle");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch (e) {}
  };
}

applyTab();
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
  let sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i] / 32768; sum += v * v; }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const out = audioCtx.createBuffer(1, samples.length, 24000);
  const ch = out.getChannelData(0);
  for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
  const src = audioCtx.createBufferSource();
  src.buffer = out;
  if (!avatarAnalyser) {
    try {
      avatarAnalyser = audioCtx.createAnalyser();
      avatarAnalyser.fftSize = 1024;
      avatarAnalyser.connect(audioCtx.destination);
      avatarWave = new Uint8Array(avatarAnalyser.fftSize);
    } catch (e) { avatarAnalyser = null; }
  }
  if (avatarAnalyser) src.connect(avatarAnalyser);
  else src.connect(audioCtx.destination);
  const now = Math.max(audioCtx.currentTime, playCursor);
  src.start(now);
  playCursor = now + out.duration;
  avatarQueue.push({ start: now, end: now + out.duration, level: Math.min(1, rms * 4) });
  avatarLevel = Math.min(1, rms * 4);
  avatarSpeakingUntil = performance.now() + out.duration * 1000 + 400;
  setAvatarMode("speaking");
  stopBtn.disabled = false;
}

stopBtn.addEventListener("click", () => {
  // hentikan audio yang sedang antre dengan menutup konteks
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  playCursor = 0;
  avatarLevel = 0;
  avatarQueue = [];
  setAvatarMode("idle");
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
  setAvatarMode("listening");
  statusEl.textContent = "Mic aktif. Bicara saja...";
});
