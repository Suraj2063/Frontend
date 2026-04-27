// ============================================================
//  app.js — Relaxed Hallucination Detection
// ============================================================

"use strict";

const STATE = {
  isConnected:   false,
  isRecording:   false,
  isProcessing:  false,
  backendUrl:    "",
  mediaStream:   null,
  mediaRecorder: null,
  audioChunks:   [],
  chunkTimer:    null,
  animFrame:     null,
  hasVoiceActivity: false,
  silenceCounter:   0,
};

const $ = (id) => document.getElementById(id);

const DOM = {
  ngrokUrl:      () => $("ngrok-url"),
  statusDot:     () => $("status-dot"),
  statusText:    () => $("status-text"),
  btnRecord:     () => $("btn-record"),
  recLabel:      () => $("rec-label"),
  transcriptBox: () => $("transcript-box"),
  historyList:   () => $("history-list"),
  processing:    () => $("processing-overlay"),
  visualizer:    () => $("visualizer"),
  chunkDur:      () => $("chunk-dur"),
  continuous:    () => $("continuous-mode"),
  toast:         () => $("toast"),
  vadIndicator:  () => $("vad-indicator"),
  statsBox:      () => $("stats-box"),
};

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
function showToast(msg, ms = 4000) {
  const t = DOM.toast();
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), ms);
}

// ─────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────
function setStatus(state, text) {
  const dot = DOM.statusDot();
  dot.className = "status-dot";
  DOM.statusText().textContent = text;
  dot.style.background = "";
  if (state === "connected")  dot.classList.add("connected");
  if (state === "recording")  dot.classList.add("recording");
  if (state === "processing") dot.classList.add("processing");
  if (state === "error")      dot.style.background = "#ef4444";
}

// ─────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────
const STATS = { sent: 0, ok: 0, blocked: 0, silent: 0 };

function updateStats(key) {
  STATS[key]++;
  const el = DOM.statsBox();
  if (el) {
    el.textContent =
      `Sent: ${STATS.sent} | ✅ OK: ${STATS.ok} | ` +
      `🚫 Blocked: ${STATS.blocked} | 🔇 Silent: ${STATS.silent}`;
  }
}

// ─────────────────────────────────────────────
// FETCH HEADERS
// ─────────────────────────────────────────────
function headers(extra = {}) {
  return {
    "ngrok-skip-browser-warning": "true",
    "Accept": "application/json",
    ...extra
  };
}

// ─────────────────────────────────────────────
// ★ RELAXED CLIENT-SIDE HALLUCINATION FILTER
// Only blocks severe repetition (6+ same word)
// ─────────────────────────────────────────────
function isClientSideHallucination(text) {
  if (!text || text.trim().length < 2) return true;

  const words = text.trim().split(/[\s,।]+/).filter(Boolean);

  // Only block if same word repeats 6+ times
  const counts = {};
  for (const w of words) {
    counts[w] = (counts[w] || 0) + 1;
    if (counts[w] >= 6) {
      console.warn(`Client blocked: "${w}" repeated ${counts[w]}x`);
      return true;
    }
  }

  // Only block if literally 1 character
  if (words.length === 1 && words[0].length < 2) return true;

  return false;
}

// ─────────────────────────────────────────────
// CONNECTION TEST
// ─────────────────────────────────────────────
async function testConnection() {
  let url = DOM.ngrokUrl().value.trim().replace(/\/+$/, "");
  if (!url) {
    showToast("⚠️ Paste your Ngrok URL first");
    return;
  }
  if (!url.startsWith("http")) url = "https://" + url;
  DOM.ngrokUrl().value = url;
  STATE.backendUrl = url;

  setStatus("processing", "Connecting...");

  try {
    const res = await fetch(`${url}/health`, {
      method:  "GET",
      mode:    "cors",
      headers: headers(),
      signal:  AbortSignal.timeout(10000),
    });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw new Error("Got HTML — Colab not running?");
    }
    const data = await res.json();
    STATE.isConnected = true;
    setStatus("connected", `✅ Connected | GPU: ${data.gpu ? "🟢" : "🔴"} | Port: ${data.port}`);
    DOM.btnRecord().disabled = false;
    DOM.recLabel().textContent = "Press 🎙️ to start";
    showToast("✅ Connected!");
  } catch (err) {
    STATE.isConnected = false;
    setStatus("error", "Failed: " + err.message.substring(0, 60));
    showToast("❌ " + err.message);
  }
}

$("ngrok-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") testConnection();
});

// ─────────────────────────────────────────────
// VISUALIZER + VAD
// ─────────────────────────────────────────────
let _vizAudioCtx   = null;
let _vadAnalyser   = null;
const VAD_THRESHOLD = 15;

