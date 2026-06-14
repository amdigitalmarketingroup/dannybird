/* Danny Bird — Flappy Bird clon con Danny (carita) en vez de pájaro.
 * Vanilla JS + Canvas. Mobile-first, low-latency, 60fps fijos.
 *
 * Decisiones de diseño clave:
 *  - FÍSICA EN UNIDADES "DE REFERENCIA" (mundo de 640px de alto) escaladas al
 *    tamaño real de pantalla → el feel es idéntico en cualquier celular.
 *  - FIXED TIMESTEP (60Hz) con acumulador → la física es determinista y se siente
 *    igual en pantallas de 60Hz, 90Hz o 120Hz (no se acelera en displays rápidos).
 *  - INPUT directo en pointerdown/keydown (sin click, sin esperar al frame) →
 *    mínima latencia entre control y gameplay.
 */
(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  // ── dimensiones / escala ───────────────────────────────────────────────────
  let W = 0, H = 0, DPR = 1, S = 1; // W,H en px CSS; S = escala vs mundo de referencia
  let safeTop = 0;                  // alto del notch (safe-area) para no tapar el HUD
  // gráficos cacheados (PERF): se construyen 1 vez por tamaño, no por frame.
  // Recrear gradientes y el suelo en cada frame era lo que bajaba los FPS en móvil.
  let bgGrad = null, pipeGrad = null, groundStrip = null, groundStep = 0, gfxDirty = true;
  const REF_H = 640; // mundo de diseño: 640px de alto

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 2); // cap 2: nitidez sin gastar GPU de más
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); // dibujamos en px CSS, el backing store es DPR
    S = H / REF_H;
    safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0;
    gfxDirty = true; // el tamaño cambió → reconstruir gradientes + suelo cacheados
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  resize();

  // ── constantes de física (en unidades de referencia px @ mundo 640) ─────────
  // Valores anclados a los reverse-engineered del Flappy original (gravity 0.25,
  // flap -5, gap ~150, speed 3 @ ~512) y re-escalados/tuneados a 640 por feel.
  const GRAVITY = 1500;     // px/s²
  const FLAP_V = -430;      // px/s (la velocidad que toma al tocar)
  const MAX_FALL = 560;     // px/s (clamp de caída)
  const PIPE_SPEED_BASE = 150; // px/s (scroll inicial)
  const PIPE_SPEED_MAX = 255;  // px/s (tope de velocidad al máximo de dificultad)
  const PIPE_GAP_BASE = 182;   // hueco inicial entre tubos (accesible)
  const PIPE_GAP_MIN = 124;    // hueco mínimo (retador pero pasable)
  const PIPE_W = 72;           // ancho de tubo
  const PIPE_SPACING = 232;    // distancia horizontal entre tubos consecutivos
  const DIFF_RAMP = 40;        // a ~40 puntos se alcanza la dificultad máxima
  const GROUND_H = 96;      // alto del suelo
  const BIRD_DRAW_H = 58;   // alto del sprite dibujado
  const BIRD_HIT_R = 19;    // radio de colisión (más chico que el dibujo = justo)
  const READY_FLOAT = 7;    // amplitud del bobbing en la pantalla de inicio
  const WINGBEAT = 4;       // aleteos por segundo (swap entre los 2 frames de alas)

  // helpers
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);

  // dificultad progresiva por score: la velocidad SUBE y el hueco BAJA, gradual y
  // con tope → arranca accesible y se pone retador (lo que pidió Mario).
  const difficulty = () => clamp(score / DIFF_RAMP, 0, 1);
  const curSpeed = () => PIPE_SPEED_BASE + difficulty() * (PIPE_SPEED_MAX - PIPE_SPEED_BASE);
  const curGap = () => PIPE_GAP_BASE - difficulty() * (PIPE_GAP_BASE - PIPE_GAP_MIN);

  // ── estado ──────────────────────────────────────────────────────────────────
  const READY = 0, PLAYING = 1, OVER = 2;
  let state = READY;
  let score = 0;
  let best = 0;
  try { best = parseInt(localStorage.getItem('dannybird.best') || '0', 10) || 0; } catch (e) { best = 0; }
  let newBest = false;
  let muted = false;
  try { muted = localStorage.getItem('dannybird.muted') === '1'; } catch (e) { muted = false; }
  let overAt = 0;            // timestamp del game over (cooldown anti-restart accidental)
  const RESTART_DELAY = 550; // ms antes de aceptar reinicio

  const bird = { x: 0, y: 0, vy: 0, angle: 0, wing: 0, pump: 0 };
  let pipes = [];
  let groundX = 0;
  let clouds = [];
  let tNow = 0;             // tiempo acumulado (ms) para animaciones
  let flashA = 0;          // alpha del flash blanco al chocar
  let shake = 0;           // screen shake al chocar

  function resetWorld() {
    bird.x = W * 0.28;
    bird.y = H * 0.45;
    bird.vy = 0;
    bird.angle = 0;
    pipes = [];
    score = 0;
    newBest = false;
    flashA = 0;
    shake = 0;
    // sembrar nubes una vez por aspecto
    if (!clouds.length) {
      clouds = [];
      for (let i = 0; i < 4; i++) {
        clouds.push({ x: rand(0, W), y: rand(H * 0.08, H * 0.4), s: rand(0.5, 1), spd: rand(8, 18) });
      }
    }
  }
  resetWorld();

  function startGame() {
    hideOver();
    resetWorld();
    state = PLAYING;
    // primer tubo a una distancia cómoda
    spawnPipe(W + 60);
    flap();
  }

  function spawnPipe(x) {
    const g = curGap();              // hueco actual (unidades de referencia)
    const gap = g * S;
    const margin = 60 * S;
    const groundY = H - GROUND_H * S;
    const gapY = rand(margin + gap / 2, groundY - margin - gap / 2);
    pipes.push({ x, gapY, gap: g, passed: false }); // cada tubo guarda SU hueco
  }

  function gameOver() {
    if (state !== PLAYING) return;
    state = OVER;
    overAt = performance.now();
    flashA = 0.85;
    shake = 14;
    playHit();
    newBest = score > best;
    if (newBest) {
      best = score;
      try { localStorage.setItem('dannybird.best', String(best)); } catch (e) { /* sin storage: no persiste */ }
    }
    showOver(); // overlay HTML: score + entrada de nombre + ranking global + reintentar
  }

  // ── input (latencia mínima: actúa en el mismo evento, sin esperar frame) ─────
  function flap() {
    bird.vy = FLAP_V * S;
    bird.pump = 1; // aletazo fuerte en el momento del tap
    playFlap();
  }
  function onPress() {
    unlockAudio();
    if (state === READY) { startGame(); return; }
    if (state === PLAYING) { flap(); return; }
    // en OVER el reinicio lo maneja el botón del overlay HTML (no el tap del canvas)
  }
  // botón de mute (esquina sup. der., debajo del notch)
  function muteRect() {
    const sz = 40 * S;
    return { x: W - sz - 12 * S, y: safeTop + 10 * S, s: sz };
  }
  function inMuteBtn(x, y) {
    const r = muteRect();
    return x >= r.x - 8 && x <= r.x + r.s + 8 && y >= r.y - 8 && y <= r.y + r.s + 8;
  }
  // pointerdown cubre touch + mouse + pen, y es lo más rápido (no espera click)
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    unlockAudio();
    if (inMuteBtn(px, py)) { toggleMute(); return; } // tocar el ícono = mute, no vuela
    onPress();
  }, { passive: false });
  // teclado: espacio / flecha arriba / W
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      onPress();
    }
  }, { passive: false });

  // ── audio (WebAudio sintetizado, sin archivos, libre de licencia) ───────────
  let actx = null;
  function unlockAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      startMusic();
    } catch (e) { actx = null; }
  }
  function beep(freq, dur, type, vol, slideTo) {
    if (!actx || muted) return;
    try {
      const t = actx.currentTime;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* audio no crítico */ }
  }
  const playFlap = () => beep(620, 0.09, 'square', 0.12, 900);
  function playScore() { beep(880, 0.08, 'triangle', 0.14); setTimeout(() => beep(1175, 0.1, 'triangle', 0.14), 70); }
  function playHit() {
    beep(180, 0.18, 'sawtooth', 0.18, 60);
    if (!actx || muted) return;
    try { // ruido corto = "golpe"
      const t = actx.currentTime, n = 0.12, buf = actx.createBuffer(1, actx.sampleRate * n, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = actx.createBufferSource(); const g = actx.createGain();
      src.buffer = buf; g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.0001, t + n);
      src.connect(g); g.connect(actx.destination); src.start(t);
    } catch (e) { /* noop */ }
  }

  // ── música de fondo (chiptune sintetizado en loop, sin archivos) ────────────
  // Scheduler con look-ahead (patrón WebAudio estándar): un setInterval barato
  // agenda las notas ~120ms al futuro con timing de muestreo exacto → no se
  // desincroniza ni glitchea aunque el rAF varíe. Progresión alegre I–vi–IV–V
  // en Do, melodía en pentatónica mayor (siempre suena consonante).
  let musicGain = null, musicTimer = null, nextNoteTime = 0, step16 = 0;
  const BPM = 130, EIGHTH = 60 / BPM / 2; // segundos por corchea
  const MELODY = [84, 81, 79, 76, 79, 81, 84, 88, 84, 81, 79, 76, 74, 76, 79, 81]; // C maj pentatónica
  const BASS = [48, 45, 41, 43]; // C2 A2 F2 G2 (un acorde por 4 corcheas)
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function musicNote(midi, dur, type, vol, when) {
    if (!actx || !musicGain) return;
    try {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(midiToFreq(midi), when);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(vol, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      o.connect(g); g.connect(musicGain);
      o.start(when); o.stop(when + dur + 0.02);
    } catch (e) { /* música no crítica */ }
  }
  function scheduleMusic() {
    if (!actx || muted) return;
    const horizon = actx.currentTime + 0.12;
    while (nextNoteTime < horizon) {
      if (state !== OVER) { // en game over la música calla (vuelve al reintentar)
        const m = MELODY[step16 % MELODY.length];
        if (m) musicNote(m, EIGHTH * 0.92, 'square', 0.045, nextNoteTime);
        if (step16 % 4 === 0) musicNote(BASS[(step16 / 4) % BASS.length], EIGHTH * 3.7, 'triangle', 0.06, nextNoteTime);
      }
      nextNoteTime += EIGHTH;
      step16++;
    }
  }
  function startMusic() {
    if (!actx || musicTimer) return;
    musicGain = actx.createGain();
    musicGain.gain.value = muted ? 0 : 1;
    musicGain.connect(actx.destination);
    nextNoteTime = actx.currentTime + 0.08;
    musicTimer = setInterval(scheduleMusic, 50);
  }
  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('dannybird.muted', muted ? '1' : '0'); } catch (e) { /* noop */ }
    if (musicGain) musicGain.gain.value = muted ? 0 : 1;
    unlockAudio(); // por si aún no había contexto
  }

  // ── scoreboard global (mini-API en /api del MISMO dominio → sin CORS) ───────
  const ovEl = document.getElementById('over');
  const ovScore = document.getElementById('ovScore');
  const ovBest = document.getElementById('ovBest');
  const ovNewbest = document.getElementById('ovNewbest');
  const ovEntry = document.getElementById('ovEntry');
  const ovName = document.getElementById('ovName');
  const ovSave = document.getElementById('ovSave');
  const ovMsg = document.getElementById('ovMsg');
  const ovLb = document.getElementById('ovLb');
  const ovRetry = document.getElementById('ovRetry');
  let lbSubmitted = false;

  try { ovName.value = (localStorage.getItem('dannybird.name') || '').toUpperCase(); } catch (e) { /* sin storage */ }
  ovName.addEventListener('input', () => {
    ovName.value = ovName.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function renderLeaderboard(scores, meName) {
    if (!scores || !scores.length) { ovLb.innerHTML = '<li class="over-lb-empty">sé el primero 🐦</li>'; return; }
    let meDone = false;
    ovLb.innerHTML = scores.map((s, i) => {
      const me = !meDone && meName && s.name === meName ? ' lb-me' : '';
      if (me) meDone = true;
      return `<li class="lb-rank-${i + 1}${me}"><span class="lb-rank">${i + 1}</span><span class="lb-name">${escapeHtml(s.name)}</span><span class="lb-score">${s.score}</span></li>`;
    }).join('');
  }
  async function fetchLeaderboard(meName) {
    try {
      const r = await fetch('/api/scores?limit=10', { cache: 'no-store' });
      const d = await r.json();
      renderLeaderboard(d.scores, meName);
    } catch (e) {
      ovLb.innerHTML = '<li class="over-lb-empty">no se pudo cargar el ranking</li>';
    }
  }
  function showOver() {
    ovScore.textContent = String(score);
    ovBest.textContent = String(best);
    ovNewbest.classList.toggle('hidden', !newBest);
    ovMsg.classList.add('hidden'); ovMsg.classList.remove('err');
    lbSubmitted = false;
    ovSave.disabled = false; ovName.disabled = false;
    ovEntry.classList.toggle('hidden', score <= 0); // sin score, no se envía
    ovLb.innerHTML = '<li class="over-lb-loading">cargando…</li>';
    ovEl.classList.remove('hidden'); ovEl.setAttribute('aria-hidden', 'false');
    fetchLeaderboard();
  }
  function hideOver() { ovEl.classList.add('hidden'); ovEl.setAttribute('aria-hidden', 'true'); }

  ovSave.addEventListener('click', async () => {
    if (lbSubmitted) return;
    const name = ovName.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (!name) { ovMsg.textContent = 'pon tu nombre'; ovMsg.className = 'over-msg err'; ovName.focus(); return; }
    try { localStorage.setItem('dannybird.name', name); } catch (e) { /* noop */ }
    ovSave.disabled = true; ovName.disabled = true;
    ovMsg.textContent = 'guardando…'; ovMsg.className = 'over-msg';
    try {
      const r = await fetch('/api/scores', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, score }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'error');
      lbSubmitted = true;
      ovMsg.textContent = d.rank ? `¡Guardado! Lugar #${d.rank} 🏆` : '¡Guardado! 🏆';
      ovMsg.className = 'over-msg';
      renderLeaderboard(d.scores, name);
    } catch (e) {
      ovSave.disabled = false; ovName.disabled = false;
      ovMsg.textContent = 'no se pudo guardar, reintenta'; ovMsg.className = 'over-msg err';
    }
  });
  ovName.addEventListener('keydown', (e) => { if (e.key === 'Enter') ovSave.click(); });
  ovRetry.addEventListener('click', () => { hideOver(); state = READY; resetWorld(); });

  // ── sprite del jugador (player.png) con fallback procedural ─────────────────
  const sprite = new Image();         // frame 1: alas extendidas/arriba
  let spriteReady = false, spriteFailed = false;
  sprite.onload = () => { spriteReady = true; };
  sprite.onerror = () => { spriteFailed = true; console.warn('[danny] player.png no cargó, uso carita procedural'); };
  sprite.src = 'assets/player.png';

  const sprite2 = new Image();        // frame 2: alas abajo/recogidas (aleteo real)
  let sprite2Ready = false;
  sprite2.onload = () => { sprite2Ready = true; };
  sprite2.onerror = () => { sprite2Ready = false; };
  sprite2.src = 'assets/player2.png';

  function drawBird() {
    const h = BIRD_DRAW_H * S;
    const ratio = spriteReady ? sprite.width / sprite.height : 0.86;
    const w = h * ratio;
    // aleteo REAL por frames: en la mitad baja del ciclo se muestra el frame de
    // alas abajo (sprite2); arriba, el de alas extendidas (sprite). Ambos frames
    // están recortados a la MISMA caja → la cabeza no salta al alternar.
    const frame = (Math.sin(bird.wing * Math.PI * 2) < 0 && sprite2Ready) ? sprite2 : sprite;
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.angle);
    if (spriteReady) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(frame, -w / 2, -h / 2, w, h);
    } else {
      // fallback: carita simple (círculo + ojo) si player.png falta
      ctx.fillStyle = '#f7d9a0';
      ctx.beginPath(); ctx.arc(0, 0, h / 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(h * 0.18, -h * 0.08, h * 0.08, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ── render de tubos (procedural estilo clásico, verde con tapa y brillo) ─────
  function drawPipe(p) {
    const gap = (p.gap || PIPE_GAP_BASE) * S, w = PIPE_W * S;
    const topH = p.gapY - gap / 2, botY = p.gapY + gap / 2;
    const groundY = H - GROUND_H * S;
    const capH = 26 * S, capOver = 5 * S;
    // gradiente CACHEADO (0..w): se posiciona con translate por tubo (sin recrearlo)
    ctx.save();
    ctx.translate(p.x, 0);
    ctx.fillStyle = pipeGrad;
    ctx.fillRect(0, 0, w, topH);                              // tubo superior
    ctx.fillRect(-capOver, topH - capH, w + capOver * 2, capH);
    ctx.fillRect(0, botY, w, groundY - botY);                // tubo inferior
    ctx.fillRect(-capOver, botY, w + capOver * 2, capH);
    ctx.strokeStyle = 'rgba(40,80,20,0.55)'; ctx.lineWidth = Math.max(1, 2 * S);
    ctx.strokeRect(0, 0, w, topH);
    ctx.strokeRect(-capOver, topH - capH, w + capOver * 2, capH);
    ctx.strokeRect(0, botY, w, groundY - botY);
    ctx.strokeRect(-capOver, botY, w + capOver * 2, capH);
    ctx.restore();
  }

  // ── fondo + suelo ────────────────────────────────────────────────────────────
  function drawBackground() {
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H); // gradiente cacheado (no por frame)
    // nubes
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const c of clouds) {
      const r = 26 * S * c.s;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.arc(c.x + r * 0.9, c.y + r * 0.2, r * 0.8, 0, Math.PI * 2);
      ctx.arc(c.x - r * 0.9, c.y + r * 0.2, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function drawGround() {
    // suelo PRE-RENDERIZADO una vez (groundStrip = W + un período de rayas) → un solo
    // drawImage por frame con el desplazamiento del scroll (antes: ~20 paths/frame).
    const gy = H - GROUND_H * S, step = groundStep || 1;
    let off = groundX % step; if (off > 0) off -= step; // off en (-step, 0]
    ctx.drawImage(groundStrip, off, gy);
  }

  // construye los gráficos cacheados (gradientes + tira de suelo). Se llama 1 vez por
  // tamaño desde render() cuando gfxDirty — NO por frame. Aquí ya existen las consts.
  function buildGfx() {
    bgGrad = ctx.createLinearGradient(0, 0, 0, H);
    bgGrad.addColorStop(0, '#4ec0f0'); bgGrad.addColorStop(0.7, '#8fd6f5'); bgGrad.addColorStop(1, '#cdeefb');
    pipeGrad = ctx.createLinearGradient(0, 0, PIPE_W * S, 0);
    pipeGrad.addColorStop(0, '#5bbf3a'); pipeGrad.addColorStop(0.35, '#7ed957');
    pipeGrad.addColorStop(0.55, '#9be86f'); pipeGrad.addColorStop(1, '#4e9c2f');
    const step = Math.max(2, Math.round(26 * S));
    groundStep = step;
    const gh = Math.ceil(GROUND_H * S), gw = Math.ceil(W) + step;
    groundStrip = document.createElement('canvas');
    groundStrip.width = gw; groundStrip.height = gh;
    const g = groundStrip.getContext('2d');
    g.fillStyle = '#ded895'; g.fillRect(0, 0, gw, gh);
    g.fillStyle = '#caa45a'; g.fillRect(0, 0, gw, 8 * S);
    g.fillStyle = '#d6cf86';
    for (let x = 0; x < gw; x += step) {
      g.beginPath();
      g.moveTo(x, 8 * S);
      g.lineTo(x + step * 0.5, 8 * S);
      g.lineTo(x + step * 0.5 - 8 * S, gh);
      g.lineTo(x - 8 * S, gh);
      g.fill();
    }
    g.fillStyle = '#b89a52'; g.fillRect(0, gh - 4 * S, gw, 4 * S);
  }

  // ── texto con contorno (legible sobre cualquier fondo) ──────────────────────
  const FONT = (px) => `700 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  function text(str, x, y, size, fill, stroke, align, maxW) {
    // auto-shrink: si maxW está dado y el texto no cabe, reduce el tamaño (evita
    // que títulos largos se salgan de pantalla en celulares angostos)
    let fs = size;
    if (maxW) {
      ctx.font = FONT(fs);
      const w = ctx.measureText(str).width;
      if (w > maxW) fs = size * (maxW / w);
    }
    ctx.font = FONT(fs);
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    if (stroke) { ctx.lineWidth = fs * 0.18; ctx.strokeStyle = stroke; ctx.strokeText(str, x, y); }
    ctx.fillStyle = fill; ctx.fillText(str, x, y);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ── update (fixed step, dt en segundos) ─────────────────────────────────────
  function update(dt) {
    // aleteo: las alas baten siempre (flutter) y fuerte tras cada tap (pump decae)
    // las alas baten siempre; tras un tap el aleteo se acelera (pump) y decae
    if (state !== OVER) bird.wing += dt * WINGBEAT * (1 + bird.pump * 2);
    bird.pump = Math.max(0, bird.pump - dt * 3.2);
    // nubes siempre flotan (decoración)
    for (const c of clouds) {
      c.x -= c.spd * S * dt;
      if (c.x < -40 * S) { c.x = W + 40 * S; c.y = rand(H * 0.08, H * 0.4); }
    }
    if (flashA > 0) flashA = Math.max(0, flashA - dt * 2.2);
    if (shake > 0) shake = Math.max(0, shake - dt * 60);

    if (state === READY) {
      bird.y = H * 0.45 + Math.sin(tNow / 280) * READY_FLOAT * S;
      bird.angle = Math.sin(tNow / 280) * 0.08;
      groundX -= PIPE_SPEED_BASE * S * dt;
      return;
    }
    if (state === OVER) {
      // el pájaro sigue cayendo hasta el suelo (detalle clásico)
      const groundY = H - GROUND_H * S;
      if (bird.y < groundY - BIRD_HIT_R * S) {
        bird.vy = Math.min(bird.vy + GRAVITY * S * dt, MAX_FALL * S);
        bird.y += bird.vy * dt;
        bird.angle = Math.min(bird.angle + 6 * dt, Math.PI / 2);
      } else {
        bird.y = groundY - BIRD_HIT_R * S;
      }
      return;
    }

    // PLAYING
    bird.vy = Math.min(bird.vy + GRAVITY * S * dt, MAX_FALL * S);
    bird.y += bird.vy * dt;

    // tilt: sube = nariz arriba, cae rápido = nariz abajo (mapea vy → ángulo)
    const tgt = clamp(map(bird.vy, FLAP_V * S, MAX_FALL * S, -0.45, 1.4), -0.45, 1.4);
    bird.angle = lerp(bird.angle, tgt, clamp(dt * 12, 0, 1));

    // suelo + tubos scrollean (la velocidad sube con el score)
    const sp = curSpeed() * S;
    groundX -= sp * dt;
    for (const p of pipes) p.x -= sp * dt;

    // spawn por distancia (cadencia clásica ~1.5s)
    const lastX = pipes.length ? pipes[pipes.length - 1].x : -Infinity;
    if (lastX < W - PIPE_SPACING * S) spawnPipe(W + PIPE_W * S * 0.5);

    // limpiar tubos fuera de pantalla
    if (pipes.length && pipes[0].x < -PIPE_W * S - 10) pipes.shift();

    // score: al cruzar el tubo
    for (const p of pipes) {
      if (!p.passed && p.x + PIPE_W * S < bird.x) {
        p.passed = true; score++; playScore();
      }
    }

    // colisiones
    const groundY = H - GROUND_H * S;
    const r = BIRD_HIT_R * S;
    if (bird.y + r >= groundY) { bird.y = groundY - r; gameOver(); return; }
    if (bird.y - r < 0) { bird.y = r; bird.vy = 0; } // techo: NO mata (fiel al original), solo topa
    const w = PIPE_W * S;
    for (const p of pipes) {
      const gap = p.gap * S; // cada tubo usa SU hueco (progresivo)
      if (bird.x + r > p.x && bird.x - r < p.x + w) {
        if (bird.y - r < p.gapY - gap / 2 || bird.y + r > p.gapY + gap / 2) { gameOver(); return; }
      }
    }
  }
  function map(v, a, b, c, d) { return c + ((v - a) / (b - a)) * (d - c); }

  // ── render ────────────────────────────────────────────────────────────────
  function render() {
    if (gfxDirty) { buildGfx(); gfxDirty = false; } // (re)construye gráficos cacheados 1 vez
    ctx.save();
    if (shake > 0) ctx.translate(rand(-shake, shake), rand(-shake, shake));
    drawBackground();
    for (const p of pipes) drawPipe(p);
    drawGround();
    drawBird();
    ctx.restore();

    // HUD por estado
    if (state === PLAYING) {
      text(String(score), W / 2, H * 0.14, 64 * S, '#fff', 'rgba(0,0,0,0.55)');
    } else if (state === READY) {
      text('DANNY BIRD', W / 2, H * 0.22, 46 * S, '#fff', 'rgba(0,0,0,0.5)', 'center', W * 0.86);
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(tNow / 400));
      ctx.globalAlpha = pulse;
      text('TAP PARA VOLAR', W / 2, H * 0.62, 26 * S, '#fff', 'rgba(0,0,0,0.5)', 'center', W * 0.8);
      ctx.globalAlpha = 1;
      text('toca / espacio', W / 2, H * 0.67, 16 * S, 'rgba(255,255,255,0.85)', 'rgba(0,0,0,0.35)');
      if (best > 0) text('MEJOR: ' + best, W / 2, H * 0.74, 20 * S, '#ffe680', 'rgba(0,0,0,0.45)');
    } else if (state === OVER) {
      // solo el flash del golpe; el panel (score/nombre/ranking/reintentar) lo dibuja
      // el overlay HTML (#over) encima, que además aporta su propio oscurecido.
      if (flashA > 0) { ctx.fillStyle = `rgba(255,255,255,${flashA})`; ctx.fillRect(0, 0, W, H); }
    }
    if (state !== OVER) drawMute(); // en OVER manda el overlay HTML
  }

  function drawMute() {
    const r = muteRect();
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#000';
    roundRect(r.x, r.y, r.s, r.s, 9 * S); ctx.fill();
    ctx.globalAlpha = 1;
    const cx = r.x + r.s * 0.40, cy = r.y + r.s / 2, u = r.s * 0.5;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1.5, 2 * S); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // cuerpo de la bocina
    ctx.beginPath();
    ctx.moveTo(cx - u * 0.5, cy - u * 0.2);
    ctx.lineTo(cx - u * 0.16, cy - u * 0.2);
    ctx.lineTo(cx + u * 0.14, cy - u * 0.46);
    ctx.lineTo(cx + u * 0.14, cy + u * 0.46);
    ctx.lineTo(cx - u * 0.16, cy + u * 0.2);
    ctx.lineTo(cx - u * 0.5, cy + u * 0.2);
    ctx.closePath(); ctx.fill();
    if (muted) {
      ctx.beginPath();
      ctx.moveTo(cx + u * 0.34, cy - u * 0.32); ctx.lineTo(cx + u * 0.74, cy + u * 0.32);
      ctx.moveTo(cx + u * 0.74, cy - u * 0.32); ctx.lineTo(cx + u * 0.34, cy + u * 0.32);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx + u * 0.16, cy, u * 0.42, -Math.PI / 3.2, Math.PI / 3.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + u * 0.16, cy, u * 0.72, -Math.PI / 3.2, Math.PI / 3.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── loop principal: FIXED TIMESTEP 60Hz con acumulador ──────────────────────
  const STEP = 1000 / 60;     // ms por paso de física
  const DT = 1 / 60;          // segundos por paso
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    let elapsed = now - last; last = now;
    if (elapsed > 250) elapsed = 250; // tras cambiar de pestaña, no acumular un salto enorme
    tNow += elapsed;
    acc += elapsed;
    let steps = 0;
    while (acc >= STEP && steps < 5) { update(DT); acc -= STEP; steps++; }
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // re-pausar/reanudar audio al volver a la pestaña (evita glitches de WebAudio)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && actx && actx.state === 'suspended') actx.resume();
    last = performance.now(); // no acumular el tiempo en background
  });
})();
