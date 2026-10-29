/* Chamada Facial — todo o reconhecimento roda no dispositivo (face-api.js). */
'use strict';

const CONFIG = {
  MODELS_LOCAL: '/models',
  MODELS_CDN: 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights',
  MATCH_THRESHOLD: 0.5,      // distância euclidiana máxima (menor = mais rígido)
  CONFIRM_FRAMES: 3,         // frames consecutivos com o mesmo aluno antes de enviar
  COOLDOWN_MS: 30_000,       // não reenviar o mesmo aluno antes disso
  DETECT_INTERVAL_MS: 120,   // ~8 detecções/s: equilíbrio CPU/latência no tablet
  REFRESH_EMBEDDINGS_MS: 60_000,
  ENROLL_SAMPLES: 5,
  BANNER_IDLE_MS: 4000,
};

const $ = (id) => document.getElementById(id);
const video = $('video'), canvas = $('overlay'), ctx = canvas.getContext('2d');

const state = {
  mode: 'chamada',
  matcher: null,
  alunos: new Map(),          // id(string) -> {id, nome, matricula}
  cooldown: new Map(),        // id -> timestamp do último envio
  streak: { label: null, count: 0 },
  inFlight: new Set(),
  enrolling: false,
  lastDetections: [],
  bannerTimer: null,
  audioCtx: null,
};

const detectorOptions = () =>
  new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

/* ---------------------------------------------------------------- UI ---- */
function setBanner(kind, icon, title, sub = '', sticky = false) {
  const b = $('banner');
  b.className = `banner glass ${kind}`;
  $('banner-icon').textContent = icon;
  $('banner-title').textContent = title;
  $('banner-sub').textContent = sub;
  clearTimeout(state.bannerTimer);
  if (!sticky) state.bannerTimer = setTimeout(idleBanner, CONFIG.BANNER_IDLE_MS);
}
function idleBanner() {
  if (state.mode === 'chamada') setBanner('', '🙂', 'Aproxime-se da câmera', 'Olhe para a tela para registrar sua presença', true);
  else setBanner('', '📝', 'Modo Cadastro', 'Preencha os dados e capture o rosto', true);
}
function successFx() {
  const wrap = $('camera-wrap'), flash = $('flash');
  wrap.classList.add('success');
  flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
  setTimeout(() => wrap.classList.remove('success'), 1500);
}
let diaAtual = null;
function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dia = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (dia !== diaAtual) {
    if (diaAtual !== null) { state.cooldown.clear(); loadPresencasHoje(); } // virou o dia: nova chamada
    diaAtual = dia;
    $('date').textContent = dia;
  }
}

/* Som gerado via WebAudio (dispensa arquivos de áudio). */
function beep(type = 'ok') {
  try {
    state.audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const ac = state.audioCtx, now = ac.currentTime;
    const notes = type === 'ok' ? [880, 1320] : type === 'warn' ? [660, 660] : [220];
    notes.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.35, now + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.13);
      o.connect(g).connect(ac.destination);
      o.start(now + i * 0.14); o.stop(now + i * 0.14 + 0.14);
    });
  } catch { /* áudio indisponível */ }
  if (type === 'ok' && navigator.vibrate) navigator.vibrate(120);
}

/* ------------------------------------------------------------ Modelos --- */
async function loadModels() {
  const load = (uri) => Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(uri),
    faceapi.nets.faceLandmark68Net.loadFromUri(uri),
    faceapi.nets.faceRecognitionNet.loadFromUri(uri),
  ]);
  try { await load(CONFIG.MODELS_LOCAL); }
  catch (e) {
    console.warn('Modelos locais indisponíveis, usando CDN.', e);
    await load(CONFIG.MODELS_CDN);
  }
}

async function loadEmbeddings() {
  const res = await fetch('/api/alunos/embeddings', { cache: 'no-store' });
  if (!res.ok) throw new Error('Falha ao carregar embeddings');
  const lista = await res.json();
  state.alunos.clear();
  const labeled = lista
    .filter((a) => Array.isArray(a.embedding) && a.embedding.length === 128)
    .map((a) => {
      state.alunos.set(String(a.id), a);
      return new faceapi.LabeledFaceDescriptors(String(a.id), [new Float32Array(a.embedding)]);
    });
  state.matcher = labeled.length ? new faceapi.FaceMatcher(labeled, CONFIG.MATCH_THRESHOLD) : null;
  console.info(`${labeled.length} aluno(s) carregado(s).`);
}

