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
let livePaused = false; // true saat tab podcast aktif: hemat RPM, jangan auto-connect
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
  // Visualizer Aura / Pulse effect saat Listening or Speaking
  if (avatarMode === "listening" || avatarMode === "speaking") {
    const isListening = avatarMode === "listening";
    const pulseCount = isListening ? 3 : 2;
    const baseColor = isListening ? "34, 197, 94" : "56, 189, 248"; // Green vs Cyan
    const energy = isListening ? 0.3 + Math.sin(t * 4) * 0.15 : avatarMouth * 0.8;

    for (let i = pulseCount; i >= 1; i--) {
      const radius = 100 + i * 25 + energy * 30;
      const alpha = (0.25 / i) * (isListening ? (0.6 + Math.sin(t * 3) * 0.4) : Math.min(1, energy + 0.2));
      const pulseGrad = ctx.createRadialGradient(W / 2, H / 2 - 20, radius * 0.4, W / 2, H / 2 - 20, radius);
      pulseGrad.addColorStop(0, `rgba(${baseColor}, ${alpha * 0.8})`);
      pulseGrad.addColorStop(0.7, `rgba(${baseColor}, ${alpha * 0.3})`);
      pulseGrad.addColorStop(1, `rgba(${baseColor}, 0)`);

      ctx.fillStyle = pulseGrad;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2 - 20, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.save();
  ctx.translate(W / 2 + sway, 138 + bob + breath * 0.4);

  // 1. Bayangan Jatuh (Drop Shadow bawah)
  const shadowGrad = ctx.createRadialGradient(0, 160, 10, 0, 160, 90);
  shadowGrad.addColorStop(0, "rgba(0, 0, 0, 0.35)");
  shadowGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = shadowGrad;
  ctx.beginPath();
  ctx.ellipse(0, 160, 85, 20, 0, 0, Math.PI * 2);
  ctx.fill();

  // 2. Badan & Baju Koko Premium (Gradien & Detail Jahitan)
  const kokoGrad = ctx.createLinearGradient(-75, 40, 75, 160);
  kokoGrad.addColorStop(0, "#ffffff");
  kokoGrad.addColorStop(0.5, "#f1f5f9");
  kokoGrad.addColorStop(1, "#cbd5e1");

  ctx.fillStyle = kokoGrad;
  ctx.beginPath();
  ctx.moveTo(-78, 160);
  ctx.lineTo(-56, 38);
  ctx.quadraticCurveTo(0, 22, 56, 38);
  ctx.lineTo(78, 160);
  ctx.closePath();
  ctx.fill();

  // Lipatan Baju Koko (Shading halus)
  ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-42, 60); ctx.quadraticCurveTo(-35, 110, -50, 160);
  ctx.moveTo(42, 60); ctx.quadraticCurveTo(35, 110, 50, 160);
  ctx.moveTo(0, 56); ctx.lineTo(0, 160);
  ctx.stroke();

  // Kerah Koko Berlapis (Mandarin Collar)
  const collarGrad = ctx.createLinearGradient(-25, 25, 25, 55);
  collarGrad.addColorStop(0, "#ffffff");
  collarGrad.addColorStop(1, "#e2e8f0");
  ctx.fillStyle = collarGrad;
  ctx.beginPath();
  ctx.moveTo(-22, 36);
  ctx.lineTo(0, 58);
  ctx.lineTo(22, 36);
  ctx.lineTo(14, 28);
  ctx.lineTo(0, 42);
  ctx.lineTo(-14, 28);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Kancing Koko (Detail Emas / Mutiara Mewah)
  [68, 88, 108, 128].forEach((y) => {
    const buttonGrad = ctx.createRadialGradient(-1, y - 1, 0.5, 0, y, 4);
    buttonGrad.addColorStop(0, "#fbbf24");
    buttonGrad.addColorStop(0.7, "#d97706");
    buttonGrad.addColorStop(1, "#78350f");
    ctx.fillStyle = buttonGrad;
    ctx.beginPath();
    ctx.arc(0, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // 3. Leher dengan Bayangan Dagu
  const neckGrad = ctx.createLinearGradient(0, 10, 0, 42);
  neckGrad.addColorStop(0, "#c68a52"); // Bayangan dagu
  neckGrad.addColorStop(0.35, "#f0be8b");
  neckGrad.addColorStop(1, "#e5aa70");
  ctx.fillStyle = neckGrad;
  ctx.beginPath();
  ctx.roundRect(-16, 12, 32, 30, 8);
  ctx.fill();

  // 4. Kepala & Bentuk Wajah (Kulit Halus dengan Shading Volume)
  const faceGrad = ctx.createRadialGradient(0, -35, 10, 0, -30, 56);
  faceGrad.addColorStop(0, "#ffe3c6");
  faceGrad.addColorStop(0.7, "#f5c396");
  faceGrad.addColorStop(1, "#e0a16d");

  ctx.fillStyle = faceGrad;
  ctx.beginPath();
  ctx.ellipse(0, -36, 48, 56, 0, 0, Math.PI * 2);
  ctx.fill();

  // Outline tipis wajah
  ctx.strokeStyle = "rgba(180, 110, 60, 0.3)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 5. Telinga & Detail Dalam
  [-1, 1].forEach((side) => {
    const earX = side * 48;
    const earGrad = ctx.createRadialGradient(earX, -32, 2, earX, -32, 10);
    earGrad.addColorStop(0, "#f5c396");
    earGrad.addColorStop(1, "#d8935c");
    ctx.fillStyle = earGrad;
    ctx.beginPath();
    ctx.ellipse(earX, -32, 8, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // Dalam telinga
    ctx.strokeStyle = "#c07e4a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(earX - side * 2, -32, 4, 0, Math.PI * 2);
    ctx.stroke();
  });

  // 6. Pipi Bersemu (Blush / Warm Glow)
  const cheekGradLeft = ctx.createRadialGradient(-26, -18, 1, -26, -18, 14);
  cheekGradLeft.addColorStop(0, "rgba(239, 114, 114, 0.35)");
  cheekGradLeft.addColorStop(1, "rgba(239, 114, 114, 0)");
  ctx.fillStyle = cheekGradLeft;
  ctx.beginPath(); ctx.ellipse(-26, -18, 12, 8, 0, 0, Math.PI * 2); ctx.fill();

  const cheekGradRight = ctx.createRadialGradient(26, -18, 1, 26, -18, 14);
  cheekGradRight.addColorStop(0, "rgba(239, 114, 114, 0.35)");
  cheekGradRight.addColorStop(1, "rgba(239, 114, 114, 0)");
  ctx.fillStyle = cheekGradRight;
  ctx.beginPath(); ctx.ellipse(26, -18, 12, 8, 0, 0, Math.PI * 2); ctx.fill();

  // 7. Peci Hitam / Motif Islami Elegan (Peci Santri)
  // Shadow Peci di dahi
  ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
  ctx.beginPath();
  ctx.ellipse(0, -68, 43, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // Badan Peci
  const peciGrad = ctx.createLinearGradient(-42, -96, 42, -66);
  peciGrad.addColorStop(0, "#1e293b");
  peciGrad.addColorStop(0.3, "#0f172a");
  peciGrad.addColorStop(0.7, "#020617");
  peciGrad.addColorStop(1, "#1e293b");

  ctx.fillStyle = peciGrad;
  ctx.beginPath();
  ctx.ellipse(0, -78, 42, 23, 0, Math.PI, 0);
  ctx.fillRect(-42, -80, 84, 12);
  ctx.fill();

  // Mahkota Atas Peci
  ctx.fillStyle = "#020617";
  ctx.beginPath();
  ctx.ellipse(0, -80, 42, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // Motif Emboss/Emas Halus pada Peci
  ctx.strokeStyle = "rgba(217, 119, 6, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-36, -72); ctx.quadraticCurveTo(0, -68, 36, -72);
  ctx.stroke();

  // 8. Alis Ekspresif (Responsive terhadap Mode)
  const listeningBrow = avatarMode === "listening" ? -2 : 0;
  ctx.strokeStyle = "#331e11";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";

  // Alis Kiri
  ctx.beginPath();
  ctx.moveTo(-32, -52 - browLift + listeningBrow);
  ctx.quadraticCurveTo(-20, -57 - browLift, -10, -53 - browLift);
  ctx.stroke();

  // Alis Kanan
  ctx.beginPath();
  ctx.moveTo(10, -53 - browLift);
  ctx.quadraticCurveTo(20, -57 - browLift, 32, -52 - browLift + listeningBrow);
  ctx.stroke();

  // 9. Mata Indah & Hidup (Iris Detail + Multi Highlights)
  const eyeOffset = Math.sin(t * 0.8) * 1.2; // Gerakan mata sangat halus saat melihat sekeliling
  [-22, 22].forEach((eyeX) => {
    if (blink) {
      // Mata Meram / Kedip Mulus
      ctx.strokeStyle = "#27160c";
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(eyeX - 10, -38);
      ctx.quadraticCurveTo(eyeX, -34, eyeX + 10, -38);
      ctx.stroke();
    } else {
      // Mata Putih (Sclera)
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(eyeX, -38, 9, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(60, 30, 10, 0.2)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // Iris Kecokelatan Warm Brown
      const irisGrad = ctx.createRadialGradient(eyeX + eyeOffset, -38, 1, eyeX + eyeOffset, -38, 5.5);
      irisGrad.addColorStop(0, "#1c1008");
      irisGrad.addColorStop(0.6, "#4a2810");
      irisGrad.addColorStop(1, "#1a0d05");

      ctx.fillStyle = irisGrad;
      ctx.beginPath();
      ctx.arc(eyeX + eyeOffset, -38, 5.5, 0, Math.PI * 2);
      ctx.fill();

      // Pupil
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(eyeX + eyeOffset, -38, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Catchlight / Kilau Mata (Double Catchlight untuk efek Anime/3D)
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(eyeX + eyeOffset - 1.8, -40, 1.8, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(eyeX + eyeOffset + 1.8, -36.5, 0.9, 0, Math.PI * 2);
      ctx.fill();

      // Kelopak Mata Atas (Eyeliner)
      ctx.strokeStyle = "#27160c";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(eyeX, -38, 9, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    }
  });

  // 10. Hidung dengan Dimensi Soft Shadow
  ctx.strokeStyle = "#c8854c";
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-1, -31);
  ctx.quadraticCurveTo(3, -21, -2, -18);
  ctx.quadraticCurveTo(1, -16, 4, -18);
  ctx.stroke();

  // 11. Mulut Expressive & Fluid Lip-Sync Morphing
  const open = Math.min(1, Math.max(0, avatarMouth));
  ctx.save();
  ctx.translate(0, -3);

  if (open < 0.05) {
    // Mulut Senyum Manis Mulus saat Idle/Tutup
    ctx.strokeStyle = "#7c2d12";
    ctx.lineWidth = 2.8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-10, -2);
    ctx.quadraticCurveTo(0, 4, 10, -2);
    ctx.stroke();

    // Garis bibir bawah tipis
    ctx.strokeStyle = "rgba(180, 83, 9, 0.35)";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-6, 3);
    ctx.quadraticCurveTo(0, 6, 6, 3);
    ctx.stroke();
  } else {
    // Mulut Terbuka Dinamis sesuai Level Suara
    const mw = 9 + open * 8;
    const mh = open * 14;

    // Rongga Mulut Dalam
    const mouthGrad = ctx.createLinearGradient(0, -mh / 2, 0, mh / 2);
    mouthGrad.addColorStop(0, "#450a0a");
    mouthGrad.addColorStop(0.5, "#7f1d1d");
    mouthGrad.addColorStop(1, "#991b1b");

    ctx.fillStyle = mouthGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, mw, mh, 0, 0, Math.PI * 2);
    ctx.fill();

    // Gigi Atas Rapih
    if (open > 0.25) {
      ctx.fillStyle = "#f8fafc";
      ctx.beginPath();
      ctx.roundRect(-mw * 0.65, -mh * 0.85, mw * 1.3, Math.min(5, mh * 0.45), [0, 0, 3, 3]);
      ctx.fill();
    }

    // Lidah Halus di Bawah
    if (open > 0.4) {
      ctx.fillStyle = "#f43f5e";
      ctx.beginPath();
      ctx.ellipse(0, mh * 0.45, mw * 0.55, mh * 0.35, 0, Math.PI, 0);
      ctx.fill();
    }

    // Line Bibir Luar
    ctx.strokeStyle = "#7c2d12";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, mw, mh, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

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
    setAvatarMode("idle");
    if (livePaused) {
      statusEl.textContent = "Live dijeda (mode podcast).";
      return;
    }
    statusEl.textContent = "Koneksi putus. Menyambung ulang...";
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch (e) {}
  };
}

function setLiveEnabled(on) {
  livePaused = !on;
  if (on) {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      clearTimeout(reconnectTimer);
      connect();
    }
  } else if (ws && ws.readyState === WebSocket.OPEN) {
    clearTimeout(reconnectTimer);
    livePaused = true;
    try { ws.close(); } catch (e) {}
  } else {
    clearTimeout(reconnectTimer);
  }
}

applyTab();
if ((localStorage.getItem("live_tab") || "avatar") !== "podcast") {
  connect();
} else {
  livePaused = true;
  statusEl.textContent = "Mode podcast. Live dijeda.";
}

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
