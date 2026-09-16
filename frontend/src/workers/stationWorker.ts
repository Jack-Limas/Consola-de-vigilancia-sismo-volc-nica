const SAMPLE_RATE = 200;
const FRAME_SAMPLES = 50;
const FRAME_MS = 250;
const STATIONS = 9;
const CHANNELS_PER_STATION = 3;
const TOTAL_CHANNELS = STATIONS * CHANNELS_PER_STATION;
const CHANNEL_SAMPLES = SAMPLE_RATE * 600;
const CONTROL_FIELDS = 4;
const CONTROL_LENGTH = TOTAL_CHANNELS * CONTROL_FIELDS;
const DATA_OFFSET_BYTES = CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT;
const REORDER_WINDOW_MS = 750;

type InitMessage = {
  type: 'INIT';
  stationId: number;
  sharedBuffer: SharedArrayBuffer;
  coordinatorPort: MessagePort;
};

type Frame = {
  seq: number;
  channel: number;
  stationId: number;
  t0: number;
  samples: Int32Array;
  receivedAt: number;
};

type QueuedFrame = Frame & { dueAt: number; duplicate?: boolean };

class ChannelProcessor {
  private sta = new Float64Array(200);
  private lta = new Float64Array(6000);
  private staIndex = 0;
  private ltaIndex = 0;
  private staCount = 0;
  private ltaCount = 0;
  private staSum = 0;
  private ltaSum = 0;
  private triggered = false;
  private processed = 0;
  private maxDeque: Array<{ value: number; index: number }> = [];

  process(sample: number) {
    const energy = sample * sample;
    const abs = Math.abs(sample);

    if (this.staCount < this.sta.length) {
      this.staCount++;
    } else {
      this.staSum -= this.sta[this.staIndex];
    }
    this.sta[this.staIndex] = energy;
    this.staSum += energy;
    this.staIndex = (this.staIndex + 1) % this.sta.length;

    if (!this.triggered) {
      if (this.ltaCount < this.lta.length) {
        this.ltaCount++;
      } else {
        this.ltaSum -= this.lta[this.ltaIndex];
      }
      this.lta[this.ltaIndex] = energy;
      this.ltaSum += energy;
      this.ltaIndex = (this.ltaIndex + 1) % this.lta.length;
    }

    this.processed++;
    if (this.processed % 1000 === 0) {
      this.staSum = sumRing(this.sta, this.staCount);
      if (!this.triggered) this.ltaSum = sumRing(this.lta, this.ltaCount);
      if (this.ltaSum < 0 || !Number.isFinite(this.ltaSum)) this.ltaSum = sumRing(this.lta, this.ltaCount);
    }

    while (this.maxDeque.length > 0 && this.maxDeque[this.maxDeque.length - 1].value <= abs) {
      this.maxDeque.pop();
    }
    this.maxDeque.push({ value: abs, index: this.processed });
    while (this.maxDeque.length > 0 && this.maxDeque[0].index <= this.processed - 1000) {
      this.maxDeque.shift();
    }

    const staAvg = this.staSum / Math.max(1, this.staCount);
    const ltaAvg = this.ltaSum / Math.max(1, this.ltaCount);
    const ratio = ltaAvg > 0 ? staAvg / ltaAvg : 0;

    if (!this.triggered && this.ltaCount >= 200 && ratio >= 4) {
      this.triggered = true;
    } else if (this.triggered && ratio <= 1.5) {
      this.triggered = false;
    }

    return {
      ratio,
      triggered: this.triggered,
      peak: this.maxDeque[0]?.value ?? abs,
    };
  }
}

function sumRing(values: Float64Array, count: number) {
  let total = 0;
  for (let i = 0; i < count; i++) total += values[i];
  return total;
}

let stationId = 0;
let coordinatorPort: MessagePort;
let controlArray: Int32Array;
let dataArray: Int32Array;
const processors = Array.from({ length: CHANNELS_PER_STATION }, () => new ChannelProcessor());
const pending = Array.from({ length: CHANNELS_PER_STATION }, () => new Map<number, Frame>());
const lastSeq = new Int32Array(CHANNELS_PER_STATION);
const generatedSeq = new Int32Array(CHANNELS_PER_STATION);
const stationTriggers = new Set<number>();
const queue: QueuedFrame[] = [];
const stats = {
  frames: 0,
  duplicates: 0,
  late: 0,
  lost: 0,
  reordered: 0,
  burst: false,
};

self.onmessage = (event: MessageEvent<InitMessage>) => {
  if (event.data.type !== 'INIT') return;
  stationId = event.data.stationId;
  coordinatorPort = event.data.coordinatorPort;
  controlArray = new Int32Array(event.data.sharedBuffer, 0, CONTROL_LENGTH);
  dataArray = new Int32Array(event.data.sharedBuffer, DATA_OFFSET_BYTES);
  postMessage({ type: 'WORKER_READY', stationId });
  startSyntheticStream();
};

function startSyntheticStream() {
  setInterval(() => {
    const burst = isBurstMode();
    stats.burst = burst;
    const loops = burst ? 4 : 1;
    for (let i = 0; i < loops; i++) generateFrames();
    deliverQueuedFrames();
  }, FRAME_MS);

  setInterval(() => {
    postMessage({ type: 'STATS', stationId, ...stats });
  }, 600);
}

