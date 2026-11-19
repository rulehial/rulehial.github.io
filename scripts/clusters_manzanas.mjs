// =====================================================================
// Clusters de manzanas censales — Copiapó (Censo 2024, INE)
// ---------------------------------------------------------------------
// Agrupa las manzanas en perfiles parecidos con k-means sobre variables
// estandarizadas (z-score) y genera un archivo liviano para la
// visualización 3D (Manzanas_3D.html).
//
// Uso (desde la raíz del repositorio):
//   node scripts/clusters_manzanas.mjs
//
// Entradas:
//   inputs/manzanas_copiapo_V2.geojson  (Censo 2024 por manzana)
//   inputs/manzanas_cobertura.geojson   (distancia a recorridos y UV; generado
//                                        por scripts/calcular_cobertura.mjs)
// Salida:
//   inputs/manzanas_3d.geojson
//
// Sin dependencias. Resultado reproducible (semilla fija).
// =====================================================================

import fs from 'node:fs';

const DIR = 'inputs';
const K = 5;                  // número de clusters
const MIN_PERSONAS = 20;      // manzanas con menos personas no se agrupan (porcentajes poco confiables)
const INTENTOS = 25;          // reinicios de k-means (se queda con el mejor)

const leer = f => JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
const censo = leer('manzanas_copiapo_V2.geojson').features;
const cobertura = leer('manzanas_cobertura.geojson').features;

// ---------------------------------------------------------------------
// Área (ha) con proyección local
// ---------------------------------------------------------------------
const R = 6371008.8, COS = Math.cos(-27.37 * Math.PI / 180);
const xy = ([lon, lat]) => [R * lon * Math.PI / 180 * COS, R * lat * Math.PI / 180];
const poligonos = g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
function areaHa(g) {
  let total = 0;
  for (const p of poligonos(g)) {
    p.forEach((anillo, k) => {
      const pts = anillo.map(xy);
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
      total += (k === 0 ? 1 : -1) * Math.abs(a / 2);
    });
  }
  return total / 10000;
}

// ---------------------------------------------------------------------
// Indicadores por manzana
// ---------------------------------------------------------------------
const MODOS = ['publico', 'auto', 'camina', 'bicicleta', 'motocicleta', 'cab_lan_bote', 'otros'];
const div = (a, b) => b ? a / b : null;

const filas = censo.map((f, i) => {
  const p = f.properties;
  const per = p.n_per || 0;
  const tras = MODOS.reduce((s, m) => s + (p['n_transporte_' + m] || 0), 0);
  const ha = areaHa(f.geometry);
  return {
    i,
    per,
    ha,
    dens: ha > 0 ? per / ha : null,                                  // habitantes por hectárea
    tp: div(p.n_transporte_publico || 0, tras),
    auto: div(p.n_transporte_auto || 0, tras),
    camina: div(p.n_transporte_camina || 0, tras),
    otros: div((p.n_transporte_bicicleta || 0) + (p.n_transporte_motocicleta || 0) + (p.n_transporte_cab_lan_bote || 0) + (p.n_transporte_otros || 0), tras),
    adol: div(p.n_edad_14_17 || 0, per),
    adultos: div((p.n_edad_18_24 || 0) + (p.n_edad_25_44 || 0) + (p.n_edad_45_59 || 0), per),
    disc: div(p.n_discapacidad || 0, per),
    hog: p.n_hog || 0,
    edad: p.prom_edad ?? null,
    ninos: div((p.n_edad_0_5 || 0) + (p.n_edad_6_13 || 0), per),
    mayores: div(p.n_edad_60_mas || 0, per),
    inm: div(p.n_inmigrantes || 0, per),                             // nulos del INE cuentan como 0
    hacin: div(p.n_viv_hacinadas || 0, p.n_vp_ocupada || 0),
    esc: p.prom_escolaridad18 ?? null,
    desoc: div(p.n_desocupado || 0, (p.n_ocupado || 0) + (p.n_desocupado || 0)),
    dist: cobertura[i].properties.dist_ruta,
    uv: cobertura[i].properties.uv
  };
});

// Variables que definen los clusters (densidad en logaritmo para que no dominen los extremos)
const VARS = ['tp', 'auto', 'ninos', 'mayores', 'inm', 'hacin', 'esc', 'densLog'];
filas.forEach(r => { r.densLog = r.dens != null ? Math.log1p(r.dens) : null; });

const validas = filas.filter(r => r.per >= MIN_PERSONAS && VARS.every(v => r[v] != null && isFinite(r[v])));

// Estandarización z-score
const media = {}, desv = {};
VARS.forEach(v => {
  const xs = validas.map(r => r[v]);
  media[v] = xs.reduce((a, b) => a + b, 0) / xs.length;
  desv[v] = Math.sqrt(xs.reduce((a, b) => a + (b - media[v]) ** 2, 0) / xs.length) || 1;
});
const vec = r => VARS.map(v => (r[v] - media[v]) / desv[v]);
const X = validas.map(vec);

// ---------------------------------------------------------------------
// k-means++ con semilla fija
// ---------------------------------------------------------------------
let semilla = 20241;
const azar = () => (semilla = (semilla * 1664525 + 1013904223) % 4294967296) / 4294967296;
const d2 = (a, b) => a.reduce((s, x, j) => s + (x - b[j]) ** 2, 0);

