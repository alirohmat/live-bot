/* Podcast dual avatar netral modern: host pria + guest wanita via /ws_podcast. */

const VOICES_MALE = ["Charon", "Puck", "Fenrir", "Orus", "Algenib", "Rasalgethi", "Gacrux", "Sadaltager", "Alnilam", "Schedar", "Achernar", "Vindemiatrix", "Autonoe", "Umbriel", "Albiorix"];
const VOICES_FEMALE = ["Kore", "Aoede", "Leda", "Sulafat", "Callirrhoe", "Despina", "Erinome", "Laomedeia", "Achird", "Pulcherrima", "Sadachbia", "Zephyr"];

function fillVoices(sel, list, def) {
  if (!sel) return def;
  sel.innerHTML = "";
  list.forEach(([v, g]) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = `${v} (${g})`;
    sel.appendChild(o);
  });
  sel.value = list.some(([v]) => v === def) ? def : list[0][0];
  return sel.value;
}

const ALL_V = [...VOICES_MALE.map((v) => [v, "pria"]), ...VOICES_FEMALE.map((v) => [v, "wanita"])];
useVoice = fillVoices(voiceBox, ALL_V, localStorage.getItem("live_voice") || "Charon");
localStorage.setItem("live_voice", useVoice);

const hostVoiceSel = document.getElementById("hostVoice");
const guestVoiceSel = document.getElementById("guestVoice");
let hostVoice = fillVoices(hostVoiceSel, VOICES_MALE.map((v) => [v, "pria"]), localStorage.getItem("pod_host_voice") || "Charon");
let guestVoice = fillVoices(guestVoiceSel, VOICES_FEMALE.map((v) => [v, "wanita"]), localStorage.getItem("pod_guest_voice") || "Kore");
if (hostVoiceSel) hostVoiceSel.addEventListener("change", () => { hostVoice = hostVoiceSel.value; localStorage.setItem("pod_host_voice", hostVoice); });
if (guestVoiceSel) guestVoiceSel.addEventListener("change", () => { guestVoice = guestVoiceSel.value; localStorage.setItem("pod_guest_voice", guestVoice); });

/* Tab podcast: bungkus applyTab bawaan. */
const tabPodcast = document.getElementById("tabPodcast");
const podcastPanel = document.getElementById("podcastPanel");
const _baseApplyTab = applyTab;
applyTab = function () {
  _baseApplyTab();
  document.body.dataset.tab = activeTab;
  if (tabPodcast) tabPodcast.classList.toggle("active", activeTab === "podcast");
  if (podcastPanel) podcastPanel.hidden = activeTab !== "podcast";
  if (typeof setLiveEnabled === "function") setLiveEnabled(activeTab !== "podcast");
  if (activeTab === "podcast") requestAnimationFrame(podLoop);
};
if (tabPodcast) tabPodcast.addEventListener("click", () => { activeTab = "podcast"; localStorage.setItem("live_tab", "podcast"); applyTab(); });

/* Avatar netral modern: state lip-sync terpisah per avatar. */
function podState() { return { mode: "idle", level: 0, mouth: 0, blinkAt: 0 }; }
const hostSt = podState();
const guestSt = podState();
const hostCanvas = document.getElementById("hostCanvas");
const guestCanvas = document.getElementById("guestCanvas");
const cardHost = document.getElementById("cardHost");
const cardGuest = document.getElementById("cardGuest");
const podSpeakerEl = document.getElementById("podSpeaker");

