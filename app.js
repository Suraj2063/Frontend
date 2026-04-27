// ============================================================
//  app.js — Fixed Version
//  Key fixes:
//  1. Adds "ngrok-skip-browser-warning" header to all requests
//  2. Adds explicit mode/credentials settings to fetch
//  3. Better error messages so you know EXACTLY what failed
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
  segmentCount:  0,
};

// ─────────────────────────────────────────────
// DOM HELPERS
// ─────────────────────────────────────────────
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
  const dot  = DOM.statusDot();
  const span = DOM.statusText();
  dot.className    = "status-dot";
  span.textContent = text;
  dot.style.background = "";
  if (state === "connected")  dot.classList.add("connected");
  if (state === "recording")  dot.classList.add("recording");
  if (state === "processing") dot.classList.add("processing");
  if (state === "error")      dot.style.background = "#ef4444";
}

// ─────────────────────────────────────────────
// ★ FIXED: makeFetchHeaders
//   Always include ngrok-skip-browser-warning.
//   Without this, Ngrok returns an HTML warning
//   page instead of JSON → "Failed to fetch"
// ─────────────────────────────────────────────
function makeFetchHeaders(extra = {}) {
  return {
    "ngrok-skip-browser-warning": "true",   // ← THE FIX
    "Accept": "application/json",
    ...extra,
  };
}

// ─────────────────────────────────────────────
// TEST CONNECTION — Improved error reporting
// ─────────────────────────────────────────────
async function testConnection() {
  let raw = DOM.ngrokUrl().value.trim();

  // ── Input validation ──
  if (!raw) {
    showToast("⚠️ Please paste your Ngrok URL first");
    return;
  }

  // Strip trailing slash
  raw = raw.replace(/\/+$/, "");

  // Auto-fix: add https:// if missing
  if (!raw.startsWith("http")) {
    raw = "https://" + raw;
    DOM.ngrokUrl().value = raw;
  }

  STATE.backendUrl = raw;
  setStatus("processing", "Testing connection...");

  // ── Attempt 1: /health endpoint ──
  try {
    console.log(`Testing: ${raw}/health`);

    const res = await fetch(`${raw}/health`, {
      method:  "GET",
      mode:    "cors",                         // explicit CORS mode
      headers: makeFetchHeaders(),             // ngrok bypass header
      signal:  AbortSignal.timeout(10000),     // 10s timeout
    });

    console.log("Response status:", res.status);
    console.log("Response headers:", [...res.headers.entries()]);

    // Check content type before parsing JSON
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      console.error("Non-JSON response:", text.substring(0, 300));
      throw new Error(
        `Got HTML instead of JSON. ` +
        `This usually means Ngrok showed its warning page. ` +
        `Make sure the backend is running in Colab.`
      );
    }

    const data = await res.json();
    console.log("Health response:", data);

    if (res.ok && data.status === "ok") {
      STATE.isConnected = true;
      setStatus(
        "connected",
        `✅ Connected | GPU: ${data.gpu ? "🟢 Yes" : "🔴 No (CPU)"} | Device: ${data.device}`
      );
      DOM.btnRecord().disabled = false;
      DOM.recLabel().textContent = "Press 🎙️ to start recording";
      showToast("✅ Backend connected! Ready to transcribe.");
    } else {
      throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
    }

  } catch (err) {
    STATE.isConnected = false;
    DOM.btnRecord().disabled = true;

    // ── Detailed error diagnosis ──
    let diagnosis = "";
    const msg = err.message || "";

    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      diagnosis =
        "Network blocked. Possible causes:\n" +
        "1. Colab cell stopped running → Re-run Cell 3\n" +
        "2. Ngrok tunnel expired → Restart ngrok in Colab\n" +
        "3. Wrong URL copied → Check Colab output for URL\n" +
        "4. Ad-blocker blocking ngrok → Disable it";
    } else if (msg.includes("HTML instead of JSON")) {
      diagnosis = "Ngrok warning page intercepted. Colab might be idle.";
    } else if (msg.includes("timeout") || msg.includes("AbortError")) {
      diagnosis = "Request timed out. Is Colab still running?";
    } else {
      diagnosis = msg;
    }

    setStatus("error", `Connection failed: ${diagnosis.split("\n")[0]}`);
    console.error("Connection error details:", diagnosis);
    showToast(`❌ ${diagnosis.split("\n")[0]}`, 6000);

    // Show detailed help in console
    console.group("🔧 Troubleshooting Steps");
    console.log(diagnosis);
    console.groupEnd();
  }
}

