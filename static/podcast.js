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

function syncVoiceDisplays() {
  const hDisp = document.getElementById("hostVoiceDisplay");
  const gDisp = document.getElementById("guestVoiceDisplay");
  if (hDisp) hDisp.textContent = hostVoice;
  if (gDisp) gDisp.textContent = guestVoice;
}
syncVoiceDisplays();

if (hostVoiceSel) hostVoiceSel.addEventListener("change", () => {
  hostVoice = hostVoiceSel.value;
  localStorage.setItem("pod_host_voice", hostVoice);
  syncVoiceDisplays();
});
if (guestVoiceSel) guestVoiceSel.addEventListener("change", () => {
  guestVoice = guestVoiceSel.value;
  localStorage.setItem("pod_guest_voice", guestVoice);
  syncVoiceDisplays();
});

/* Google Search Grounding Toggle */
const podSearchBox = document.getElementById("podSearchBox");
if (podSearchBox) {
  podSearchBox.checked = localStorage.getItem("live_search") !== "0";
  podSearchBox.addEventListener("change", () => {
    localStorage.setItem("live_search", podSearchBox.checked ? "1" : "0");
    const liveSearch = document.getElementById("searchBox");
    if (liveSearch) liveSearch.checked = podSearchBox.checked;
  });
}

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

/* Load High-Resolution Studio Portraits */
const hostImg = new Image();
hostImg.src = "/static/assets/images/host_rama.jpg";
let hostImgLoaded = false;
hostImg.onload = () => { hostImgLoaded = true; };

const guestImg = new Image();
guestImg.src = "/static/assets/images/guest_maya.jpg";
let guestImgLoaded = false;
guestImg.onload = () => { guestImgLoaded = true; };

/* Avatar State */
function podState() {
  return {
    mode: "idle",
    level: 0,
    mouth: 0,
    blinkAt: 0,
    gest: Math.random() * 10,
    speakingUntil: 0,
    speechText: "",
    speechTimeout: null,
  };
}
const hostSt = podState();
const guestSt = podState();
const hostCanvas = document.getElementById("hostCanvas");
const guestCanvas = document.getElementById("guestCanvas");
const cardHost = document.getElementById("cardHost");
const cardGuest = document.getElementById("cardGuest");
const podSpeakerEl = document.getElementById("podSpeaker");

const hostStatusText = document.getElementById("hostStatusText");
const guestStatusText = document.getElementById("guestStatusText");
const hostMeterFill = document.getElementById("hostMeterFill");
const guestMeterFill = document.getElementById("guestMeterFill");
const hostSpeechOverlay = document.getElementById("hostSpeechOverlay");
const guestSpeechOverlay = document.getElementById("guestSpeechOverlay");
const hostLiveText = document.getElementById("hostLiveText");
const guestLiveText = document.getElementById("guestLiveText");
const hostVoiceDisplay = document.getElementById("hostVoiceDisplay");
const guestVoiceDisplay = document.getElementById("guestVoiceDisplay");

/* Web Audio Analysers for Real-Time Lip Sync */
let hostAnalyser = null;
let guestAnalyser = null;
let hostWaveData = null;
let guestWaveData = null;

