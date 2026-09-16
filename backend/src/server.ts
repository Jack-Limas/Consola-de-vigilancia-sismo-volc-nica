import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';

const server = Fastify({ logger: true });

// Cabeceras exigidas por el requerimiento RT-5 para habilitar SharedArrayBuffer en el navegador
server.addHook('onRequest', async (req, reply) => {
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
});

await server.register(fastifyCors, { origin: '*' });
await server.register(fastifyWebsocket);

// Simulador de señal sismo-volcánica (Generador binario de 216 bytes)
server.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (connection) => {
    let seq = 0;
    
    // Generar tramas cada 250 ms (50 muestras a 200Hz por trama)
    const interval = setInterval(() => {
      seq++;
      const nowUs = BigInt(Date.now() * 1000);

      for (let station = 1; station <= 9; station++) {
        for (let channel = 0; channel < 3; channel++) {
          const buffer = new ArrayBuffer(216);
          const view = new DataView(buffer);

          // Escribir cabecera del protocolo (Sección 2)
          view.setUint16(0, station, true);       // station_id (1..9)
          view.setUint8(2, channel);              // channel (0=N-S, 1=E-O, 2=Vert)
          view.setUint8(3, 0);                    // flags
          view.setUint32(4, seq, true);           // seq
          view.setBigUint64(8, nowUs, true);      // t0_us

          // Escribir 50 muestras int32 (Ruido base + componente sísmica)
          for (let i = 0; i < 50; i++) {
            const noise = Math.floor((Math.random() - 0.5) * 100);
            const seismicEvent = (seq > 100 && seq < 140) ? Math.floor(Math.sin(i / 5) * 1500) : 0;
            view.setInt32(16 + i * 4, noise + seismicEvent, true);
          }

          connection.socket.send(buffer);
        }
      }
    }, 250);

    connection.socket.on('close', () => clearInterval(interval));
  });
});

const start = async () => {
  try {
    await server.listen({ port: 4000, host: '0.0.0.0' });
    console.log('Servidor corriendo en http://localhost:4000');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();