// Allow Enter key in URL field
$("ngrok-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") testConnection();
});

// ─────────────────────────────────────────────
// AUDIO VISUALIZER
// ─────────────────────────────────────────────
let _audioCtxForViz = null;

function startVisualizer(stream) {
  const canvas   = DOM.visualizer();
  const ctx      = canvas.getContext("2d");
  _audioCtxForViz= new AudioContext();
  const source   = _audioCtxForViz.createMediaStreamSource(stream);
  const analyser = _audioCtxForViz.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const bufLen  = analyser.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);

  function draw() {
    STATE.animFrame = requestAnimationFrame(draw);
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    analyser.getByteFrequencyData(dataArr);

    ctx.fillStyle = "#21262d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barW = (canvas.width / bufLen) * 2.5;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const h   = (dataArr[i] / 255) * canvas.height;
      const pct = dataArr[i] / 255;
      ctx.fillStyle = `rgb(${Math.round(249*pct+59*(1-pct))},${Math.round(115*pct+130*(1-pct))},${Math.round(22*pct+246*(1-pct))})`;
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
  if (_audioCtxForViz) {
    _audioCtxForViz.close();
    _audioCtxForViz = null;
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
  const arrayBuffer = await blob.arrayBuffer();

  // Decode with a temporary AudioContext
  const tempCtx = new AudioContext();
  let decoded;
  try {
    decoded = await tempCtx.decodeAudioData(arrayBuffer);
  } finally {
    tempCtx.close();
  }

  // Resample to 16kHz mono (Whisper's native format)
  const targetRate  = 16000;
  const numSamples  = Math.ceil(decoded.duration * targetRate);
  const offlineCtx  = new OfflineAudioContext(1, numSamples, targetRate);
  const src         = offlineCtx.createBufferSource();
  src.buffer        = decoded;
  src.connect(offlineCtx.destination);
  src.start(0);

  const resampled = await offlineCtx.startRendering();
  return pcmToWavBlob(resampled);
}

function pcmToWavBlob(audioBuffer) {
  const sr      = audioBuffer.sampleRate;
  const samples = float32ToInt16(audioBuffer.getChannelData(0));
  const buf     = new ArrayBuffer(44 + samples.byteLength);
  const view    = new DataView(buf);
  const ws      = (off, str) => [...str].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));

  ws(0, "RIFF");
  view.setUint32(4,  36 + samples.byteLength, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  view.setUint32(16, 16,       true);
  view.setUint16(20, 1,        true);  // PCM
  view.setUint16(22, 1,        true);  // mono
  view.setUint32(24, sr,       true);
  view.setUint32(28, sr * 2,   true);  // byte rate
  view.setUint16(32, 2,        true);  // block align
  view.setUint16(34, 16,       true);  // bits per sample
  ws(36, "data");
  view.setUint32(40, samples.byteLength, true);
  new Uint8Array(buf, 44).set(new Uint8Array(samples.buffer));

  return new Blob([buf], { type: "audio/wav" });
}