function generateFrames() {
  for (let channel = 0; channel < CHANNELS_PER_STATION; channel++) {
    generatedSeq[channel]++;
    const seq = generatedSeq[channel];
    if (shouldDrop(seq)) {
      if (seq % 37 === 0) generatedSeq[channel] += Math.floor(1 + Math.random() * 11);
      continue;
    }

    const frame = createFrame(channel, seq);
    const disorder = Math.random() < 0.04;
    const dueAt = Date.now() + (disorder ? 300 + Math.random() * 850 : Math.random() * 80);
    queue.push({ ...frame, dueAt });
    if (disorder) stats.reordered++;

    if (Math.random() < 0.008) {
      queue.push({ ...frame, dueAt: dueAt + 15 + Math.random() * 60, duplicate: true });
    }
  }
}

function shouldDrop(seq: number) {
  return seq % 211 === 0 || Math.random() < 0.002;
}

function isBurstMode() {
  const cycle = Math.floor(Date.now() / 1000) % 90;
  return cycle >= 40 && cycle < 48;
}

function createFrame(channel: number, seq: number): Frame {
  const samples = new Int32Array(FRAME_SAMPLES);
  const event = eventEnvelope();
  const polarity = channel === 1 ? -1 : 1;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (seq * FRAME_SAMPLES + i) / SAMPLE_RATE;
    const base = Math.round((Math.random() - 0.5) * 90);
    const tremor = Math.sin(t * 2.4 + stationId * 0.7) * 25;
    const seismic = event * polarity * (1300 + stationId * 80) * Math.sin(t * 32 + channel);
    samples[i] = Math.round(base + tremor + seismic);
  }

  return {
    seq,
    channel,
    stationId,
    t0: Date.now(),
    samples,
    receivedAt: Date.now(),
  };
}

function eventEnvelope() {
  const cycle = (Date.now() / 1000) % 70;
  if (cycle < 16 || cycle > 29) return 0;
  const stationDelay = stationId * 0.23;
  const x = Math.max(0, Math.min(1, (cycle - 16 - stationDelay) / 4));
  const release = Math.max(0, Math.min(1, (29 - cycle + stationDelay) / 5));
  return Math.min(x, release);
}

function deliverQueuedFrames() {
  const now = Date.now();
  queue.sort((a, b) => a.dueAt - b.dueAt);
  while (queue.length > 0 && queue[0].dueAt <= now) {
    const item = queue.shift()!;
    ingestFrame({ ...item, receivedAt: now });
  }

  for (let channel = 0; channel < CHANNELS_PER_STATION; channel++) {
    flushReady(channel, now);
  }
}

function ingestFrame(frame: Frame) {
  const channel = frame.channel;
  const last = lastSeq[channel];
  if (frame.seq <= last || pending[channel].has(frame.seq)) {
    if (frame.seq <= last) stats.late++;
    else stats.duplicates++;
    return;
  }

  pending[channel].set(frame.seq, frame);
  flushReady(channel, Date.now());
}

function flushReady(channel: number, now: number) {
  const channelPending = pending[channel];
  let next = lastSeq[channel] + 1;

  while (channelPending.has(next)) {
    const frame = channelPending.get(next)!;
    channelPending.delete(next);
    processFrame(frame);
    lastSeq[channel] = next;
    next++;
  }

  const seqs = Array.from(channelPending.keys()).sort((a, b) => a - b);
  if (seqs.length === 0) return;

  const oldest = channelPending.get(seqs[0])!;
  if (now - oldest.receivedAt < REORDER_WINDOW_MS) return;

  const missing = Math.max(0, seqs[0] - lastSeq[channel] - 1);
  if (missing > 0) {
    stats.lost += missing;
    processGap(channel, missing);
    lastSeq[channel] += missing;
  }

  flushReady(channel, now);
}

function processGap(localChannel: number, frames: number) {
  const zeros = new Int32Array(FRAME_SAMPLES);
  for (let i = 0; i < frames; i++) {
    processSamples(localChannel, zeros);
  }
}

function processFrame(frame: Frame) {
  stats.frames++;
  processSamples(frame.channel, frame.samples);
}

function processSamples(localChannel: number, samples: Int32Array) {
  const globalChannel = (stationId - 1) * CHANNELS_PER_STATION + localChannel;
  const controlBase = globalChannel * CONTROL_FIELDS;
  Atomics.add(controlArray, controlBase + 1, 1);

  let ptr = Atomics.load(controlArray, controlBase);
  let written = Atomics.load(controlArray, controlBase + 2);
  let lastState = { ratio: 0, peak: 0, triggered: false };

  for (const sample of samples) {
    dataArray[globalChannel * CHANNEL_SAMPLES + ptr] = sample;
    ptr = (ptr + 1) % CHANNEL_SAMPLES;
    written++;
    lastState = processors[localChannel].process(sample);
  }

  Atomics.store(controlArray, controlBase, ptr);
  Atomics.store(controlArray, controlBase + 2, written);
  Atomics.store(controlArray, controlBase + 3, Math.round(lastState.peak));
  Atomics.add(controlArray, controlBase + 1, 1);

  postMessage({
    type: 'CHANNEL_STATE',
    channelIdx: globalChannel,
    ratio: lastState.ratio,
    peak: lastState.peak,
    triggered: lastState.triggered,
  });

  updateStationTrigger(localChannel, lastState.triggered, lastState.peak);
}

function updateStationTrigger(localChannel: number, triggered: boolean, peak: number) {
  const wasActive = stationTriggers.size > 0;
  if (triggered) stationTriggers.add(localChannel);
  else stationTriggers.delete(localChannel);

  const isActive = stationTriggers.size > 0;
  if (wasActive === isActive) return;

  coordinatorPort.postMessage({
    type: isActive ? 'TRIGGER_START' : 'TRIGGER_END',
    stationId,
    time: Date.now(),
    peak,
  });
}
