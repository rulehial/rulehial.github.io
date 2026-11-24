// =====================================================================
// Service worker del Atlas Copiapó
// ---------------------------------------------------------------------
// Guarda en el navegador lo que más tarda en cargar, para que la segunda
// visita abra al instante:
//   - Datos del atlas (inputs/*.json, *.geojson): se entregan desde lo
//     guardado y se actualizan en segundo plano (si se publican datos nuevos,
//     llegan a más tardar en la visita siguiente).
//   - Relieve (AWS Terrain Tiles, datos abiertos que no cambian): se guardan
//     y no se vuelven a pedir (máximo MAX_RELIEVE imágenes).
// La imagen satelital de Esri NO se guarda aquí: sus condiciones permiten
// guardarla un día, y eso ya lo hace el navegador con su caché normal.
// Para forzar que todos descarguen de nuevo, cambie VERSION.
// =====================================================================

const VERSION = 'v1';
const DATOS = 'atlas-datos-' + VERSION;
const RELIEVE = 'atlas-relieve-' + VERSION;
const MAX_RELIEVE = 2000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  // Borra lo guardado por versiones anteriores
  for (const k of await caches.keys()) if (k.startsWith('atlas-') && ![DATOS, RELIEVE].includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

const esDato = u => u.origin === self.location.origin && /\/inputs\/[^/]+\.(geo)?json$/i.test(u.pathname);
const esRelieve = u => u.hostname === 's3.amazonaws.com' && u.pathname.startsWith('/elevation-tiles-prod/');

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (esDato(u)) e.respondWith(guardadoYActualizar(e));
  else if (esRelieve(u)) e.respondWith(primeroGuardado(e.request));
});

// Datos: responde con lo guardado y pide la versión nueva por detrás
async function guardadoYActualizar(e) {
  const cache = await caches.open(DATOS);
  const guardado = await cache.match(e.request, { ignoreSearch: true });
  const red = fetch(e.request).then(r => {
    if (r.ok) return cache.put(e.request.url.split('?')[0], r.clone()).then(() => r);
    return r;
  });
  if (guardado) {
    e.waitUntil(red.catch(() => {}));
    return guardado;
  }
  return red;
}

// Relieve: si está guardado se usa; si no, se descarga y se guarda
let nuevas = 0;
async function primeroGuardado(req) {
  const cache = await caches.open(RELIEVE);
  const guardado = await cache.match(req);
  if (guardado) return guardado;
  const r = await fetch(req);
  if (r.ok) {
    await cache.put(req, r.clone());
    if (++nuevas % 100 === 0) recortar(cache);
  }
  return r;
}
// Mantiene el relieve bajo el máximo (borra las imágenes más antiguas)
async function recortar(cache) {
  const ks = await cache.keys();
  for (let i = 0; i < ks.length - MAX_RELIEVE; i++) await cache.delete(ks[i]);
}