function float32ToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i]  = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// ─────────────────────────────────────────────
// ★ FIXED: sendForTranscription
//   - Adds ngrok-skip-browser-warning to POST request
//   - Uses mode: "cors" explicitly
//   - Better error messages
// ─────────────────────────────────────────────
async function sendForTranscription(wavBlob) {
  if (!STATE.isConnected || !wavBlob) return;

  STATE.isProcessing = true;
  DOM.processing().classList.add("show");
  setStatus("processing", "Sending audio to Whisper...");

  const formData = new FormData();
  formData.append("audio", wavBlob, "recording.wav");

  try {
    console.log(`Sending ${wavBlob.size} bytes to ${STATE.backendUrl}/transcribe`);

    const res = await fetch(`${STATE.backendUrl}/transcribe`, {
      method:  "POST",
      mode:    "cors",
      headers: makeFetchHeaders(),    // ← ngrok bypass header (no Content-Type for FormData)
      body:    formData,
      signal:  AbortSignal.timeout(90000),   // 90 seconds for large-v3
    });

    // Check for HTML response (Ngrok warning page)
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      console.error("Non-JSON transcribe response:", text.substring(0, 200));
      throw new Error("Got HTML instead of JSON — Colab may have timed out");
    }

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(errBody.detail || `HTTP ${res.status}`);
    }

    const data = await res.json();
    console.log("Transcription result:", data);

    if (data.success && data.transcript) {
      appendTranscript(data.transcript);
      addToHistory(data.transcript);
    } else {
      console.warn("Empty transcript returned:", data);
      showToast("⚠️ No speech detected in this chunk");
    }

  } catch (err) {
    console.error("Transcription error:", err);

    if (err.name === "AbortError" || err.message.includes("timeout")) {
      showToast("⏱️ Request timed out — model may be loading, try again");
    } else if (err.message.includes("Failed to fetch")) {
      showToast("❌ Lost connection to backend — check Colab is still running");
      STATE.isConnected = false;
      setStatus("error", "Connection lost — paste URL and reconnect");
    } else {
      showToast(`❌ ${err.message}`);
    }

  } finally {
    STATE.isProcessing = false;
    DOM.processing().classList.remove("show");
    if (STATE.isRecording) setStatus("recording", "Recording...");
    else if (STATE.isConnected) setStatus("connected", "Connected ✅ | Idle");
  }
}

// ─────────────────────────────────────────────
// TRANSCRIPT HELPERS
// ─────────────────────────────────────────────
function appendTranscript(text) {
  const box = DOM.transcriptBox();
  box.classList.remove("empty");
  const cur = box.textContent.trim();
  box.textContent = cur ? cur + " " + text : text;
  box.scrollTop = box.scrollHeight;
}

function clearTranscript() {
  const box = DOM.transcriptBox();
  box.textContent = "";
  box.classList.add("empty");
  showToast("🗑️ Cleared");
}

function copyTranscript() {
  const text = DOM.transcriptBox().textContent.trim();
  if (!text) { showToast("Nothing to copy"); return; }
  navigator.clipboard.writeText(text)
    .then(() => showToast("📋 Copied!"))
    .catch(() => showToast("❌ Copy failed"));
}

function downloadTranscript() {
  const text = DOM.transcriptBox().textContent.trim();
  if (!text) { showToast("Nothing to download"); return; }
  const a = Object.assign(document.createElement("a"), {
    href:     URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })),
    download: `devanagari_${Date.now()}.txt`,
  });
  a.click();
  showToast("⬇️ Downloaded!");
}