function drawPodAvatar(canvas, st, female, now) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const t = now / 1000;
  st.level *= 0.85;
  const k = st.level > st.mouth ? 0.6 : 0.25;
  st.mouth += (st.level - st.mouth) * k;
  if (st.mouth < 0.01) st.mouth = 0;
  if (st.blinkAt === 0) st.blinkAt = t + 2 + Math.random() * 3;
  let blink = false;
  if (t >= st.blinkAt) { blink = true; if (t > st.blinkAt + 0.12) st.blinkAt = t + 2.5 + Math.random() * 3; }
  const bob = Math.sin(t * 1.6) * 2 + (st.mode === "speaking" ? Math.sin(t * 7) * 2 : 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, 150 + bob);
  const speaking = st.mode === "speaking";
  ctx.strokeStyle = speaking ? (female ? "#f472b6" : "#38bdf8") : "rgba(100,116,139,0.5)";
  ctx.lineWidth = speaking ? 5 : 2;
  ctx.beginPath(); ctx.ellipse(0, 40, 120, 170, 0, 0, Math.PI * 2); ctx.stroke();
  // bahu + baju
  ctx.fillStyle = female ? "#78350f" : "#1e3a5f";
  ctx.beginPath();
  ctx.moveTo(-110, 320); ctx.lineTo(-70, 120);
  ctx.quadraticCurveTo(0, 95, 70, 120); ctx.lineTo(110, 320);
  ctx.closePath(); ctx.fill();
  // leher
  ctx.fillStyle = "#e8b088";
  ctx.beginPath(); ctx.roundRect(-20, 55, 40, 40, 10); ctx.fill();
  // wajah
  const fg = ctx.createRadialGradient(0, -30, 10, 0, -30, 60);
  fg.addColorStop(0, "#ffe0c0"); fg.addColorStop(1, "#df9c66");
  ctx.fillStyle = fg;
  ctx.beginPath(); ctx.ellipse(0, -30, 55, 62, 0, 0, Math.PI * 2); ctx.fill();
  // rambut
  ctx.fillStyle = female ? "#5a321e" : "#23232a";
  if (female) {
    ctx.beginPath(); ctx.ellipse(0, -55, 68, 55, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(-68, -55, 16, 110); ctx.fillRect(52, -55, 16, 110);
  } else {
    ctx.beginPath(); ctx.ellipse(0, -62, 56, 30, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(-56, -68, 12, 30); ctx.fillRect(44, -68, 12, 30);
  }
  // mata
  [-24, 24].forEach((x) => {
    if (blink) {
      ctx.strokeStyle = "#2a1608"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - 10, -32); ctx.quadraticCurveTo(x, -28, x + 10, -32); ctx.stroke();
    } else {
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.ellipse(x, -32, 10, 8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#1a0d05";
      ctx.beginPath(); ctx.arc(x, -32, 4.5, 0, Math.PI * 2); ctx.fill();
    }
  });
  // mulut: tutup / buka ikut level
  const open = Math.min(1, Math.max(0, st.mouth));
  if (open < 0.08) {
    ctx.strokeStyle = "#7c2d12"; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-12, 2); ctx.quadraticCurveTo(0, 8, 12, 2); ctx.stroke();
  } else {
    ctx.fillStyle = "#7f1d1d";
    ctx.beginPath(); ctx.ellipse(0, 8, 10 + open * 8, open * 15, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function podLoop(now) {
  drawPodAvatar(hostCanvas, hostSt, false, now || performance.now());
  drawPodAvatar(guestCanvas, guestSt, true, now || performance.now());
  if (activeTab === "podcast" && podcastPanel && !podcastPanel.hidden) requestAnimationFrame(podLoop);
}

function setPodSpeaker(role) {
  hostSt.mode = role === "host" ? "speaking" : "idle";
  guestSt.mode = role === "guest" ? "speaking" : "idle";
  if (cardHost) cardHost.classList.toggle("speaking", role === "host");
  if (cardGuest) cardGuest.classList.toggle("speaking", role === "guest");
  if (podSpeakerEl) podSpeakerEl.textContent = role === "host" ? "HOST bicara" : role === "guest" ? "GUEST bicara" : "siap";
}

function playPodAudio(b64, role) {
  if (typeof audioCtx === "undefined" || !audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
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
  src.connect(audioCtx.destination);
  const now = Math.max(audioCtx.currentTime, (typeof playCursor !== "undefined" ? playCursor : 0));
  src.start(now);
  if (typeof playCursor !== "undefined") playCursor = now + out.duration;
  const st = role === "guest" ? guestSt : hostSt;
  st.level = Math.min(1, rms * 4);
  setPodSpeaker(role);
}

/* Subtitle per speaker. */
const podLines = { host: null, guest: null };
function podAppend(role, text) {
  const label = role === "guest" ? "Guest: " : "Host: ";
  if (!podLines[role]) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    const b = document.createElement("b");
    b.textContent = label;
    div.appendChild(b);
    div.appendChild(document.createTextNode(text));
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    podLines[role] = div;
  } else {
    podLines[role].childNodes[1].textContent += text;
    log.scrollTop = log.scrollHeight;
  }
}

/* WS podcast + timer 10 menit. */
let pws = null;
let podPid = null;
let podClockTimer = null;
let podT0 = 0;
const POD_MAX_S = 10 * 60;
const podStart = document.getElementById("podStart");
const podStop = document.getElementById("podStop");
const podClock = document.getElementById("podClock");
const podExport = document.getElementById("podExport");
const topicInput = document.getElementById("topic");

function podTick() {
  const el = (Date.now() - podT0) / 1000;
  const rem = Math.max(0, POD_MAX_S - el);
  if (podClock) podClock.textContent = `${String(Math.floor(rem / 60)).padStart(2, "0")}:${String(Math.floor(rem % 60)).padStart(2, "0")}`;
  if (rem <= 0 && podStop) podStop.disabled = true;
}

if (podStart) podStart.addEventListener("click", () => {
  if (pws && pws.readyState === WebSocket.OPEN) return;
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const search = localStorage.getItem("live_search") === "1" ? "1" : "0";
  pws = new WebSocket(`${wsProto}://${location.host}/ws_podcast?client=${clientId}&search=${search}&host_voice=${hostVoice}&guest_voice=${guestVoice}&max_minutes=10`);
  pws.onopen = () => {
    pws.send(JSON.stringify({
      type: "podcast_start",
      topic: (topicInput && topicInput.value.trim()) || "Obrolan santai",
      host_voice: hostVoice, guest_voice: guestVoice, max_minutes: 10,
    }));
    podT0 = Date.now();
    clearInterval(podClockTimer);
    podClockTimer = setInterval(podTick, 500);
    podStart.disabled = true;
    podStop.disabled = false;
    if (podExport) podExport.hidden = true;
    statusEl.textContent = "Podcast mulai. Host + guest live...";
  };
  pws.onmessage = (ev) => {
    const pkt = JSON.parse(ev.data);
    if (pkt.type === "status") statusEl.textContent = pkt.text;
    else if (pkt.type === "podcast_started") {
      podPid = pkt.pid;
      statusEl.textContent = `Podcast live: ${pkt.topic}`;
    }
    else if (pkt.type === "transcript_out" && pkt.avatar) { podAppend(pkt.avatar, pkt.text); setPodSpeaker(pkt.avatar); }
    else if (pkt.type === "audio" && pkt.avatar) playPodAudio(pkt.data, pkt.avatar);
    else if (pkt.type === "turn_complete" && pkt.avatar) {
      podLines[pkt.avatar] = null;
      setPodSpeaker(pkt.avatar === "host" ? "guest" : "host");
    }
    else if (pkt.type === "podcast_stopped") {
      statusEl.textContent = pkt.text || "Podcast selesai.";
      clearInterval(podClockTimer);
      podStart.disabled = false;
      podStop.disabled = true;
      setPodSpeaker("none");
      if (podExport && podPid) {
        podExport.href = `/export/${podPid}`;
        podExport.hidden = false;
        podExport.textContent = "Unduh MP4";
      }
    }
  };
  pws.onclose = () => {
    clearInterval(podClockTimer);
    podStart.disabled = false;
    podStop.disabled = true;
  };
});

if (podStop) podStop.addEventListener("click", () => {
  if (pws && pws.readyState === WebSocket.OPEN) pws.send(JSON.stringify({ type: "podcast_stop" }));
});

applyTab();