function startVisualizer(stream) {
  const canvas  = DOM.visualizer();
  const ctx     = canvas.getContext("2d");
  _vizAudioCtx  = new AudioContext();
  const source  = _vizAudioCtx.createMediaStreamSource(stream);
  _vadAnalyser  = _vizAudioCtx.createAnalyser();
  _vadAnalyser.fftSize = 256;
  source.connect(_vadAnalyser);

  const bufLen  = _vadAnalyser.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);

  function draw() {
    STATE.animFrame = requestAnimationFrame(draw);
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    _vadAnalyser.getByteFrequencyData(dataArr);

    const rms = Math.sqrt(dataArr.reduce((s, v) => s + v * v, 0) / bufLen);
    const vadEl = DOM.vadIndicator();
    if (rms > VAD_THRESHOLD) {
      STATE.hasVoiceActivity = true;
      STATE.silenceCounter   = 0;
      if (vadEl) {
        vadEl.textContent = "🎙️ Voice";
        vadEl.style.color = "#22c55e";
      }
    } else {
      STATE.silenceCounter++;
      if (STATE.silenceCounter > 10) {
        STATE.hasVoiceActivity = false;
        if (vadEl) {
          vadEl.textContent = "🔇 Silence";
          vadEl.style.color = "#8b949e";
        }
      }
    }

    ctx.fillStyle = "#21262d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const barW = (canvas.width / bufLen) * 2.5;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const h = (dataArr[i] / 255) * canvas.height;
      const p = dataArr[i] / 255;
      ctx.fillStyle = `rgb(${Math.round(249*p+59*(1-p))},${Math.round(115*p+130*(1-p))},22)`;
      ctx.fillRect(x, canvas.height - h, barW - 1, h);
      x += barW;
    }
  }
  draw();
}

function stopVisualizer() {
  if (STATE.animFrame) {
    cancelAnimationFrame(STATE.animFrame);
    STATE.animFrame = null;
  }
  if (_vizAudioCtx) {
    _vizAudioCtx.close();
    _vizAudioCtx = null;
  }
  const canvas = DOM.visualizer();
  const ctx    = canvas.getContext("2d");
  ctx.fillStyle = "#21262d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ─────────────────────────────────────────────
// WAV ENCODER
// ─────────────────────────────────────────────
async function blobToWav(blob) {
  const buf     = await blob.arrayBuffer();
  const tmpCtx  = new AudioContext();
  let decoded;
  try   { decoded = await tmpCtx.decodeAudioData(buf); }
  finally { tmpCtx.close(); }

  const rate    = 16000;
  const samples = Math.ceil(decoded.duration * rate);
  const offCtx  = new OfflineAudioContext(1, samples, rate);
  const src     = offCtx.createBufferSource();
  src.buffer    = decoded;
  src.connect(offCtx.destination);
  src.start(0);

  const rendered = await offCtx.startRendering();
  return encodeWav(rendered);
}

function encodeWav(ab) {
  const sr  = ab.sampleRate;
  const pcm = f32ToI16(ab.getChannelData(0));
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v   = new DataView(buf);
  const ws  = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ws(0, "RIFF"); v.setUint32(4, 36 + pcm.byteLength, true);
  ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); ws(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer));
  return new Blob([buf], { type: "audio/wav" });
}

function f32ToI16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
}

// ─────────────────────────────────────────────
// SEND FOR TRANSCRIPTION
// ─────────────────────────────────────────────
async function sendForTranscription(wavBlob, hadVoice) {
  if (!STATE.isConnected) return;

  if (!hadVoice) {
    console.log("🔇 Silent chunk skipped");
    updateStats("silent");
    return;
  }

  updateStats("sent");
  STATE.isProcessing = true;
  DOM.processing().classList.add("show");

  const form = new FormData();
  form.append("audio", wavBlob, "recording.wav");

  try {
    const res = await fetch(`${STATE.backendUrl}/transcribe`, {
      method:  "POST",
      mode:    "cors",
      headers: headers(),
      body:    form,
      signal:  AbortSignal.timeout(90000),
    });

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      throw new Error("Got HTML — Colab disconnected");
    }

    const data = await res.json();
    console.log("Response:", data);

    if (data.success && data.transcript) {
      const text = data.transcript.trim();

      if (isClientSideHallucination(text)) {
        console.warn("🚫 Client blocked:", text);
        updateStats("blocked");
        showToast("🚫 Filtered repetition");
        return;
      }

      updateStats("ok");
      appendTranscript(text);
      addToHistory(text);

    } else {
      const reason = data.reason || "unknown";
      console.log(`Backend rejected: ${reason}`);
      updateStats(reason.includes("hallucination") ? "blocked" : "silent");

      if (reason.includes("hallucination")) {
        showToast(`🚫 Filtered: ${reason}`);
      }
    }

  } catch (err) {
    console.error("Fetch error:", err);
    if (err.name === "AbortError") {
      showToast("⏱️ Timeout");
    } else if (err.message.includes("Failed to fetch")) {
      showToast("❌ Connection lost");
      STATE.isConnected = false;
      setStatus("error", "Connection lost");
    } else {
      showToast("❌ " + err.message.substring(0, 60));
    }
  } finally {
    STATE.isProcessing = false;
    DOM.processing().classList.remove("show");
    if (STATE.isRecording) setStatus("recording", "Recording...");
    else if (STATE.isConnected) setStatus("connected", "Connected ✅");
  }
}