async function loadPresencasHoje() {
  try {
    const lista = await (await fetch('/api/presencas/hoje', { cache: 'no-store' })).json();
    const ul = $('lista-presencas'); ul.innerHTML = '';
    lista.forEach((p) => ul.append(itemPresenca(p.nome, p.timestamp)));
    $('count').textContent = lista.length;
  } catch { /* não crítico */ }
}
function itemPresenca(nome, ts) {
  const li = document.createElement('li');
  const hora = new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  li.innerHTML = `<span></span><small>${hora}</small>`;
  li.firstChild.textContent = nome;
  return li;
}

/* ------------------------------------------------------------- Câmera --- */
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Câmera indisponível. Acesse via HTTPS (ou localhost).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await new Promise((r) => (video.onloadedmetadata = r));
  await video.play();
}

/* Ajusta o canvas ao tamanho real do vídeo; desenho em coordenadas de vídeo
   e o CSS (object-fit: cover + espelhamento) mantém o alinhamento. */
function syncCanvas() {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  }
}

function drawBox(box, color, label) {
  const { x, y, width, height } = box;
  ctx.lineWidth = 4; ctx.strokeStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 18;
  ctx.beginPath(); ctx.roundRect(x, y, width, height, 18); ctx.stroke();
  ctx.shadowBlur = 0;
  if (!label) return;
  // Texto precisa ser "des-espelhado", pois o canvas inteiro é espelhado via CSS.
  ctx.save();
  ctx.scale(-1, 1);
  ctx.font = '600 22px Outfit, sans-serif';
  const tw = ctx.measureText(label).width + 20;
  const lx = -(x + width), ly = y - 38;
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(lx, ly, tw, 32, 10); ctx.fill();
  ctx.fillStyle = '#0b1020'; ctx.fillText(label, lx + 10, ly + 23);
  ctx.restore();
}

