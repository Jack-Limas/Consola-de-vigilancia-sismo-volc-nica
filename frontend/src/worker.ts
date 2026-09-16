// Tamaño del buffer circular: 200 Hz * 600 segundos (10 min) = 120,000 muestras por canal
const CHANNEL_SAMPLES = 120000;
const TOTAL_CHANNELS = 27;

let sharedBuffer: SharedArrayBuffer;
let dataArray: Int32Array;
let writePointers: Int32Array; // Posición actual de escritura por canal

// RF-1: Control de tramas para evitar duplicados y desorden por canal
interface Trama {
  seq: number;
  samples: number[];
}
const lastProcessedSeq = new Map<number, number>();
const reorderBuffers = new Map<number, Trama[]>();

// RF-2 & RF-3: Procesador de canal con STA/LTA O(1) y Ventana Deslizante (Monotonic Deque) O(1)
class ChannelProcessor {
  staWindow: number[] = [];
  ltaWindow: number[] = [];
  staSum = 0;
  ltaSum = 0;
  isTriggered = false;
  sampleCounter = 0;

  // RF-3: Monotonic Deque para valor máximo absoluto en ventana móvil de 5s (1000 muestras)
  maxDeque: { val: number; idx: number }[] = [];
  slidingWindow: number[] = [];
  globalIdx = 0;

  processSample(sample: number): { ratio: number; triggered: boolean; maxPeak: number } {
    const valSq = sample * sample;
    const absVal = Math.abs(sample);

    // 1. STA (200 muestras = 1 segundo)
    this.staWindow.push(valSq);
    this.staSum += valSq;
    if (this.staWindow.length > 200) {
      this.staSum -= this.staWindow.shift()!;
    }

    // 2. LTA (6000 muestras = 30 segundos) - Se inhabilita actualización durante el disparo
    if (!this.isTriggered) {
      this.ltaWindow.push(valSq);
      this.ltaSum += valSq;
      if (this.ltaWindow.length > 6000) {
        this.ltaSum -= this.ltaWindow.shift()!;
      }
    }

    // Recálculo periódico para corregir la deriva de punto flotante
    this.sampleCounter++;
    if (this.sampleCounter % 1000 === 0) {
      this.staSum = this.staWindow.reduce((a, b) => a + b, 0);
      if (!this.isTriggered) {
        this.ltaSum = this.ltaWindow.reduce((a, b) => a + b, 0);
      }
    }

    const staAvg = this.staSum / Math.max(1, this.staWindow.length);
    const ltaAvg = this.ltaSum / Math.max(1, this.ltaWindow.length);
    const ratio = ltaAvg > 0 ? staAvg / ltaAvg : 0;

    // Histeresis: ON >= 4.0, OFF <= 1.5
    if (!this.isTriggered && ratio >= 4.0) {
      this.isTriggered = true;
    } else if (this.isTriggered && ratio <= 1.5) {
      this.isTriggered = false;
    }

    // 3. RF-3: Amplitud Pico en Ventana Deslizante de 1,000 muestras (O(1) amortizado)
    this.globalIdx++;
    while (this.maxDeque.length > 0 && this.maxDeque[this.maxDeque.length - 1].val <= absVal) {
      this.maxDeque.pop();
    }
    this.maxDeque.push({ val: absVal, idx: this.globalIdx });

    if (this.maxDeque.length > 0 && this.maxDeque[0].idx <= this.globalIdx - 1000) {
      this.maxDeque.shift();
    }

    const maxPeak = this.maxDeque.length > 0 ? this.maxDeque[0].val : absVal;

    return { ratio, triggered: this.isTriggered, maxPeak };
  }
}

const processors: ChannelProcessor[] = Array.from({ length: TOTAL_CHANNELS }, () => new ChannelProcessor());
const activeTriggers = new Set<number>();

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'INIT') {
    sharedBuffer = e.data.buffer;
    writePointers = new Int32Array(sharedBuffer, 0, TOTAL_CHANNELS);
    dataArray = new Int32Array(sharedBuffer, TOTAL_CHANNELS * 4);

    connectWebSocket();
  }
};

function processChannelSamples(channelIdx: number, stationId: number, samples: number[]) {
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];

    // Escribir en la posición circular del SharedArrayBuffer
    let ptr = Atomics.load(writePointers, channelIdx);
    const writePos = channelIdx * CHANNEL_SAMPLES + ptr;
    dataArray[writePos] = sample;

    // Avanzar puntero atómicamente
    ptr = (ptr + 1) % CHANNEL_SAMPLES;
    Atomics.store(writePointers, channelIdx, ptr);

    // Calcular STA/LTA y Amplitud Pico
    const result = processors[channelIdx].processSample(sample);

    if (result.triggered) {
      activeTriggers.add(stationId);
    } else {
      activeTriggers.delete(stationId);
    }
  }

  // RF-4: Coincidencia multi-estación en línea (al menos 4 estaciones simultáneas)
  if (activeTriggers.size >= 4) {
    self.postMessage({
      type: 'EVENT_CONFIRMED',
      count: activeTriggers.size,
      time: Date.now()
    });
  }
}

function connectWebSocket() {
  // Ajuste dinámico de conexión: usa localhost si estás en local o WSS para Render/Nube
  const WS_URL = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'ws://localhost:4000/ws'
    : `wss://${location.hostname.replace('frontend', 'backend')}/ws`;

  const ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (event: MessageEvent) => {
    const buffer = event.data as ArrayBuffer;
    const view = new DataView(buffer);

    const stationId = view.getUint16(0, true);
    const channel = view.getUint8(2);
    const seq = view.getUint32(4, true);
    const channelIdx = (stationId - 1) * 3 + channel;

    if (channelIdx >= TOTAL_CHANNELS) return;

    // RF-1: Descartar tramas duplicadas o antiguas
    const lastSeq = lastProcessedSeq.get(channelIdx) || 0;
    if (seq <= lastSeq) return;

    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      samples.push(view.getInt32(16 + i * 4, true));
    }

    // Ventana de reordenamiento acotada
    if (!reorderBuffers.has(channelIdx)) {
      reorderBuffers.set(channelIdx, []);
    }
    const buf = reorderBuffers.get(channelIdx)!;
    buf.push({ seq, samples });
    buf.sort((a, b) => a.seq - b.seq);

    // Procesar tramas en orden secuencial estricto
    while (buf.length > 0 && buf[0].seq === (lastProcessedSeq.get(channelIdx) || 0) + 1) {
      const nextTrama = buf.shift()!;
      lastProcessedSeq.set(channelIdx, nextTrama.seq);
      processChannelSamples(channelIdx, stationId, nextTrama.samples);
    }

    // Limpieza de seguridad si se pierden tramas continuas
    if (buf.length > 5) {
      const forcedTrama = buf.shift()!;
      lastProcessedSeq.set(channelIdx, forcedTrama.seq);
      processChannelSamples(channelIdx, stationId, forcedTrama.samples);
    }
  };
}