// ─────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────
function addToHistory(text) {
  const list  = DOM.historyList();
  const empty = list.querySelector(".history-empty");
  if (empty) empty.remove();

  const time = new Date().toLocaleTimeString();
  const item = document.createElement("div");
  item.className = "history-item";
  item.innerHTML = `
    <span class="history-text">${escapeHtml(text)}</span>
    <span class="history-time">${time}</span>`;
  list.insertBefore(item, list.firstChild);

  const items = list.querySelectorAll(".history-item");
  if (items.length > 20) items[items.length - 1].remove();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ─────────────────────────────────────────────
// RECORDING
// ─────────────────────────────────────────────
async function startRecording() {
  if (!STATE.isConnected) {
    showToast("⚠️ Connect to backend first");
    return;
  }

  try {
    STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:     1,
        sampleRate:       16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      },
    });
  } catch (err) {
    showToast("❌ Microphone access denied — allow it in browser settings");
    setStatus("error", "Microphone permission denied");
    return;
  }

  startVisualizer(STATE.mediaStream);

  // Best available MIME type
  const mimes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  const mimeType = mimes.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  console.log("Using MIME type:", mimeType || "(browser default)");

  STATE.isRecording = true;
  STATE.audioChunks = [];

  // Update UI
  DOM.btnRecord().textContent = "⏹️";
  DOM.btnRecord().classList.add("recording");
  DOM.recLabel().textContent = "Recording... (click ⏹️ or press Space to stop)";
  setStatus("recording", "Recording...");

  // ── Chunk-based recording loop ──
  function startChunk() {
    if (!STATE.isRecording) return;
    STATE.audioChunks = [];

    try {
      STATE.mediaRecorder = new MediaRecorder(
        STATE.mediaStream,
        mimeType ? { mimeType } : {}
      );
    } catch (e) {
      STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream);
    }

    STATE.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) STATE.audioChunks.push(e.data);
    };

    STATE.mediaRecorder.onstop = async () => {
      const raw = new Blob(STATE.audioChunks, {
        type: mimeType || "audio/webm",
      });

      console.log(`Chunk: ${raw.size} bytes`);

      if (raw.size < 1000) {
        console.log("Chunk too small, skipping");
        if (STATE.isRecording) startChunk();
        return;
      }

      // Convert to WAV and send
      try {
        const wav = await blobToWav(raw);
        console.log(`WAV: ${wav.size} bytes`);
        // Fire-and-forget so next chunk starts immediately
        sendForTranscription(wav);
      } catch (convErr) {
        console.error("WAV conversion failed, sending raw:", convErr);
        sendForTranscription(raw);
      }

      if (STATE.isRecording) startChunk();
    };

    STATE.mediaRecorder.start();

    // Stop chunk after N seconds
    const dur = parseInt(DOM.chunkDur().value, 10) * 1000;
    STATE.chunkTimer = setTimeout(() => {
      if (STATE.mediaRecorder?.state === "recording") {
        STATE.mediaRecorder.stop();
      }
    }, dur);
  }

  // Non-continuous: record until user clicks stop
  if (!DOM.continuous().checked) {
    try {
      STATE.mediaRecorder = new MediaRecorder(
        STATE.mediaStream,
        mimeType ? { mimeType } : {}
      );
    } catch (e) {
      STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream);
    }
    STATE.mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) STATE.audioChunks.push(e.data);
    };
    STATE.mediaRecorder.onstop = async () => {
      const raw = new Blob(STATE.audioChunks, { type: mimeType || "audio/webm" });
      try { await sendForTranscription(await blobToWav(raw)); }
      catch { await sendForTranscription(raw); }
    };
    STATE.mediaRecorder.start();
  } else {
    startChunk();
  }
}

function stopRecording() {
  STATE.isRecording = false;

  clearTimeout(STATE.chunkTimer);
  STATE.chunkTimer = null;

  if (STATE.mediaRecorder?.state !== "inactive") {
    STATE.mediaRecorder.stop();
  }

  STATE.mediaStream?.getTracks().forEach((t) => t.stop());
  STATE.mediaStream = null;

  stopVisualizer();

  DOM.btnRecord().textContent = "🎙️";
  DOM.btnRecord().classList.remove("recording");
  DOM.recLabel().textContent = "Press to start recording";
  setStatus("connected", "Connected ✅ | Idle");
  showToast("⏹️ Recording stopped");
}

function toggleRecording() {
  if (!STATE.isConnected) {
    showToast("⚠️ Connect to backend first");
    return;
  }
  STATE.isRecording ? stopRecording() : startRecording();
}

// Space bar shortcut
document.addEventListener("keydown", (e) => {
  const active = document.activeElement;
  if (active === DOM.ngrokUrl() || active === DOM.transcriptBox()) return;
  if (e.code === "Space" && !e.repeat) {
    e.preventDefault();
    if (STATE.isConnected) toggleRecording();
  }
});

// Track empty state on transcript box
DOM.transcriptBox().addEventListener("input", function () {
  this.classList.toggle("empty", !this.textContent.trim());
});

// Init visualizer blank canvas
window.addEventListener("load", () => {
  const c = DOM.visualizer();
  c.width = c.offsetWidth; c.height = c.offsetHeight;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#21262d";
  ctx.fillRect(0, 0, c.width, c.height);
  console.log("✅ Devanagari ASR ready");
});