function kmeans() {
  const centros = [X[Math.floor(azar() * X.length)]];
  while (centros.length < K) {
    const dist = X.map(x => Math.min(...centros.map(c => d2(x, c))));
    let r = azar() * dist.reduce((a, b) => a + b, 0);
    let k = 0;
    while ((r -= dist[k]) > 0) k++;
    centros.push(X[k]);
  }
  let asign = new Array(X.length).fill(0);
  for (let it = 0; it < 100; it++) {
    const nueva = X.map(x => {
      let mejor = 0, md = Infinity;
      centros.forEach((c, k) => { const d = d2(x, c); if (d < md) { md = d; mejor = k; } });
      return mejor;
    });
    const cambio = nueva.some((a, j) => a !== asign[j]);
    asign = nueva;
    for (let k = 0; k < K; k++) {
      const miembros = X.filter((_, j) => asign[j] === k);
      if (miembros.length) centros[k] = VARS.map((_, v) => miembros.reduce((s, m) => s + m[v], 0) / miembros.length);
    }
    if (!cambio) break;
  }
  const inercia = X.reduce((s, x, j) => s + d2(x, centros[asign[j]]), 0);
  return { centros, asign, inercia };
}

let mejor = null;
for (let n = 0; n < INTENTOS; n++) {
  const r = kmeans();
  if (!mejor || r.inercia < mejor.inercia) mejor = r;
}

// Ordenar clusters por % de transporte público (0 = menos, K-1 = más dependiente del bus)
const orden = mejor.centros.map((c, k) => k).sort((a, b) => mejor.centros[a][0] - mejor.centros[b][0]);
const nuevoId = Object.fromEntries(orden.map((k, nuevo) => [k, nuevo]));
validas.forEach((r, j) => { r.cluster = nuevoId[mejor.asign[j]]; });

// ---------------------------------------------------------------------
// Perfil de cada cluster (promedios ponderados por población)
// ---------------------------------------------------------------------
const perfil = [];
for (let k = 0; k < K; k++) {
  const ms = validas.filter(r => r.cluster === k);
  const pob = ms.reduce((s, r) => s + r.per, 0);
  const prom = v => ms.reduce((s, r) => s + r[v] * r.per, 0) / pob;
  perfil.push({
    cluster: k, manzanas: ms.length, poblacion: Math.round(pob),
    ...Object.fromEntries(['tp', 'auto', 'camina', 'otros', 'ninos', 'adol', 'adultos', 'mayores', 'inm', 'disc', 'hacin', 'esc', 'desoc', 'dens', 'dist'].map(v => [v, prom(v)])),
    z: Object.fromEntries(VARS.map((v, j) => [v, +mejor.centros[orden[k]][j].toFixed(2)]))
  });
}

// ---------------------------------------------------------------------
// Salida liviana para el mapa 3D
// ---------------------------------------------------------------------
const red = (x, d = 1) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const pct = x => x == null ? null : red(100 * x, 1);
const redCoords = c => Array.isArray(c[0]) ? c.map(redCoords) : [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

const salida = {
  type: 'FeatureCollection',
  metadata: {
    generado: new Date().toISOString().slice(0, 10),
    fuente: 'Censo 2024 (INE), datos por manzana',
    metodo: `k-means (k=${K}) sobre variables estandarizadas: ${VARS.join(', ')}. Manzanas con menos de ${MIN_PERSONAS} personas sin cluster.`,
    perfiles: perfil.map(p => ({
      cluster: p.cluster, manzanas: p.manzanas, poblacion: p.poblacion,
      tp: pct(p.tp), auto: pct(p.auto), camina: pct(p.camina), otros: pct(p.otros),
      ninos: pct(p.ninos), adol: pct(p.adol), adultos: pct(p.adultos), mayores: pct(p.mayores), inm: pct(p.inm), disc: pct(p.disc),
      hacin: pct(p.hacin), esc: red(p.esc), desoc: pct(p.desoc), dens: red(p.dens, 0), dist: red(p.dist, 0)
    }))
  },
  features: censo.map((f, i) => {
    const r = filas[i];
    const c = validas.find(v => v.i === i);
    return {
      type: 'Feature',
      properties: {
        id: i,
        uv: r.uv,
        cluster: c ? c.cluster : -1,
        per: r.per,
        dens: red(r.dens, 0),
        tp: pct(r.tp),
        auto: pct(r.auto),
        camina: pct(r.camina),
        otros: pct(r.otros),
        adol: pct(r.adol),
        adultos: pct(r.adultos),
        disc: pct(r.disc),
        hog: r.hog,
        edad: red(r.edad),
        ninos: pct(r.ninos),
        mayores: pct(r.mayores),
        inm: pct(r.inm),
        hacin: pct(r.hacin),
        esc: red(r.esc),
        desoc: pct(r.desoc),
        dist: r.dist
      },
      geometry: { type: f.geometry.type, coordinates: redCoords(f.geometry.coordinates) }
    };
  })
};
fs.writeFileSync(`${DIR}/manzanas_3d.geojson`, JSON.stringify(salida));

// ---------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------
console.log(`\nManzanas: ${censo.length} · agrupadas: ${validas.length} · k = ${K}\n`);
console.table(salida.metadata.perfiles);
console.log('\nPerfil en z-score (desviaciones respecto del promedio):');
console.table(perfil.map(p => ({ cluster: p.cluster, ...p.z })));
console.log(`\nGenerado: ${DIR}/manzanas_3d.geojson (${Math.round(fs.statSync(`${DIR}/manzanas_3d.geojson`).size / 1024)} KB)`);
