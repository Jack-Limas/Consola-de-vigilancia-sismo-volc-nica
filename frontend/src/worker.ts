// Tamaño del buffer circular: 200 Hz * 600 segundos (10 min) = 120,000 muestras por canal
const CHANNEL_SAMPLES = 120000;
const TOTAL_CHANNELS = 27;

let sharedBuffer: SharedArrayBuffer;
let dataArray: Int32Array;
let writePointers: Int32Array; // Guardará la posición actual de escritura por canal

// Estructura para STA/LTA por canal
class ChannelProcessor {
  staWindow: number[] = [];
  ltaWindow: number[] = [];
  staSum = 0;
  ltaSum = 0;
  isTriggered = false;
  sampleCounter = 0;

  processSample(sample: number): { ratio: number; triggered: boolean } {
    const valSq = sample * sample;

    // STA (200 muestras = 1 segundo)
    this.staWindow.push(valSq);
    this.staSum += valSq;
    if (this.staWindow.length > 200) {
      this.staSum -= this.staWindow.shift()!;
    }

    // LTA (6000 muestras = 30 segundos) - Solo actualiza si no hay disparo
    if (!this.isTriggered) {
      this.ltaWindow.push(valSq);
      this.ltaSum += valSq;
      if (this.ltaWindow.length > 6000) {
        this.ltaSum -= this.ltaWindow.shift()!;
      }
    }

    // Recálculo periódico para corregir deriva flotante
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

    return { ratio, triggered: this.isTriggered };
  }
}

const processors: ChannelProcessor[] = Array.from({ length: TOTAL_CHANNELS }, () => new ChannelProcessor());
const activeTriggers = new Set<number>();

self.onmessage = (e) => {
  if (e.data.type === 'INIT') {
    sharedBuffer = e.data.buffer;
    // Reserva los primeros 27 enteros como punteros de escritura
    writePointers = new Int32Array(sharedBuffer, 0, TOTAL_CHANNELS);
    // El resto es para almacenar las muestras de audio/aceleración
    dataArray = new Int32Array(sharedBuffer, TOTAL_CHANNELS * 4);

    connectWebSocket();
  }
};

function connectWebSocket() {
  const ws = new WebSocket('ws://localhost:4000/ws');
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (event: MessageEvent) => {
    const buffer = event.data as ArrayBuffer;
    const view = new DataView(buffer);

    const stationId = view.getUint16(0, true);
    const channel = view.getUint8(2);
    const channelIdx = (stationId - 1) * 3 + channel;

    if (channelIdx >= TOTAL_CHANNELS) return;

    // Leer 50 muestras e insertarlas en SharedArrayBuffer
    for (let i = 0; i < 50; i++) {
      const sample = view.getInt32(16 + i * 4, true);

      // Escribir en la posición circular
      let ptr = Atomics.load(writePointers, channelIdx);
      const writePos = channelIdx * CHANNEL_SAMPLES + ptr;
      dataArray[writePos] = sample;

      // Avanzar puntero atómicamente
      ptr = (ptr + 1) % CHANNEL_SAMPLES;
      Atomics.store(writePointers, channelIdx, ptr);

      // Calcular STA/LTA
      const result = processors[channelIdx].processSample(sample);

      if (result.triggered) {
        activeTriggers.add(stationId);
      } else {
        activeTriggers.delete(stationId);
      }
    }

    // RF-4: Verificar coincidencia multi-estación (mínimo 4 estaciones en disparo)
    if (activeTriggers.size >= 4) {
      self.postMessage({ type: 'EVENT_CONFIRMED', count: activeTriggers.size, time: Date.now() });
    }
  };
}