# Consola de vigilancia sismo-volcanica

Aplicacion web para el caso de estudio de vigilancia sismo-volcanica en tiempo real. La consola procesa 9 estaciones por 3 canales, mantiene 10 minutos de historial local y detecta eventos con STA/LTA sin bloquear el hilo principal.

## Ejecutar

```bash
npm --prefix frontend install
npm run dev
```

Build de produccion:

```bash
npm run build
npm run preview
```

El backend incluido puede usarse como simulador WebSocket local adicional:

```bash
npm --prefix backend install
npm run backend:dev
```

La app principal no depende del backend para funcionar en Vercel: incluye un generador sintetico dentro de Workers para reproducir desorden, duplicados, perdidas y rafagas.

## Despliegue en Vercel

El repositorio trae `vercel.json` con:

- `buildCommand`: instala y compila `frontend`.
- `outputDirectory`: `frontend/dist`.
- Cabeceras `Cross-Origin-Opener-Policy` y `Cross-Origin-Embedder-Policy` para que `crossOriginIsolated === true`.

Al desplegar desde Vercel, seleccionar este repositorio y dejar la configuracion por defecto del archivo.

## Arquitectura

- Hilo principal: solo dibuja con `requestAnimationFrame`, lee el historial con `Atomics` sin bloquear, maneja interacciones y muestra metricas.
- 9 Workers de estacion: cada uno procesa una estacion completa y sus 3 canales. Alli viven el generador sintetico, el reordenamiento acotado, el filtrado de duplicados, STA/LTA y maximo deslizante.
- Worker coordinador: recibe mensajes de disparo por estacion y confirma eventos cuando 4 estaciones se traslapan dentro de 6 segundos.
- Worker de exportacion: genera CSV de una ventana de 180 segundos sin interrumpir ingesta ni redibujado.
- `SharedArrayBuffer`: guarda 27 buffers circulares de 120.000 muestras `Int32`, equivalentes a 10 minutos a 200 Hz.

## Requisitos del caso

- RF-1: cada worker mantiene una ventana de reordenamiento de 750 ms por canal. Descarta duplicados y tramas tardias; si una trama se pierde, cierra la ventana y contabiliza la perdida.
- RF-2: STA de 200 muestras y LTA de 6000 muestras con sumas moviles O(1). La LTA se congela durante el disparo. Cada 1000 muestras se recalculan sumas para corregir deriva numerica.
- RF-3: la amplitud pico de 5 segundos usa una cola monotona con costo amortizado O(1).
- RF-4: el coordinador confirma evento cuando la cuarta estacion activa cae dentro de una ventana temporal de 6 segundos.
- RF-5: el historial vive en un `SharedArrayBuffer` circular. Cada canal usa contador de version para detectar lecturas invalidadas durante escritura.
- RF-6: el dibujo ocurre en `requestAnimationFrame` y reduce muestras con min/max por pixel para conservar picos.
- RF-7: los eventos quedan listados en la UI y el boton CSV exporta una ventana de 90 segundos antes y despues.
- RT-7: el panel muestra INP, desglose de entrada/procesamiento/presentacion cuando el navegador expone Event Timing, y conteo de long tasks.

## Sustentacion rapida

En DevTools:

1. Consola: comprobar `crossOriginIsolated`.
2. Performance: grabar mientras se arrastra el sismograma; el hilo principal debe mostrar dibujo e interaccion, no calculo STA/LTA.
3. Sources > Workers: revisar workers de estacion, coordinador y exportacion.
4. Memory: confirmar un `SharedArrayBuffer` de aproximadamente 12.36 MB para las muestras y metadatos.
