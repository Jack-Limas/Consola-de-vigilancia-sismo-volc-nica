import './styles.css';

const STATIONS = 9;
const CHANNELS_PER_STATION = 3;
const TOTAL_CHANNELS = STATIONS * CHANNELS_PER_STATION;
const SAMPLE_RATE = 200;
const HISTORY_SECONDS = 600;
const CHANNEL_SAMPLES = SAMPLE_RATE * HISTORY_SECONDS;
const CONTROL_FIELDS = 4;
const CONTROL_LENGTH = TOTAL_CHANNELS * CONTROL_FIELDS;
const DATA_OFFSET_BYTES = CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT;
const CHANNEL_NAMES = ['N-S', 'E-O', 'Vertical'];

type StationMessage =
  | { type: 'STATS'; stationId: number; frames: number; duplicates: number; late: number; lost: number; reordered: number; burst: boolean }
  | { type: 'CHANNEL_STATE'; channelIdx: number; ratio: number; peak: number; triggered: boolean }
  | { type: 'WORKER_READY'; stationId: number };

type EventMessage = {
  type: 'EVENT_CONFIRMED';
  event: ConfirmedEvent;
};

type ConfirmedEvent = {
  id: number;
  time: number;
  stations: number[];
  peaks: number[];
};

if (!window.crossOriginIsolated) {
  document.documentElement.classList.add('not-isolated');
}

const bytesNeeded = DATA_OFFSET_BYTES + TOTAL_CHANNELS * CHANNEL_SAMPLES * Int32Array.BYTES_PER_ELEMENT;
const sharedBuffer = new SharedArrayBuffer(bytesNeeded);
const controlArray = new Int32Array(sharedBuffer, 0, CONTROL_LENGTH);
const dataArray = new Int32Array(sharedBuffer, DATA_OFFSET_BYTES);

const canvas = document.querySelector<HTMLCanvasElement>('#seismicCanvas');
const ctx = canvas?.getContext('2d');
const statusEl = getEl('status');
const clockEl = getEl('clock');
const isolationEl = getEl('isolation');
const workerCountEl = getEl('workerCount');
const frameStatsEl = getEl('frameStats');
const inpEl = getEl('inp');
const longTaskEl = getEl('longTasks');
const eventListEl = getEl('eventList');
const exportBtn = document.querySelector<HTMLButtonElement>('#exportBtn');
const liveBtn = document.querySelector<HTMLButtonElement>('#liveBtn');
const zoomRange = document.querySelector<HTMLInputElement>('#zoomRange');
const offsetRange = document.querySelector<HTMLInputElement>('#offsetRange');
const zoomValue = getEl('zoomValue');
const offsetValue = getEl('offsetValue');

if (!canvas || !ctx || !exportBtn || !liveBtn || !zoomRange || !offsetRange) {
  throw new Error('Missing required UI elements');
}

const channelStates = Array.from({ length: TOTAL_CHANNELS }, () => ({
  ratio: 0,
  peak: 0,
  triggered: false,
}));
const stationStats = new Map<number, Omit<Extract<StationMessage, { type: 'STATS' }>, 'type'>>();
const events: ConfirmedEvent[] = [];
let lastEvent: ConfirmedEvent | undefined;
let timeWindowSeconds = Number(zoomRange.value);
let viewOffsetSeconds = 0;
let longTasks = 0;
let inpValue = 0;
let isDragging = false;
let dragStartX = 0;
let dragStartOffset = 0;

const coordinator = new Worker(new URL('./workers/eventCoordinator.ts', import.meta.url), { type: 'module' });
coordinator.onmessage = (message: MessageEvent<EventMessage>) => {
  if (message.data.type !== 'EVENT_CONFIRMED') return;
  lastEvent = message.data.event;
  events.unshift(lastEvent);
  events.splice(8);
  statusEl.textContent = `Evento confirmado: estaciones ${lastEvent.stations.join(', ')}`;
  statusEl.classList.add('alert');
  setTimeout(() => statusEl.classList.remove('alert'), 2200);
  renderEvents();
};

