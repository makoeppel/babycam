// static/app.js
// Babycam: WebRTC video+audio, motion indicator, sound meter, PiSugar battery, wake lock.
// Autoplay-safe: audio starts ONLY after a user tap (mobile browsers).

let pc = null;

const videoEl = document.getElementById("video");
const audioEl = document.getElementById("audio");
const tapBtn  = document.getElementById("tapToUnmute");

const soundBar  = document.getElementById("soundBar");
const motionDot = document.getElementById("motionDot");
const motionText= document.getElementById("motionText");
const batPctEl  = document.getElementById("batPct");

// Combine tracks into one stream; play video and audio separately (more reliable on mobile).
const combinedStream = new MediaStream();
videoEl.srcObject = combinedStream;
audioEl.srcObject = combinedStream;

// Video autoplay: keep muted
videoEl.muted = true;
videoEl.playsInline = true;

// Audio autoplay is typically blocked: we unlock on tap
audioEl.muted = true;
audioEl.autoplay = true;
audioEl.volume = 1.0;

// Debug hooks
audioEl.onplaying = () => console.log("[audio] playing");
audioEl.onpause   = () => console.log("[audio] paused");
audioEl.onerror   = (e) => console.log("[audio] error", e);

let audioArrived = false;
let unlocked = false;

// -----------------------------
// WebRTC (video + audio)
// -----------------------------
async function startWebRTC() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  // Force offer to include both m-lines
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.ontrack = (ev) => {
    console.log("[ontrack]", ev.track.kind, ev.track.id);

    try { combinedStream.addTrack(ev.track); } catch (_) {}

    if (ev.track.kind === "audio") {
      audioArrived = true;
      // Optional hint for browsers that support it
      try { ev.track.contentHint = "speech"; } catch (_) {}

      showTapIfNeeded();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch("offer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: pc.localDescription.sdp,
      type: pc.localDescription.type,
    }),
  });

  const answer = await res.json();
  await pc.setRemoteDescription(answer);

  setTimeout(() => {
    const kinds = pc.getReceivers().map(r => r.track && r.track.kind).filter(Boolean);
    console.log("[receivers]", kinds);
  }, 1200);
}

function clearCombinedStream() {
  for (const t of combinedStream.getTracks()) {
    try {
      combinedStream.removeTrack(t);
      t.stop();
    } catch (_) {}
  }
}

async function startWithReconnect() {
  try {
    await startWebRTC();
  } catch (e) {
    console.error("WebRTC start failed:", e);
    setTimeout(startWithReconnect, 2000);
    return;
  }

  // Auto-reconnect if connection drops
  setInterval(() => {
    if (!pc) return;
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      try { pc.close(); } catch (_) {}
      pc = null;

      clearCombinedStream();
      resetSoundMeter();

      audioArrived = false;
      unlocked = false;
      audioEl.muted = true;

      showTapIfNeeded();
      startWithReconnect();
    }
  }, 5000);
}

startWithReconnect();

// -----------------------------
// Wake Lock (keep screen on)
// -----------------------------
let wakeLock = null;
async function keepAwake() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (_) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") keepAwake();
});
keepAwake();

// -----------------------------
// Tap-to-enable audio (single place to unlock playback + AudioContext)
// -----------------------------
function showTapIfNeeded() {
  if (audioArrived && !unlocked) {
    tapBtn.classList.remove("hidden");
    tapBtn.textContent = "Tap to enable audio";
  } else {
    tapBtn.classList.add("hidden");
  }
}

tapBtn.addEventListener("click", unlockAudio, { passive: true });
tapBtn.addEventListener("touchstart", unlockAudio, { passive: true });

// -----------------------------
// Sound meter (start ONLY after unlock)
// -----------------------------
let audioCtx = null;
let soundMeterRAF = null;

function resetSoundMeter() {
  if (soundMeterRAF) cancelAnimationFrame(soundMeterRAF);
  soundMeterRAF = null;

  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  if (soundBar) soundBar.style.width = "0%";
}

async function unlockAudio() {
  if (unlocked) return;

  try {
    // Create/resume AudioContext INSIDE the user gesture (critical for mobile)
    if (!audioCtx) {
      const ACtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new ACtx();
    }
    await audioCtx.resume().catch(() => {});

    // Unmute and play audio element INSIDE the user gesture
    audioEl.muted = false;
    audioEl.volume = 1.0;

    // This call is what browsers require for autoplay-unlock
    await audioEl.play();

    unlocked = true;
    tapBtn.classList.add("hidden");

    // Now start the meter using the already-unlocked AudioContext
    startSoundMeterFromMediaStream(combinedStream);
  } catch (e) {
    console.warn("Audio unlock failed:", e);
    unlocked = false;
    tapBtn.classList.remove("hidden");
  }
}

function startSoundMeterFromMediaStream(ms) {
  if (!audioCtx || soundMeterRAF) return;

  try {
    const src = audioCtx.createMediaStreamSource(ms);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = () => {
      analyser.getByteTimeDomainData(data);

      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(100, Math.max(0, Math.round(rms * 220)));

      if (soundBar) soundBar.style.width = level + "%";
      soundMeterRAF = requestAnimationFrame(tick);
    };

    tick();
  } catch (e) {
    console.warn("Sound meter failed:", e);
  }
}

// -----------------------------
// Motion indicator (client-side frame diff)
// -----------------------------
const SAMPLE_W = 64;
const SAMPLE_H = 36;
const CHECK_MS = 200;
const THRESHOLD = 18; // higher = less sensitive
const HOLD_MS = 1200;

let lastFrame = null;
let motionUntil = 0;

const motionCanvas = document.createElement("canvas");
motionCanvas.width = SAMPLE_W;
motionCanvas.height = SAMPLE_H;
const motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });

function frameDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 8) {
    const y1 = (a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114);
    const y2 = (b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114);
    sum += Math.abs(y1 - y2);
  }
  return sum / (a.length / 8);
}

function setMotion(on) {
  if (!motionDot || !motionText) return;
  motionDot.classList.toggle("on", on);
  motionText.textContent = on ? "Motion" : "No motion";
}

setInterval(() => {
  if (!videoEl.videoWidth || videoEl.readyState < 2) return;

  motionCtx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
  const img = motionCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;

  if (lastFrame) {
    const d = frameDiff(img, lastFrame);
    if (d > THRESHOLD) motionUntil = Date.now() + HOLD_MS;
    setMotion(Date.now() < motionUntil);
  }

  lastFrame = new Uint8ClampedArray(img);
}, CHECK_MS);

// -----------------------------
// PiSugar battery (optional endpoint /pisugar.json)
// -----------------------------
async function updateBattery() {
  if (!batPctEl) return;

  try {
    const res = await fetch("pisugar.json", { cache: "no-store" });
    const j = await res.json();
    if (j.error || j.battery == null) throw new Error(j.error || "no battery");

    const pct = Math.round(j.battery);
    batPctEl.textContent = pct + "%" + (j.charging ? " ⚡" : "");
  } catch (_) {
    batPctEl.textContent = "n/a";
  }
}

updateBattery();
setInterval(updateBattery, 30000);