function ensurePodAudio() {
  if (typeof audioCtx === "undefined" || !audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  if (!hostAnalyser) {
    hostAnalyser = audioCtx.createAnalyser();
    hostAnalyser.fftSize = 256;
    hostAnalyser.smoothingTimeConstant = 0.65;
    hostWaveData = new Uint8Array(hostAnalyser.frequencyBinCount);
    hostAnalyser.connect(audioCtx.destination);
  }
  if (!guestAnalyser) {
    guestAnalyser = audioCtx.createAnalyser();
    guestAnalyser.fftSize = 256;
    guestAnalyser.smoothingTimeConstant = 0.65;
    guestWaveData = new Uint8Array(guestAnalyser.frequencyBinCount);
    guestAnalyser.connect(audioCtx.destination);
  }
}

/* Render Lifelike Studio Avatar */
function drawPodAvatar(canvas, st, female, now) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const t = now / 1000;

  // Real-time audio energy extraction from AnalyserNode
  const analyser = female ? guestAnalyser : hostAnalyser;
  const waveData = female ? guestWaveData : hostWaveData;
  let liveLevel = 0;
  if (analyser && waveData && audioCtx) {
    analyser.getByteFrequencyData(waveData);
    let sum = 0;
    for (let i = 0; i < 28; i++) {
      sum += waveData[i];
    }
    liveLevel = Math.min(1, (sum / 28 / 128) * 1.85);
  }

  // Smooth continuous mouth tracking
  if (liveLevel > 0.035) {
    st.level = Math.max(st.level * 0.75, liveLevel);
  } else {
    st.level *= 0.82;
  }
  if (st.level < 0.008) st.level = 0;

  const mouthTarget = st.level;
  const k = mouthTarget > st.mouth ? 0.5 : 0.22;
  st.mouth += (mouthTarget - st.mouth) * k;
  if (st.mouth < 0.01) st.mouth = 0;

  // Speaking detection
  const isAudioPlaying = audioCtx ? (audioCtx.currentTime * 1000 < st.speakingUntil) : false;
  const speaking = st.mode === "speaking" && (st.mouth > 0.02 || isAudioPlaying);

  // Natural Blinking Calculation
  if (st.blinkAt === 0) st.blinkAt = t + 2.8 + Math.random() * 2.5;
  let blink = 0;
  if (t >= st.blinkAt) {
    const elapsed = t - st.blinkAt;
    if (elapsed < 0.07) {
      blink = elapsed / 0.07;
    } else if (elapsed < 0.14) {
      blink = 1 - (elapsed - 0.07) / 0.07;
    } else {
      blink = 0;
      st.blinkAt = t + 3.0 + Math.random() * 3.5;
    }
  }

  // Conversational 2.5D Movements
  const breathY = Math.sin(t * 1.5) * 2.2;
  const breathScale = 1 + Math.sin(t * 1.5) * 0.005;

  let swayX = Math.sin(t * 0.85) * (speaking ? 2.4 : 0.9);
  let nodY = speaking
    ? Math.sin(t * 5.2) * (st.mouth * 4.0) + Math.sin(t * 1.8) * 1.2
    : Math.sin(t * 0.8) * 0.8;
  const headTilt = speaking
    ? Math.sin(t * 1.6) * 0.022
    : Math.sin(t * 0.7) * 0.008;

  // Attentive listening nod when the other speaker is talking
  const otherSt = female ? hostSt : guestSt;
  const isListening = !speaking && otherSt.mode === "speaking";
  if (isListening && Math.sin(t * 1.3) > 0.82) {
    nodY += Math.sin(t * 6.5) * 2.2;
  }

  // Clear canvas
  ctx.clearRect(0, 0, W, H);

  // Clip to rounded container
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 16);
  ctx.clip();

  // Studio Gradient Backdrop
  const bgGrad = ctx.createRadialGradient(W / 2, H * 0.4, 40, W / 2, H * 0.45, W * 0.75);
  if (female) {
    bgGrad.addColorStop(0, "#2c153b");
    bgGrad.addColorStop(0.6, "#180d22");
    bgGrad.addColorStop(1, "#0a050f");
  } else {
    bgGrad.addColorStop(0, "#122a46");
    bgGrad.addColorStop(0.6, "#0b192c");
    bgGrad.addColorStop(1, "#050b14");
  }
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Acoustic Wave Aura when Speaking
  if (speaking && st.mouth > 0.03) {
    const auraColor = female ? "244, 114, 182" : "56, 189, 248";
    const baseR = 120 + st.mouth * 45;
    for (let i = 1; i <= 3; i++) {
      const r = baseR + i * 28 + Math.sin(t * 4 + i) * 8;
      const a = (0.35 / i) * Math.min(1, st.mouth * 1.8);
      ctx.beginPath();
      ctx.arc(W / 2, H * 0.42, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${auraColor}, ${a})`;
      ctx.lineWidth = 3 - i * 0.6;
      ctx.stroke();
    }
  }

  // Draw 2.5D Studio Character Portrait
  const img = female ? guestImg : hostImg;
  const imgLoaded = female ? guestImgLoaded : hostImgLoaded;

  ctx.save();
  ctx.translate(W / 2 + swayX, H / 2 + breathY + nodY);
  ctx.rotate(headTilt);
  ctx.scale(breathScale, breathScale);

  if (imgLoaded) {
    // Draw base portrait centered & slightly oversized to allow motion without edges
    const pw = W + 40;
    const ph = H + 45;
    ctx.drawImage(img, -pw / 2, -ph / 2 - 12, pw, ph);

    // Natural Eyelid Blinking
    if (blink > 0.05) {
      // Eye positions on portrait
      const eyePositions = female
        ? [{ x: -38, y: -48 }, { x: 38, y: -48 }]
        : [{ x: -42, y: -44 }, { x: 42, y: -44 }];

      eyePositions.forEach((pos) => {
        ctx.save();
        ctx.translate(pos.x, pos.y);
        const lidH = blink * 15;

        // Eyelid skin tone gradient
        const lidGrad = ctx.createLinearGradient(0, -10, 0, 10);
        if (female) {
          lidGrad.addColorStop(0, "rgba(224, 160, 130, 0.95)");
          lidGrad.addColorStop(1, "rgba(196, 130, 105, 0.98)");
        } else {
          lidGrad.addColorStop(0, "rgba(215, 150, 115, 0.95)");
          lidGrad.addColorStop(1, "rgba(180, 120, 90, 0.98)");
        }

        ctx.fillStyle = lidGrad;
        ctx.beginPath();
        ctx.ellipse(0, 0, 18, Math.max(2, lidH), 0, 0, Math.PI * 2);
        ctx.fill();

        // Eyelash line
        ctx.strokeStyle = female ? "rgba(35, 18, 12, 0.9)" : "rgba(30, 20, 15, 0.85)";
        ctx.lineWidth = female ? 2.5 : 1.8;
        ctx.beginPath();
        ctx.arc(0, lidH * 0.4, 18, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();

        ctx.restore();
      });
    }

    // Dynamic Lip-Sync Mouth
    const mouthY = female ? 54 : 56;
    const open = Math.min(1, Math.max(0, st.mouth));

    ctx.save();
    ctx.translate(0, mouthY);

    if (open > 0.04) {
      const mw = 22 + open * 14;
      const mh = open * 15;

      // Soft feather background matching lips
      ctx.fillStyle = female ? "rgba(180, 75, 95, 0.25)" : "rgba(165, 80, 70, 0.25)";
      ctx.beginPath();
      ctx.ellipse(0, 0, mw + 4, mh + 5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Oral cavity depth
      ctx.fillStyle = "#3b0c11";
      ctx.beginPath();
      ctx.ellipse(0, 0, mw, mh, 0, 0, Math.PI * 2);
      ctx.fill();

      // Upper teeth edge
      ctx.fillStyle = "rgba(255, 252, 245, 0.88)";
      ctx.beginPath();
      ctx.roundRect(-mw * 0.55, -mh * 0.75, mw * 1.1, Math.min(6, mh * 0.75), 3);
      ctx.fill();

      // Tongue hint
      ctx.fillStyle = "rgba(225, 110, 120, 0.85)";
      ctx.beginPath();
      ctx.ellipse(0, mh * 0.45, mw * 0.6, Math.max(2, mh * 0.45), 0, 0, Math.PI);
      ctx.fill();

      // Upper lip contour
      ctx.strokeStyle = female ? "rgba(195, 85, 105, 0.85)" : "rgba(175, 90, 80, 0.85)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-mw - 2, -mh * 0.2);
      ctx.quadraticCurveTo(-mw * 0.4, -mh * 0.8, 0, -mh * 0.6);
      ctx.quadraticCurveTo(mw * 0.4, -mh * 0.8, mw + 2, -mh * 0.2);
      ctx.stroke();

      // Lower lip contour
      ctx.strokeStyle = female ? "rgba(215, 105, 125, 0.8)" : "rgba(190, 105, 95, 0.75)";
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(-mw - 1, mh * 0.1);
      ctx.quadraticCurveTo(0, mh * 1.2, mw + 1, mh * 0.1);
      ctx.stroke();
    } else {
      // Gentle natural resting smile
      ctx.strokeStyle = female ? "rgba(185, 75, 95, 0.65)" : "rgba(165, 80, 70, 0.6)";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(-15, 0);
      ctx.quadraticCurveTo(0, 4, 15, 0);
      ctx.stroke();
    }
    ctx.restore();

  } else {
    // Elegant fallback during image load
    ctx.fillStyle = female ? "#e5aa70" : "#df9c66";
    ctx.beginPath();
    ctx.ellipse(0, 0, 65, 85, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore(); // end portrait transform

  // Broadcast Studio Microphone in Foreground
  const micX = female ? W * 0.68 : W * 0.32;
  const micY = H - 85;
  ctx.save();
  ctx.translate(micX, micY);

  // Boom arm
  ctx.strokeStyle = "#334155";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(female ? 50 : -50, 95);
  ctx.lineTo(female ? 16 : -16, 22);
  ctx.stroke();

  // Swivel mount
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.arc(female ? 16 : -16, 20, 8, 0, Math.PI * 2);
  ctx.fill();

  // Microphone body (Shure SM7B aesthetic)
  ctx.save();
  ctx.rotate(female ? -0.22 : 0.22);

  // Metallic capsule
  ctx.fillStyle = "#0f172a";
  ctx.beginPath();
  ctx.roundRect(-14, -28, 28, 48, 8);
  ctx.fill();

  // Foam windscreen texture
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.roundRect(-13, -26, 26, 32, 6);
  ctx.fill();

  // Glowing "ON AIR" LED Ring
  const ledGlow = speaking;
  const ringColor = female ? "#f472b6" : "#38bdf8";

  if (ledGlow) {
    // Outer bloom
    const bloomGrad = ctx.createRadialGradient(0, 10, 2, 0, 10, 18);
    bloomGrad.addColorStop(0, female ? "rgba(244, 114, 182, 0.95)" : "rgba(56, 189, 248, 0.95)");
    bloomGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = bloomGrad;
    ctx.beginPath();
    ctx.arc(0, 10, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = ringColor;
    ctx.fillRect(-14, 8, 28, 4);
  } else {
    ctx.fillStyle = "#475569";
    ctx.fillRect(-14, 8, 28, 3);
  }

  ctx.restore();
  ctx.restore();

  // Audio Equalizer Waveform Bars at Bottom
  if (waveData && speaking) {
    const bars = 18;
    const barWidth = 6;
    const startX = W / 2 - (bars * 10) / 2;
    for (let b = 0; b < bars; b++) {
      const idx = Math.floor((b / bars) * 24);
      const val = (waveData[idx] / 255) * 36 * Math.min(1, st.mouth * 2);
      const bx = startX + b * 10;
      const by = H - 8 - val;
      ctx.fillStyle = female ? "rgba(244, 114, 182, 0.85)" : "rgba(56, 189, 248, 0.85)";
      ctx.beginPath();
      ctx.roundRect(bx, by, barWidth, Math.max(3, val), 2);
      ctx.fill();
    }
  }

  ctx.restore(); // end clip

  // Sync Card UI State
  const card = female ? cardGuest : cardHost;
  const statusPillText = female ? guestStatusText : hostStatusText;
  const meterFill = female ? guestMeterFill : hostMeterFill;

  if (card) {
    card.classList.toggle("speaking", speaking);
    card.classList.toggle("listening", isListening);
  }
  if (statusPillText) {
    statusPillText.textContent = speaking ? "ON AIR" : isListening ? "Mendengarkan" : "Standby";
  }
  if (meterFill) {
    meterFill.style.width = Math.min(100, Math.round(st.mouth * 135)) + "%";
  }
}

function podLoop(now) {
  drawPodAvatar(hostCanvas, hostSt, false, now || performance.now());
  drawPodAvatar(guestCanvas, guestSt, true, now || performance.now());
  if (activeTab === "podcast" && podcastPanel && !podcastPanel.hidden) {
    requestAnimationFrame(podLoop);
  }
}

function setPodSpeaker(role) {
  hostSt.mode = role === "host" ? "speaking" : "idle";
  guestSt.mode = role === "guest" ? "speaking" : "idle";
  if (cardHost) {
    cardHost.classList.toggle("speaking", role === "host");
    cardHost.classList.toggle("listening", role === "guest");
  }
  if (cardGuest) {
    cardGuest.classList.toggle("speaking", role === "guest");
    cardGuest.classList.toggle("listening", role === "host");
  }
  if (podSpeakerEl) {
    podSpeakerEl.textContent = role === "host" ? "RAMA (Host) Live" : role === "guest" ? "MAYA (Guest) Live" : "Standby";
  }
}

function playPodAudio(b64, role) {
  ensurePodAudio();
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  const samples = new Int16Array(buf);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));

  const out = audioCtx.createBuffer(1, samples.length, 24000);
  const ch = out.getChannelData(0);
  for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;

  const src = audioCtx.createBufferSource();
  src.buffer = out;

  // Route through Web Audio Analyser
  const analyser = role === "guest" ? guestAnalyser : hostAnalyser;
  src.connect(analyser);

  const now = Math.max(audioCtx.currentTime, (typeof playCursor !== "undefined" ? playCursor : 0));
  src.start(now);
  if (typeof playCursor !== "undefined") playCursor = now + out.duration;

  const st = role === "guest" ? guestSt : hostSt;
  st.level = Math.min(1, rms * 4);
  st.speakingUntil = (now + out.duration) * 1000;
  setPodSpeaker(role);
}

/* Real-Time Subtitle Streamer & Transcript */
const podLines = { host: null, guest: null };
function podAppend(role, text) {
  const isGuest = role === "guest";
  const label = isGuest ? "Maya (Guest): " : "Rama (Host): ";

  // Update Transcript Box
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

  // Update Live Floating Subtitle Overlay on Avatar Card
  const overlay = isGuest ? guestSpeechOverlay : hostSpeechOverlay;
  const liveText = isGuest ? guestLiveText : hostLiveText;
  const st = isGuest ? guestSt : hostSt;

  if (overlay && liveText) {
    overlay.hidden = false;
    liveText.textContent = (liveText.textContent === "..." ? "" : liveText.textContent) + text;
    if (st.speechTimeout) clearTimeout(st.speechTimeout);
    st.speechTimeout = setTimeout(() => {
      overlay.hidden = true;
      liveText.textContent = "...";
    }, 4500);
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
  if (typeof audioCtx === "undefined" || !audioCtx || audioCtx.state === "closed") {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  try {
    if (pws && (pws.readyState === WebSocket.OPEN || pws.readyState === WebSocket.CONNECTING)) {
      try { pws.onclose = null; } catch (e) {}
      try { pws.close(); } catch (e) {}
    }
  } catch (e) {}
  pws = null;
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const isSearch = podSearchBox ? podSearchBox.checked : (localStorage.getItem("live_search") !== "0");
  const search = isSearch ? "1" : "0";
  pws = new WebSocket(`${wsProto}://${location.host}/ws_podcast?client=${clientId}&search=${search}&host_voice=${hostVoice}&guest_voice=${guestVoice}&max_minutes=10`);
  pws.onopen = () => {
    pws.send(JSON.stringify({
      type: "podcast_start",
      topic: (topicInput && topicInput.value.trim()) || "Masa Depan AI & Robotika Humanoid",
      host_voice: hostVoice,
      guest_voice: guestVoice,
      max_minutes: 10,
      enable_search: isSearch,
    }));
    podT0 = Date.now();
    clearInterval(podClockTimer);
    podClockTimer = setInterval(podTick, 500);
    podStart.disabled = true;
    podStop.disabled = false;
    if (podExport) podExport.hidden = true;
    statusEl.textContent = "Podcast dimulai! Host dan Guest sedang live...";
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
    else if (pkt.type === "sources" && pkt.items) {
      if (typeof addSources === "function") {
        addSources(pkt.items);
      }
    }
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

// Topic chips & Enter key trigger
document.querySelectorAll(".chip[data-topic]").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (topicInput) {
      topicInput.value = chip.getAttribute("data-topic");
      topicInput.focus();
    }
  });
});

if (topicInput) {
  topicInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !podStart.disabled) {
      e.preventDefault();
      podStart.click();
    }
  });
}

applyTab();
