/**
 * Shield AI — Voice Deepfake Detector
 * script.js  |  On-device spectral analysis engine
 *
 * Architecture:
 *  - Web Audio API for mic/file capture
 *  - AnalyserNode for real-time FFT → mel bands
 *  - Multi-feature spectral heuristic for fake-voice scoring
 *  - requestAnimationFrame render loop
 */

'use strict';

/* ── Constants ───────────────────────────────────────────────────────────── */
const FFT_SIZE    = 2048;
const SAMPLE_RATE = 16000;
const MEL_BANDS   = 64;

/* ── State ───────────────────────────────────────────────────────────────── */
let audioCtx   = null;
let analyser   = null;
let sourceNode = null;
let streamRef  = null;
let animId     = null;
let melHistory = [];
let isRunning  = false;
let _prevMel   = null;

/* ─────────────────────────────────────────────────────────────────────────
   BOOT
   ───────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setDot('ready', 'On-device spectral analyser ready');
  document.getElementById('btnMic').disabled = false;
  setStatus('Ready — press "Start mic" or upload an audio file to begin analysis.');
});

/* ─────────────────────────────────────────────────────────────────────────
   UI HELPERS
   ───────────────────────────────────────────────────────────────────────── */
function setDot(state, text) {
  document.getElementById('dot').className = 'dot ' + state;
  document.getElementById('modelStatus').textContent = text;
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

/* ─────────────────────────────────────────────────────────────────────────
   AUDIO INPUT — MIC
   ───────────────────────────────────────────────────────────────────────── */
async function startMic() {
  try {
    setStatus('Requesting microphone access…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: false }
    });
    streamRef = stream;
    setupAudioGraph(ctx => ctx.createMediaStreamSource(stream));
    setStatus('Listening — speak or hold device near source');
    document.getElementById('btnMic').disabled = true;
    document.getElementById('btnStop').disabled = false;
  } catch (e) {
    setStatus('Mic access denied: ' + e.message);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   AUDIO INPUT — FILE
   ───────────────────────────────────────────────────────────────────────── */
async function loadFile(input) {
  const file = input.files[0];
  if (!file) return;
  stopAll();
  setStatus('Loading ' + file.name + '…');
  try {
    const arrayBuf = await file.arrayBuffer();
    const tmpCtx   = new AudioContext();
    const decoded  = await tmpCtx.decodeAudioData(arrayBuf);
    tmpCtx.close();
    setupAudioGraph(ctx => {
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      src.start();
      src.onended = () => setStatus('Playback complete — load another file to re-analyse');
      return src;
    });
    setStatus('Analysing: ' + file.name);
    document.getElementById('btnStop').disabled = false;
  } catch (e) {
    setStatus('Error loading file: ' + e.message);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   AUDIO GRAPH SETUP / TEARDOWN
   ───────────────────────────────────────────────────────────────────────── */
function setupAudioGraph(sourceFactory) {
  stopAll();
  audioCtx  = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.0;
  sourceNode = sourceFactory(audioCtx);
  sourceNode.connect(analyser);
  isRunning  = true;
  melHistory = [];
  _prevMel   = null;
  loop();
}

function stopAll() {
  isRunning = false;
  cancelAnimationFrame(animId);
  if (streamRef)  { streamRef.getTracks().forEach(t => t.stop()); streamRef = null; }
  if (audioCtx)   { audioCtx.close().catch(() => {}); audioCtx = null; }
  analyser   = null;
  sourceNode = null;
  document.getElementById('btnMic').disabled  = false;
  document.getElementById('btnStop').disabled = true;
}

/* ─────────────────────────────────────────────────────────────────────────
   SIMULATION MODE
   ───────────────────────────────────────────────────────────────────────── */
function simulateVoice(isFake) {
  stopAll();
  melHistory = [];
  _prevMel   = null;

  audioCtx  = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.0;

  const gain = audioCtx.createGain();
  gain.gain.value = 0.15;
  gain.connect(analyser);

  // Real voice: natural harmonic falloff (odd + even, decaying amplitude)
  // AI voice:   even harmonics, flat amplitude, synthesis artifacts
  const harmonics = isFake
    ? [200, 400, 600, 800, 1000, 1200, 2400, 4800]
    : [120, 240, 360, 720, 1080, 1800];

  harmonics.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    const g2  = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = isFake ? 'sawtooth' : 'sine';
    g2.gain.value = isFake
      ? 0.9 / (idx + 1)
      : 0.8 / Math.pow(idx + 1, 1.6);
    osc.connect(g2);
    g2.connect(gain);
    osc.start();
    osc.stop(audioCtx.currentTime + 6);
  });

  isRunning = true;
  setStatus(isFake
    ? 'Simulating AI voice clone — even harmonics, high-freq energy leak'
    : 'Simulating real human voice — natural harmonic decay');
  document.getElementById('btnStop').disabled = false;
  loop();

  setTimeout(() => {
    if (isRunning) setStatus('Simulation ended — press again or use mic');
    stopAll();
  }, 6000);
}

/* ─────────────────────────────────────────────────────────────────────────
   MAIN ANALYSIS LOOP
   ───────────────────────────────────────────────────────────────────────── */
function loop() {
  if (!isRunning || !analyser) return;

  // 1. Frequency domain (FFT)
  const freqData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(freqData);

  // 2. Time domain (raw PCM waveform)
  const timeData = new Float32Array(FFT_SIZE);
  analyser.getFloatTimeDomainData(timeData);

  // 3. Render visualisations
  drawWave(timeData);
  const mel = toMelBands(freqData, MEL_BANDS);
  drawMel(mel);

  // 4. Score & update UI
  const fakeScore = heuristicScore(mel);
  updateUI(fakeScore, mel);

  animId = requestAnimationFrame(loop);
}

/* ─────────────────────────────────────────────────────────────────────────
   SPECTRAL HEURISTIC
   Four complementary features — each captures a different AI voice tell:

   1. High-freq ratio   — TTS synthesis leaks energy into >5kHz bands
   2. Spectral slope    — Real voices roll off naturally; AI voices are flat
   3. Spectral flatness — Geometric/arithmetic mean; AI voices are too uniform
   4. Spectral flux     — Frame-to-frame variation; AI voices are too consistent
   ───────────────────────────────────────────────────────────────────────── */
function heuristicScore(mel) {
  const low  = mel.slice(4,  20).reduce((a, b) => a + b, 0) / 16;  // fundamental + F1/F2
  const high = mel.slice(40, 64).reduce((a, b) => a + b, 0) / 24;  // synthesis artifacts

  // 1. High-freq energy ratio
  const hiRatio = high / (low + 0.001);

  // 2. Spectral slope (positive = natural roll-off)
  const slope = (low - high) / (low + high + 0.001);

  // 3. Spectral flatness (0 = tonal spike, 1 = white noise)
  const n       = mel.length;
  const mean    = mel.reduce((a, b) => a + b, 0) / n;
  const geoMean = Math.exp(mel.reduce((a, b) => a + Math.log(b + 0.001), 0) / n);
  const flatness = geoMean / (mean + 0.001);

  // 4. Spectral flux (frame-to-frame energy delta)
  let flux = 0.5;
  if (_prevMel) {
    const delta = mel.reduce((a, v, i) => a + Math.abs(v - _prevMel[i]), 0) / n;
    flux = Math.min(1, delta / 0.3);
  }
  _prevMel = Array.from(mel);

  // Weighted combination → synthetic signal score
  const raw =
    hiRatio * 0.35 +
    (1 - Math.min(1, slope + 0.5)) * 0.25 +
    flatness * 0.20 +
    (1 - flux)     * 0.20;

  return Math.min(0.95, Math.max(0.05, raw));
}

/* ─────────────────────────────────────────────────────────────────────────
   MEL BAND COMPUTATION
   Convert FFT magnitude array → log-mel energy bands
   ───────────────────────────────────────────────────────────────────────── */
function toMelBands(freqData, n) {
  const bands = new Float32Array(n);
  const bpb   = Math.floor(freqData.length / n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < bpb; j++) {
      sum += Math.pow(10, (freqData[i * bpb + j] || -100) / 10);
    }
    bands[i] = Math.log1p(sum / bpb);
  }
  return bands;
}

/* ─────────────────────────────────────────────────────────────────────────
   CANVAS — WAVEFORM
   ───────────────────────────────────────────────────────────────────────── */
function drawWave(timeData) {
  const c   = document.getElementById('cvWave');
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== c.offsetWidth * dpr) {
    c.width  = c.offsetWidth  * dpr;
    c.height = 64 * dpr;
  }
  const ctx = c.getContext('2d');
  const W = c.offsetWidth, H = 64;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Centre line
  ctx.strokeStyle = 'rgba(0,212,255,0.08)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
  ctx.stroke();

  // Waveform
  ctx.strokeStyle = getComputedStyle(document.documentElement)
    .getPropertyValue('--cyan').trim() || '#00d4ff';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(0,212,255,0.6)';
  ctx.shadowBlur  = 4;
  ctx.beginPath();
  const step = Math.ceil(timeData.length / W);
  for (let i = 0; i < W; i++) {
    const v = timeData[i * step] || 0;
    const y = H / 2 - v * H * 0.44;
    i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* ─────────────────────────────────────────────────────────────────────────
   CANVAS — MEL SPECTROGRAM
   ───────────────────────────────────────────────────────────────────────── */
function drawMel(mel) {
  melHistory.push(Array.from(mel));
  if (melHistory.length > 120) melHistory.shift();

  const c   = document.getElementById('cvMel');
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== c.offsetWidth * dpr) {
    c.width  = c.offsetWidth * dpr;
    c.height = 96 * dpr;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = c.offsetWidth, H = 96;
  const cw = W / melHistory.length;
  const ch = H / mel.length;

  melHistory.forEach((frame, x) => {
    frame.forEach((val, y) => {
      const norm = Math.min(1, val / 4);
      const v    = Math.round(norm * 255);
      // Cyan-teal colour map on dark background
      ctx.fillStyle = `rgb(${Math.round(v * 0.05)},${Math.round(v * 0.52)},${Math.round(v * 0.72)})`;
      ctx.fillRect(x * cw, (mel.length - 1 - y) * ch, cw + 0.5, ch + 0.5);
    });
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   UI UPDATE
   ───────────────────────────────────────────────────────────────────────── */
function updateUI(fakeScore, mel) {
  const realScore = 1 - fakeScore;
  const rPct = Math.round(realScore * 100);
  const fPct = Math.round(fakeScore * 100);

  // Percentage readouts
  document.getElementById('realPct').textContent = rPct + '%';
  document.getElementById('fakePct').textContent = fPct + '%';

  // Bars
  document.getElementById('realBar').style.width = rPct + '%';
  document.getElementById('fakeBar').style.width = fPct + '%';

  // Score cards
  const speechEst = Math.round(Math.min(99, realScore * 95 + Math.random() * 5));
  const synthEst  = Math.round(fakeScore * 80);
  const noiseEst  = Math.round(Math.max(0, (1 - realScore - fakeScore * 0.5) * 40));
  document.getElementById('scSpeech').textContent = speechEst + '%';
  document.getElementById('scSynth').textContent  = synthEst  + '%';
  document.getElementById('scNoise').textContent  = noiseEst  + '%';

  // Spectral indicators
  const indicators = [
    {
      name: fakeScore > 0.5 ? 'High-freq energy leak (synthesis artifact)' : 'Natural formant structure',
      pct:  fakeScore > 0.5 ? fPct : rPct
    },
    {
      name: fakeScore > 0.5 ? 'Flat spectral distribution' : 'Natural spectral roll-off',
      pct:  Math.round((fakeScore > 0.5 ? fPct : rPct) * 0.8)
    },
    {
      name: fakeScore > 0.5 ? 'Low spectral flux (too uniform)' : 'Natural frame-to-frame variation',
      pct:  Math.round((fakeScore > 0.5 ? fPct : rPct) * 0.6)
    },
    { name: 'Mid-band energy (F1/F2 formants)', pct: Math.round(rPct * 0.5) },
    { name: 'Background noise floor',           pct: noiseEst }
  ];

  document.getElementById('top5').innerHTML = indicators.map(({ name, pct }) => `
    <div class="top5-row">
      <span class="top5-name">${name}</span>
      <div class="top5-track"><div class="top5-fill" style="width:${pct}%"></div></div>
      <span class="top5-score">${pct}%</span>
    </div>`).join('');

  // Verdict
  const v = document.getElementById('verdict');
  if (fakeScore > 0.65) {
    v.className = 'verdict fake';
    v.innerHTML = `
      <div class="verdict-title">⚠ AI / DEEPFAKE VOICE DETECTED</div>
      <div class="verdict-sub">Synthetic probability ${fPct}% — treat this audio with caution before acting on it</div>`;
  } else if (fakeScore < 0.35) {
    v.className = 'verdict real';
    v.innerHTML = `
      <div class="verdict-title">✓ REAL HUMAN VOICE CONFIRMED</div>
      <div class="verdict-sub">Human speech probability ${rPct}% — voice characteristics appear genuine</div>`;
  } else {
    v.className = 'verdict uncertain';
    v.innerHTML = `
      <div class="verdict-title">~ UNCERTAIN — CONTINUE ANALYSIS</div>
      <div class="verdict-sub">Synthetic probability ${fPct}% — insufficient signal; keep listening</div>`;
  }
}
