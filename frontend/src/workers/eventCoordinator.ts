type StationPortMessage =
  | { type: 'TRIGGER_START'; stationId: number; time: number; peak: number }
  | { type: 'TRIGGER_END'; stationId: number; time: number; peak: number };

type ActiveStation = {
  stationId: number;
  startedAt: number;
  peak: number;
};

const active = new Map<number, ActiveStation>();
const reportedWindows = new Set<string>();
let eventId = 0;

self.onmessage = (event: MessageEvent<{ type: 'ATTACH_STATION'; stationId: number; port: MessagePort }>) => {
  if (event.data.type !== 'ATTACH_STATION') return;
  const port = event.data.port;
  port.onmessage = (message: MessageEvent<StationPortMessage>) => handleStationMessage(message.data);
  port.start();
};

function handleStationMessage(message: StationPortMessage) {
  if (message.type === 'TRIGGER_START') {
    active.set(message.stationId, {
      stationId: message.stationId,
      startedAt: message.time,
      peak: message.peak,
    });
    evaluateCoincidence(message.time);
    return;
  }

  active.delete(message.stationId);
}

function evaluateCoincidence(now: number) {
  const stations = Array.from(active.values()).sort((a, b) => a.startedAt - b.startedAt);
  if (stations.length < 4) return;

  for (let i = 0; i <= stations.length - 4; i++) {
    const group = stations.slice(i, i + 4);
    const reachedAt = Math.max(...group.map((station) => station.startedAt));
    const openedAt = Math.min(...group.map((station) => station.startedAt));
    if (reachedAt - openedAt > 6000) continue;

    const key = group.map((station) => station.stationId).join('-');
    const windowKey = `${key}:${Math.floor(reachedAt / 6000)}`;
    if (reportedWindows.has(windowKey)) continue;
    reportedWindows.add(windowKey);

    postMessage({
      type: 'EVENT_CONFIRMED',
      event: {
        id: ++eventId,
        time: now,
        stations: group.map((station) => station.stationId),
        peaks: group.map((station) => Math.round(station.peak)),
      },
    });
    return;
  }
}
