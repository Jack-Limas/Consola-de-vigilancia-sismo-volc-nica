const TOTAL_CHANNELS = 27;
const CHANNEL_SAMPLES = 120000;

// Configurar SharedArrayBuffer (4 bytes * (27 punteros + 27 * 120,000 muestras))
const bytesNeeded = 4 * (TOTAL_CHANNELS + TOTAL_CHANNELS * CHANNEL_SAMPLES);
const sharedBuffer = new SharedArrayBuffer(bytesNeeded);
const writePointers = new Int32Array(sharedBuffer, 0, TOTAL_CHANNELS);
const dataArray = new Int32Array(sharedBuffer, TOTAL_CHANNELS * 4);

// Crear worker de procesamiento
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.postMessage({ type: 'INIT', buffer: sharedBuffer });

const canvas = document.getElementById('seismicCanvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;

worker.onmessage = (e) => {
  if (e.data.type === 'EVENT_CONFIRMED') {
    statusEl.innerText = `🚨 ¡EVENTO SÍSMICO CONFIRMADO! (${e.data.count} estaciones activas)`;
    statusEl.style.color = 'red';
  }
};

// Algoritmo de Diezmado Min/Max (RF-6) para redibujar a 60 fps
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const trackHeight = canvas.height / TOTAL_CHANNELS;

  for (let ch = 0; ch < TOTAL_CHANNELS; ch++) {
    const head = Atomics.load(writePointers, ch);
    const channelOffset = ch * CHANNEL_SAMPLES;

    ctx.beginPath();
    ctx.strokeStyle = '#00ffcc';
    ctx.lineWidth = 1;

    // Visualizar las últimas 1,000 muestras (5 segundos)
    const samplesToShow = 1000;
    const step = canvas.width / samplesToShow;

    for (let i = 0; i < samplesToShow; i++) {
      const sampleIdx = (head - samplesToShow + i + CHANNEL_SAMPLES) % CHANNEL_SAMPLES;
      const val = dataArray[channelOffset + sampleIdx];

      const x = i * step;
      const y = ch * trackHeight + (trackHeight / 2) - (val / 100);

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  requestAnimationFrame(draw);
}

requestAnimationFrame(draw);