const stationWorkers = Array.from({ length: STATIONS }, (_, index) => {
  const stationId = index + 1;
  const { port1, port2 } = new MessageChannel();
  coordinator.postMessage({ type: 'ATTACH_STATION', stationId, port: port1 }, [port1]);

  const worker = new Worker(new URL('./workers/stationWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (message: MessageEvent<StationMessage>) => handleStationMessage(message.data);
  worker.postMessage({ type: 'INIT', stationId, sharedBuffer, coordinatorPort: port2 }, [port2]);
  return worker;
});

workerCountEl.textContent = `${stationWorkers.length + 1} workers activos`;
isolationEl.textContent = window.crossOriginIsolated ? 'crossOriginIsolated activo' : 'Faltan cabeceras COOP/COEP';

function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function handleStationMessage(message: StationMessage) {
  if (message.type === 'STATS') {
    const { type: _type, ...stats } = message;
    stationStats.set(message.stationId, stats);
    return;
  }

  if (message.type === 'CHANNEL_STATE') {
    channelStates[message.channelIdx] = {
      ratio: message.ratio,
      peak: message.peak,
      triggered: message.triggered,
    };
  }
}

function setupPerformanceObservers() {
  const supported = PerformanceObserver.supportedEntryTypes || [];

  if (supported.includes('longtask')) {
    new PerformanceObserver((list) => {
      longTasks += list.getEntries().length;
      longTaskEl.textContent = `${longTasks} tareas largas`;
    }).observe({ type: 'longtask', buffered: true });
  }

  if (supported.includes('event')) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const eventEntry = entry as PerformanceEntry & {
          interactionId?: number;
          processingStart?: number;
          processingEnd?: number;
          duration: number;
        };
        if (!eventEntry.interactionId) continue;
        inpValue = Math.max(inpValue, eventEntry.duration);
        const inputDelay = Math.max(0, (eventEntry.processingStart ?? eventEntry.startTime) - eventEntry.startTime);
        const processing = Math.max(0, (eventEntry.processingEnd ?? eventEntry.startTime) - (eventEntry.processingStart ?? eventEntry.startTime));
        const presentation = Math.max(0, eventEntry.duration - inputDelay - processing);
        inpEl.textContent = `${Math.round(inpValue)} ms INP | ${Math.round(inputDelay)} entrada / ${Math.round(processing)} proc. / ${Math.round(presentation)} present.`;
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.max(900, Math.floor(rect.width * dpr));
  canvas.height = Math.max(680, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function controlBase(channelIdx: number) {
  return channelIdx * CONTROL_FIELDS;
}

function readChannelForPixels(channelIdx: number, pixels: number, samplesToShow: number, offsetSamples: number) {
  const base = controlBase(channelIdx);
  const versionBefore = Atomics.load(controlArray, base + 1);
  if (versionBefore % 2 !== 0) return null;

  const writePtr = Atomics.load(controlArray, base);
  const written = Atomics.load(controlArray, base + 2);
  if (written <= 0) return null;

  const clampedSamples = Math.min(samplesToShow, CHANNEL_SAMPLES, written);
  const endAbsolute = written - Math.min(offsetSamples, Math.max(0, written - 1));
  const startAbsolute = Math.max(0, endAbsolute - clampedSamples);
  if (written - startAbsolute > CHANNEL_SAMPLES) return null;

  const channelOffset = channelIdx * CHANNEL_SAMPLES;
  const samplesPerPixel = Math.max(1, clampedSamples / pixels);
  const points: Array<[number, number]> = [];

  for (let px = 0; px < pixels; px++) {
    const from = Math.floor(startAbsolute + px * samplesPerPixel);
    const to = Math.min(endAbsolute, Math.floor(startAbsolute + (px + 1) * samplesPerPixel));
    let min = Infinity;
    let max = -Infinity;

    for (let absoluteIdx = from; absoluteIdx < Math.max(from + 1, to); absoluteIdx++) {
      const ringIdx = (writePtr - (written - absoluteIdx) + CHANNEL_SAMPLES) % CHANNEL_SAMPLES;
      const value = dataArray[channelOffset + ringIdx];
      if (value < min) min = value;
      if (value > max) max = value;
    }

    points.push([min === Infinity ? 0 : min, max === -Infinity ? 0 : max]);
  }

  const versionAfter = Atomics.load(controlArray, base + 1);
  if (versionBefore !== versionAfter || versionAfter % 2 !== 0) return null;
  return points;
}

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#071013';
  ctx.fillRect(0, 0, width, height);

  const leftGutter = 86;
  const rightGutter = 22;
  const topGutter = 18;
  const trackHeight = (height - topGutter - 18) / TOTAL_CHANNELS;
  const drawWidth = Math.max(320, Math.floor(width - leftGutter - rightGutter));
  const samplesToShow = Math.floor(timeWindowSeconds * SAMPLE_RATE);
  const offsetSamples = Math.floor(viewOffsetSeconds * SAMPLE_RATE);

  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  for (let channelIdx = 0; channelIdx < TOTAL_CHANNELS; channelIdx++) {
    const y = topGutter + channelIdx * trackHeight;
    const midY = y + trackHeight / 2;
    const stationId = Math.floor(channelIdx / CHANNELS_PER_STATION) + 1;
    const channelName = CHANNEL_NAMES[channelIdx % CHANNELS_PER_STATION];
    const state = channelStates[channelIdx];

    ctx.strokeStyle = channelIdx % 3 === 0 ? '#244149' : '#163239';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftGutter, midY);
    ctx.lineTo(width - rightGutter, midY);
    ctx.stroke();

    ctx.fillStyle = state.triggered ? '#ffb84d' : '#7ca4aa';
    ctx.fillText(`E${stationId} ${channelName}`, 14, midY);

    const pixelPairs = readChannelForPixels(channelIdx, drawWidth, samplesToShow, offsetSamples);
    if (!pixelPairs) continue;

    const maxPeak = Math.max(600, state.peak, 1);
    const scale = (trackHeight * 0.42) / maxPeak;
    ctx.strokeStyle = state.triggered ? '#ff7043' : '#2ee6a6';
    ctx.lineWidth = state.triggered ? 1.6 : 1;
    ctx.beginPath();

    pixelPairs.forEach(([min, max], px) => {
      const x = leftGutter + px;
      const yMin = midY - min * scale;
      const yMax = midY - max * scale;
      ctx.moveTo(x, yMin);
      ctx.lineTo(x, yMax);
    });
    ctx.stroke();

    if (state.ratio > 0) {
      ctx.fillStyle = state.triggered ? '#ffd166' : '#4f7d84';
      ctx.fillText(state.ratio.toFixed(1), width - 48, midY);
    }
  }

  drawSelectionOverlay(width, height, leftGutter, rightGutter);
  requestAnimationFrame(draw);
}

function drawSelectionOverlay(width: number, height: number, left: number, right: number) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.fillRect(left, 0, width - left - right, 18);
  ctx.fillStyle = '#9fb8bd';
  ctx.font = '12px Inter, system-ui, sans-serif';
  const mode = viewOffsetSeconds === 0 ? 'en vivo' : `-${Math.round(viewOffsetSeconds)} s`;
  ctx.fillText(`${timeWindowSeconds}s visibles | ${mode}`, left + 8, 9);
}

function renderEvents() {
  eventListEl.innerHTML = '';
  if (events.length === 0) {
    eventListEl.innerHTML = '<li>Sin eventos confirmados todavia</li>';
    return;
  }

  for (const event of events) {
    const li = document.createElement('li');
    const date = new Date(event.time).toLocaleTimeString();
    li.innerHTML = `<strong>${date}</strong><span>${event.stations.length} estaciones</span><small>${event.stations.map((id) => `E${id}`).join(', ')}</small>`;
    eventListEl.appendChild(li);
  }
}

function renderStats() {
  const totals = Array.from(stationStats.values()).reduce(
    (acc, stat) => {
      acc.frames += stat.frames;
      acc.duplicates += stat.duplicates;
      acc.late += stat.late;
      acc.lost += stat.lost;
      acc.reordered += stat.reordered;
      acc.burst = acc.burst || stat.burst;
      return acc;
    },
    { frames: 0, duplicates: 0, late: 0, lost: 0, reordered: 0, burst: false },
  );

  frameStatsEl.textContent = `${totals.frames.toLocaleString()} tramas | ${totals.reordered} reord. | ${totals.duplicates} dup. | ${totals.lost} perd. | ${totals.late} tardias${totals.burst ? ' | rafaga 4x' : ''}`;
  clockEl.textContent = new Date().toLocaleTimeString();
  requestAnimationFrame(() => setTimeout(renderStats, 500));
}

function exportWindow() {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exportando...';
  const worker = new Worker(new URL('./workers/exportWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (message: MessageEvent<{ type: 'CSV_READY'; buffer: ArrayBuffer; filename: string } | { type: 'CSV_ERROR'; reason: string }>) => {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Exportar CSV';
    worker.terminate();

    if (message.data.type === 'CSV_ERROR') {
      statusEl.textContent = message.data.reason;
      return;
    }

    const blob = new Blob([message.data.buffer], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = message.data.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  worker.postMessage({
    type: 'EXPORT',
    sharedBuffer,
    eventTime: lastEvent?.time ?? Date.now(),
    secondsBefore: 90,
    secondsAfter: 90,
  });
}

zoomRange.addEventListener('input', () => {
  timeWindowSeconds = Number(zoomRange.value);
  zoomValue.textContent = `${timeWindowSeconds}s`;
});

offsetRange.addEventListener('input', () => {
  viewOffsetSeconds = Number(offsetRange.value);
  offsetValue.textContent = viewOffsetSeconds === 0 ? 'vivo' : `-${viewOffsetSeconds}s`;
});

liveBtn.addEventListener('click', () => {
  viewOffsetSeconds = 0;
  offsetRange.value = '0';
  offsetValue.textContent = 'vivo';
});

exportBtn.addEventListener('click', exportWindow);

canvas.addEventListener('pointerdown', (event) => {
  isDragging = true;
  dragStartX = event.clientX;
  dragStartOffset = viewOffsetSeconds;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  if (!isDragging) return;
  const delta = event.clientX - dragStartX;
  const secondsPerPixel = timeWindowSeconds / Math.max(1, canvas.clientWidth);
  viewOffsetSeconds = Math.max(0, Math.min(540, dragStartOffset - delta * secondsPerPixel));
  offsetRange.value = String(Math.round(viewOffsetSeconds));
  offsetValue.textContent = viewOffsetSeconds === 0 ? 'vivo' : `-${Math.round(viewOffsetSeconds)}s`;
});

canvas.addEventListener('pointerup', (event) => {
  isDragging = false;
  canvas.releasePointerCapture(event.pointerId);
});

window.addEventListener('resize', resizeCanvas);

resizeCanvas();
renderEvents();
setupPerformanceObservers();
renderStats();
requestAnimationFrame(draw);