// ─────────────────────────────────────────────
// TRANSCRIPT
// ─────────────────────────────────────────────
function appendTranscript(text) {
  const box = DOM.transcriptBox();
  box.classList.remove("empty");
  const cur = box.textContent.trim();
  box.textContent = cur ? cur + " " + text : text;
  box.scrollTop = box.scrollHeight;
}
function clearTranscript() {
  const b = DOM.transcriptBox();
  b.textContent = "";
  b.classList.add("empty");
  showToast("🗑️ Cleared");
}
function copyTranscript() {
  const t = DOM.transcriptBox().textContent.trim();
  if (!t) { showToast("Nothing to copy"); return; }
  navigator.clipboard.writeText(t).then(() => showToast("📋 Copied!"));
}
function downloadTranscript() {
  const t = DOM.transcriptBox().textContent.trim();
  if (!t) { showToast("Nothing"); return; }
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([t], { type: "text/plain;charset=utf-8" })),
    download: `transcript_${Date.now()}.txt`,
  });
  a.click();
  showToast("⬇️ Downloaded");
}

// ─────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────
function addToHistory(text) {
  const list  = DOM.historyList();
  const empty = list.querySelector(".history-empty");
  if (empty) empty.remove();
  const item = document.createElement("div");
  item.className = "history-item";
  item.innerHTML =
    `<span class="history-text">${escHtml(text)}</span>
     <span class="history-time">${new Date().toLocaleTimeString()}</span>`;
  list.insertBefore(item, list.firstChild);
  const all = list.querySelectorAll(".history-item");
  if (all.length > 20) all[all.length - 1].remove();
}
function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ─────────────────────────────────────────────
// RECORDING
// ─────────────────────────────────────────────
async function startRecording() {
  if (!STATE.isConnected) {
    showToast("⚠️ Connect first");
    return;
  }

  try {
    STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000,
               echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    showToast("❌ Mic access denied");
    return;
  }

  startVisualizer(STATE.mediaStream);

  const mimes  = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"];
  const mime   = mimes.find(m => MediaRecorder.isTypeSupported(m)) || "";
  STATE.isRecording   = true;
  STATE.audioChunks   = [];
  STATE.hasVoiceActivity = false;

  DOM.btnRecord().textContent = "⏹️";
  DOM.btnRecord().classList.add("recording");
  DOM.recLabel().textContent = "Recording... (Space or click to stop)";
  setStatus("recording", "Recording...");

  function startChunk() {
    if (!STATE.isRecording) return;
    STATE.audioChunks = [];
    let chunkHadVoice = false;

    try {
      STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream, mime ? { mimeType: mime } : {});
    } catch {
      STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream);
    }

    STATE.mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) {
        STATE.audioChunks.push(e.data);
        if (STATE.hasVoiceActivity) chunkHadVoice = true;
      }
    };

    STATE.mediaRecorder.start(200);

    STATE.mediaRecorder.onstop = async () => {
      const raw = new Blob(STATE.audioChunks, { type: mime || "audio/webm" });
      console.log(`Chunk: ${raw.size}B | voice: ${chunkHadVoice}`);

      if (raw.size < 2000) {
        if (STATE.isRecording) startChunk();
        return;
      }

      try {
        const wav = await blobToWav(raw);
        sendForTranscription(wav, chunkHadVoice);
      } catch (e) {
        console.error("WAV error:", e);
        sendForTranscription(raw, chunkHadVoice);
      }

      if (STATE.isRecording) startChunk();
    };

    const dur = parseInt(DOM.chunkDur().value, 10) * 1000;
    STATE.chunkTimer = setTimeout(() => {
      if (STATE.mediaRecorder?.state === "recording")
        STATE.mediaRecorder.stop();
    }, dur);
  }

  startChunk();
}

function stopRecording() {
  STATE.isRecording = false;
  clearTimeout(STATE.chunkTimer);
  if (STATE.mediaRecorder?.state !== "inactive") STATE.mediaRecorder.stop();
  STATE.mediaStream?.getTracks().forEach(t => t.stop());
  STATE.mediaStream = null;
  stopVisualizer();
  DOM.btnRecord().textContent = "🎙️";
  DOM.btnRecord().classList.remove("recording");
  DOM.recLabel().textContent = "Press to start";
  setStatus("connected", "Connected ✅");
  showToast("⏹️ Stopped");
}

function toggleRecording() {
  if (!STATE.isConnected) { showToast("⚠️ Connect first"); return; }
  STATE.isRecording ? stopRecording() : startRecording();
}

document.addEventListener("keydown", (e) => {
  const a = document.activeElement;
  if (a === DOM.ngrokUrl() || a === DOM.transcriptBox()) return;
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    if (STATE.isConnected) toggleRecording();
  }
});

DOM.transcriptBox().addEventListener("input", function () {
  this.classList.toggle("empty", !this.textContent.trim());
});

window.addEventListener("load", () => {
  const c = DOM.visualizer();
  c.width = c.offsetWidth; c.height = c.offsetHeight;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#21262d";
  ctx.fillRect(0, 0, c.width, c.height);
  console.log("✅ Frontend ready");
});