/* -------------------------------------------------------- Loop de detecção */
async function detectionLoop() {
  const t0 = performance.now();
  try {
    if (video.readyState >= 2 && !state.enrolling) {
      syncCanvas();
      const dets = await faceapi
        .detectAllFaces(video, detectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptors();
      state.lastDetections = dets;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (state.mode === 'chamada') handleChamada(dets);
      else dets.forEach((d) => drawBox(d.detection.box, 'hsl(195,95%,55%)'));
    }
  } catch (e) { console.error(e); }
  const wait = Math.max(0, CONFIG.DETECT_INTERVAL_MS - (performance.now() - t0));
  setTimeout(() => requestAnimationFrame(detectionLoop), wait);
}

function handleChamada(dets) {
  if (!dets.length) { state.streak = { label: null, count: 0 }; return; }

  // Considera o maior rosto (o mais próximo do totem) para a chamada.
  const main = dets.reduce((a, b) => (b.detection.box.area > a.detection.box.area ? b : a));

  dets.forEach((d) => {
    const m = state.matcher ? state.matcher.findBestMatch(d.descriptor) : null;
    const known = m && m.label !== 'unknown';
    const aluno = known ? state.alunos.get(m.label) : null;
    const color = known ? 'hsl(152,75%,50%)' : 'hsl(355,85%,62%)';
    const label = known ? `${aluno.nome.split(' (')[0]} · ${(1 - m.distance).toFixed(2)}` : 'Não reconhecido';
    drawBox(d.detection.box, color, label);

    if (d !== main) return;
    const key = known ? m.label : null;
    state.streak = state.streak.label === key
      ? { label: key, count: state.streak.count + 1 }
      : { label: key, count: 1 };
    if (known && state.streak.count >= CONFIG.CONFIRM_FRAMES) registrarPresenca(aluno);
  });
}

/* Debounce/cooldown: confirmação por N frames + janela de 30s por aluno +
   bloqueio de requisição em andamento. */
async function registrarPresenca(aluno) {
  const id = String(aluno.id), now = Date.now();
  if (state.inFlight.has(id)) return;
  if (now - (state.cooldown.get(id) || 0) < CONFIG.COOLDOWN_MS) return;
  state.inFlight.add(id);
  state.cooldown.set(id, now);
  try {
    const res = await fetch('/api/presenca', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aluno_id: aluno.id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Erro no servidor');
    if (data.status === 'registrada') {
      setBanner('ok', '✅', `Presença confirmada: ${data.nome}`, `Matrícula ${data.matricula} · ${new Date(data.timestamp).toLocaleTimeString('pt-BR')}`);
      beep('ok'); successFx();
      $('lista-presencas').prepend(itemPresenca(data.nome, data.timestamp));
      $('count').textContent = Number($('count').textContent) + 1;
    } else {
      setBanner('warn', 'ℹ️', `Olá, ${data.nome}!`, data.mensagem);
      beep('warn');
    }
  } catch (e) {
    state.cooldown.delete(id); // permite nova tentativa
    setBanner('err', '⚠️', 'Falha ao registrar presença', e.message);
    beep('err');
  } finally {
    state.inFlight.delete(id);
  }
}

/* ------------------------------------------------------------ Cadastro --- */
async function capturarCadastro(ev) {
  ev.preventDefault();
  const nome = $('input-nome').value.trim(), matricula = $('input-matricula').value.trim();
  const btn = $('btn-capturar'), bar = $('progress-bar');
  btn.disabled = true; state.enrolling = true;
  const amostras = [];
  try {
    let tentativas = 0;
    while (amostras.length < CONFIG.ENROLL_SAMPLES && tentativas++ < 40) {
      const d = await faceapi.detectSingleFace(video, detectorOptions()).withFaceLandmarks().withFaceDescriptor();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (d && d.detection.score > 0.7) {
        drawBox(d.detection.box, 'hsl(152,75%,50%)', `Amostra ${amostras.length + 1}`);
        amostras.push(d.descriptor);
        bar.style.width = `${(amostras.length / CONFIG.ENROLL_SAMPLES) * 100}%`;
        setBanner('', '📸', `Capturando ${amostras.length}/${CONFIG.ENROLL_SAMPLES}`, 'Mexa levemente a cabeça', true);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (amostras.length < CONFIG.ENROLL_SAMPLES) throw new Error('Rosto não detectado com qualidade suficiente.');

    // Embedding de referência = média das amostras (mais robusto a variação de pose/luz).
    const media = Array.from({ length: 128 }, (_, i) => amostras.reduce((s, a) => s + a[i], 0) / amostras.length);
    const res = await fetch('/api/alunos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, matricula, embedding: media }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data.detail));
    await loadEmbeddings();
    setBanner('ok', '🎉', `${data.nome} cadastrado(a)!`, `Registro ${data.status}. Já pode usar o modo Chamada.`);
    beep('ok'); successFx();
    ev.target.reset();
  } catch (e) {
    setBanner('err', '⚠️', 'Cadastro não concluído', e.message); beep('err');
  } finally {
    btn.disabled = false; state.enrolling = false;
    setTimeout(() => (bar.style.width = '0'), 1200);
  }
}

function setMode(mode) {
  state.mode = mode;
  $('btn-mode-chamada').classList.toggle('active', mode === 'chamada');
  $('btn-mode-cadastro').classList.toggle('active', mode === 'cadastro');
  $('panel-chamada').classList.toggle('hidden', mode !== 'chamada');
  $('panel-cadastro').classList.toggle('hidden', mode !== 'cadastro');
  state.streak = { label: null, count: 0 };
  idleBanner();
}

/* --------------------------------------------------------------- Boot ---- */
async function boot() {
  $('start-overlay').classList.add('hidden');
  beep('warn'); // desbloqueia o áudio (exige gesto do usuário no iOS)
  document.documentElement.requestFullscreen?.().catch(() => {});
  try {
    setBanner('', '⏳', 'Inicializando…', 'Carregando modelos de reconhecimento', true);
    await Promise.all([loadModels(), startCamera()]);
    setBanner('', '⏳', 'Inicializando…', 'Carregando alunos cadastrados', true);
    await loadEmbeddings();
    await loadPresencasHoje();
    $('status-dot').className = 'dot ok';
    idleBanner();
    detectionLoop();
    setInterval(() => loadEmbeddings().catch(console.warn), CONFIG.REFRESH_EMBEDDINGS_MS);
    // Mantém a tela acesa no modo totem, quando suportado.
    navigator.wakeLock?.request('screen').catch(() => {});
  } catch (e) {
    console.error(e);
    $('status-dot').className = 'dot err';
    setBanner('err', '⛔', 'Erro ao iniciar', e.message, true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  tickClock(); setInterval(tickClock, 1000);
  $('btn-start').addEventListener('click', boot, { once: true });
  $('btn-mode-chamada').addEventListener('click', () => setMode('chamada'));
  $('btn-mode-cadastro').addEventListener('click', () => setMode('cadastro'));
  $('form-cadastro').addEventListener('submit', capturarCadastro);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) navigator.wakeLock?.request('screen').catch(() => {});
  });
});
