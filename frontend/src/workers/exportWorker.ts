const SAMPLE_RATE = 200;
const STATIONS = 9;
const CHANNELS_PER_STATION = 3;
const TOTAL_CHANNELS = STATIONS * CHANNELS_PER_STATION;
const CHANNEL_SAMPLES = SAMPLE_RATE * 600;
const CONTROL_FIELDS = 4;
const CONTROL_LENGTH = TOTAL_CHANNELS * CONTROL_FIELDS;
const DATA_OFFSET_BYTES = CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT;

type ExportMessage = {
  type: 'EXPORT';
  sharedBuffer: SharedArrayBuffer;
  eventTime: number;
  secondsBefore: number;
  secondsAfter: number;
};

self.onmessage = (event: MessageEvent<ExportMessage>) => {
  if (event.data.type !== 'EXPORT') return;

  const control = new Int32Array(event.data.sharedBuffer, 0, CONTROL_LENGTH);
  const data = new Int32Array(event.data.sharedBuffer, DATA_OFFSET_BYTES);
  const totalSamples = Math.floor((event.data.secondsBefore + event.data.secondsAfter) * SAMPLE_RATE);
  const newestWritten = Math.min(...Array.from({ length: TOTAL_CHANNELS }, (_, channel) => Atomics.load(control, channel * CONTROL_FIELDS + 2)));
  const startAbsolute = Math.max(0, newestWritten - totalSamples);

  if (newestWritten <= 0) {
    postMessage({ type: 'CSV_ERROR', reason: 'No hay muestras suficientes para exportar.' });
    return;
  }

  const header = ['sample_index', 'seconds'];
  for (let station = 1; station <= STATIONS; station++) {
    header.push(`E${station}_NS`, `E${station}_EO`, `E${station}_Z`);
  }

  const rows: string[] = [header.join(',')];

  for (let sample = 0; sample < newestWritten - startAbsolute; sample++) {
    const absolute = startAbsolute + sample;
    const row = [String(sample), (sample / SAMPLE_RATE - event.data.secondsBefore).toFixed(3)];

    for (let channel = 0; channel < TOTAL_CHANNELS; channel++) {
      const base = channel * CONTROL_FIELDS;
      const versionBefore = Atomics.load(control, base + 1);
      const writePtr = Atomics.load(control, base);
      const written = Atomics.load(control, base + 2);
      const distanceFromHead = written - absolute;

      if (versionBefore % 2 !== 0 || distanceFromHead < 0 || distanceFromHead > CHANNEL_SAMPLES) {
        row.push('');
        continue;
      }

      const ringIdx = (writePtr - distanceFromHead + CHANNEL_SAMPLES) % CHANNEL_SAMPLES;
      const value = data[channel * CHANNEL_SAMPLES + ringIdx];
      const versionAfter = Atomics.load(control, base + 1);
      row.push(versionBefore === versionAfter ? String(value) : '');
    }

    rows.push(row.join(','));
  }

  const csv = rows.join('\n');
  const encoded = new TextEncoder().encode(csv);
  const safeTime = new Date(event.data.eventTime).toISOString().replace(/[:.]/g, '-');
  postMessage(
    {
      type: 'CSV_READY',
      filename: `evento-sismo-volcanico-${safeTime}.csv`,
      buffer: encoded.buffer,
    },
    [encoded.buffer],
  );
};
