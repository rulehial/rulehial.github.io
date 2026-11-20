// =====================================================================
// Clusters de manzanas censales — Copiapó (Censo 2024, INE)
// ---------------------------------------------------------------------
// Agrupa las manzanas en perfiles demográficos con k-means sobre variables
// estandarizadas (z-score), igual que en Tierra Amarilla: niños, mayores,
// inmigrantes, pueblos originarios, hacinamiento, escolaridad, desocupación
// y densidad (logarítmica). El transporte NO entra en los perfiles; sigue
// disponible como variable aparte en el mapa.
//
// Los nombres de los perfiles se asignan por el rasgo de cada grupo (no por
// su tamaño), así que no se cruzan si cambian los datos. Igual conviene
// revisar la tabla que imprime el script.
//
// Uso (desde la raíz del repositorio):
//   node scripts/clusters_manzanas.mjs
//
// Entradas:
//   inputs/manzanas_copiapo_V3.geojson  (Censo 2024 por manzana, todos los campos;
//                                        ciudad + San Pedro + Quebrada Paipote)
//   inputs/manzanas_copiapo_V2.geojson  (solo para cruzar la cobertura por MANZENT)
//   inputs/manzanas_cobertura.geojson   (distancia a recorridos y UV de las manzanas
//                                        del V2; generado por scripts/calcular_cobertura.mjs)
//   inputs/RutaBusesV2.geojson          (para la distancia al bus de manzanas nuevas)
// Salida:
//   inputs/manzanas_3d.geojson
//
// Sin dependencias. Resultado reproducible (semilla fija).
// =====================================================================

import fs from 'node:fs';

const DIR = 'inputs';
const K = 5;                  // número de perfiles
const MIN_PERSONAS = 20;      // manzanas con menos personas no se agrupan (porcentajes poco confiables)
const INTENTOS = 25;          // reinicios de k-means (se queda con el mejor)

// Perfiles: de más a menos escolaridad. Cada nombre se asigna al grupo por su rasgo
// (campo `rasgo`), en este orden: más inmigrantes → más desocupación → más mayores →
// más escolaridad → el resto.
const PERFILES = [
  { letra: 'A', rasgo: 'esc', nombre: 'Familias con alta escolaridad', color: '#5b8ff9',
    desc: 'Hogares con niños y pocos adultos mayores, con la mayor escolaridad de la ciudad y baja desocupación y hacinamiento.' },
  { letra: 'B', rasgo: 'mayores', nombre: 'Barrios envejecidos', color: '#3ad1c4',
    desc: 'Casi un tercio de sus habitantes tiene 60 años o más. Baja densidad, pocos niños y escolaridad media.' },
  { letra: 'C', rasgo: null, nombre: 'Barrios populares densos', color: '#f6c544',
    desc: 'Los barrios más densos de la ciudad, con fuerte presencia de pueblos originarios y escolaridad bajo el promedio.' },
  { letra: 'D', rasgo: 'desoc', nombre: 'Alta desocupación', color: '#ff9d4d',
    desc: 'Cerca de uno de cada cinco integrantes de la fuerza de trabajo está desocupado; escolaridad baja y población algo envejecida.' },
  { letra: 'E', rasgo: 'inm', nombre: 'Alta migración y hacinamiento', color: '#ff5d73',
    desc: 'Casi dos de cada tres habitantes son inmigrantes, con el mayor hacinamiento de la ciudad y muchos niños. Se concentra en los sectores altos de Copiapó Este.' }
];

const leer = f => JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
const censo = leer('manzanas_copiapo_V3.geojson').features;
// Cobertura (UV y distancia al bus) calculada sobre el V2: se cruza por código de manzana
const v2 = leer('manzanas_copiapo_V2.geojson').features;
const cob = leer('manzanas_cobertura.geojson').features;
const coberturaDe = new Map(v2.map((f, i) => [String(f.properties.MANZENT), cob[i].properties]));
const rutas = leer('RutaBusesV2.geojson').features;

// ---------------------------------------------------------------------
// Vivienda, agua y trabajo (Censo 2024): porcentajes por manzana
// ---------------------------------------------------------------------
function indicadoresVivienda(q) {
  if (!q) return { mineria: null, agua: null, irrec: null, deficit: null, allegados: null, sincontrato: null };
  const n = k => q[k] || 0;
  const d = (a, b) => b ? a / b : null;
  const agua = ['publica', 'pozo', 'camion', 'rio'].reduce((s, k) => s + n('n_fuente_agua_' + k), 0);
  const tenencia = ['propia_pagada', 'propia_pagandose', 'arrendada_contrato', 'arrendada_sin_contrato', 'cedida_trabajo', 'cedida_familiar', 'otro']
    .reduce((s, k) => s + n('n_tenencia_' + k), 0);
  return {
    mineria: d(n('n_caenes_B'), n('n_ocupado')),                                     // ocupados en minería
    agua: d(n('n_fuente_agua_pozo') + n('n_fuente_agua_camion') + n('n_fuente_agua_rio'), agua),   // sin red pública
    irrec: d(n('n_viv_irrecuperables'), n('n_vp_ocupada')),                          // viviendas irrecuperables
    deficit: d(n('n_deficit_cuantitativo'), n('n_hog')),                             // viviendas faltantes por hogar
    allegados: d(n('n_hog_allegados'), n('n_hog')),                                  // hogares allegados
    sincontrato: d(n('n_tenencia_arrendada_sin_contrato'), tenencia)                 // arriendo sin contrato
  };
}

// ---------------------------------------------------------------------
// Geometría (proyección local en metros)
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
function centro(g) {
  let mejor = null, mejorA = -1;
  for (const p of poligonos(g)) {
    const r = p[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
    }
    if (Math.abs(a) > mejorA) { mejorA = Math.abs(a); mejor = a ? [cx / (3 * a), cy / (3 * a)] : r[0]; }
  }
  return mejor;
}
// Distancia en línea recta (m) al recorrido de bus más cercano (para manzanas sin cobertura calculada)
const lineasBus = rutas.flatMap(f => (f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates).map(l => l.map(xy)));
function distBus(g) {
  const [px, py] = xy(centro(g));
  let d = Infinity;
  lineasBus.forEach(l => {
    for (let i = 1; i < l.length; i++) {
      const [ax, ay] = l[i - 1], [bx, by] = l[i], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
      d = Math.min(d, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
  });
  return Math.round(d);
}

// ---------------------------------------------------------------------
// Indicadores por manzana
// ---------------------------------------------------------------------
const MODOS = ['publico', 'auto', 'camina', 'bicicleta', 'motocicleta', 'cab_lan_bote', 'otros'];
const div = (a, b) => b ? a / b : null;

let sinCobertura = 0;
const filas = censo.map((f, i) => {
  const p = f.properties;
  const per = p.n_per || 0;
  const tras = MODOS.reduce((s, m) => s + (p['n_transporte_' + m] || 0), 0);
  const ha = areaHa(f.geometry);
  const c = coberturaDe.get(String(p.MANZENT));
  if (!c) sinCobertura++;
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
    sinint: div(Math.max(0, (p.n_hog || 0) - (p.n_internet || 0)), p.n_hog || 0),   // hogares sin internet
    jefa: div(p.n_jefatura_mujer || 0, p.n_hog || 0),                                 // jefatura femenina
    pueblo: div(p.n_pueblos_orig || 0, per),                         // para los perfiles: dato oculto por el INE = 0
    puebloMapa: p.n_pueblos_orig == null ? null : div(p.n_pueblos_orig, per),        // para el mapa: sin dato
    hog: p.n_hog || 0,
    edad: p.prom_edad ?? null,
    ninos: div((p.n_edad_0_5 || 0) + (p.n_edad_6_13 || 0), per),
    mayores: div(p.n_edad_60_mas || 0, per),
    inm: div(p.n_inmigrantes || 0, per),                             // nulos del INE cuentan como 0
    hacin: div(p.n_viv_hacinadas || 0, p.n_vp_ocupada || 0),
    esc: p.prom_escolaridad18 ?? null,
    desoc: div(p.n_desocupado || 0, (p.n_ocupado || 0) + (p.n_desocupado || 0)),
    dist: c ? c.dist_ruta : distBus(f.geometry),
    uv: c ? c.uv : null,
    localidad: p.LOCALIDAD,
    viv: indicadoresVivienda(p)
  };
});

// Variables que definen los perfiles (densidad en logaritmo para que no dominen los extremos)
const VARS = ['ninos', 'mayores', 'inm', 'pueblo', 'hacin', 'esc', 'desoc', 'densLog'];
filas.forEach(r => { r.densLog = r.dens != null ? Math.log1p(r.dens) : null; });

const validas = filas.filter(r => r.per >= MIN_PERSONAS && VARS.every(v => r[v] != null && isFinite(r[v])));

// Estandarización z-score
const media = {}, desv = {};
VARS.forEach(v => {
  const xs = validas.map(r => r[v]);
  media[v] = xs.reduce((a, b) => a + b, 0) / xs.length;
  desv[v] = Math.sqrt(xs.reduce((a, b) => a + (b - media[v]) ** 2, 0) / xs.length) || 1;
});
const X = validas.map(r => VARS.map(v => (r[v] - media[v]) / desv[v]));

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
    const nueva = X.map(x => centros.reduce((m, c, k) => d2(x, c) < d2(x, centros[m]) ? k : m, 0));
    const cambio = nueva.some((a, j) => a !== asign[j]);
    asign = nueva;
    for (let k = 0; k < K; k++) {
      const miembros = X.filter((_, j) => asign[j] === k);
      if (miembros.length) centros[k] = VARS.map((_, v) => miembros.reduce((s, m) => s + m[v], 0) / miembros.length);
    }
    if (!cambio) break;
  }
  return { centros, asign, inercia: X.reduce((s, x, j) => s + d2(x, centros[asign[j]]), 0) };
}

let mejor = null;
for (let n = 0; n < INTENTOS; n++) {
  const r = kmeans();
  if (!mejor || r.inercia < mejor.inercia) mejor = r;
}

// Nombrar cada grupo por su rasgo (promedios ponderados por población)
const promK = (k, v) => {
  const ms = validas.filter((_, j) => mejor.asign[j] === k);
  const pob = ms.reduce((s, r) => s + r.per, 0) || 1;
  return ms.reduce((s, r) => s + r[v] * r.per, 0) / pob;
};
const libres = new Set([...Array(K).keys()]);
const grupoDe = {};
['inm', 'desoc', 'mayores', 'esc'].forEach(v => {
  const k = [...libres].sort((a, b) => promK(b, v) - promK(a, v))[0];
  grupoDe[PERFILES.findIndex(d => d.rasgo === v)] = k;
  libres.delete(k);
});
grupoDe[PERFILES.findIndex(d => d.rasgo === null)] = [...libres][0];
const nuevoId = Object.fromEntries(Object.entries(grupoDe).map(([i, k]) => [k, +i]));
validas.forEach((r, j) => { r.cluster = nuevoId[mejor.asign[j]]; });
const enGrupo = new Map(validas.map(r => [r.i, r.cluster]));

// ---------------------------------------------------------------------
// Perfil de cada grupo (promedios ponderados por población)
// ---------------------------------------------------------------------
const red = (x, d = 1) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const pct = x => x == null ? null : red(100 * x, 1);
const redCoords = c => Array.isArray(c[0]) ? c.map(redCoords) : [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

const perfiles = PERFILES.map((def, k) => {
  const ms = validas.filter(r => r.cluster === k);
  const pob = ms.reduce((s, r) => s + r.per, 0);
  const prom = v => pob ? ms.reduce((s, r) => s + (r[v] ?? 0) * r.per, 0) / pob : null;
  return {
    letra: def.letra, nombre: def.nombre, color: def.color, desc: def.desc,
    cluster: k, manzanas: ms.length, poblacion: Math.round(pob),
    tp: pct(prom('tp')), auto: pct(prom('auto')), camina: pct(prom('camina')), otros: pct(prom('otros')),
    ninos: pct(prom('ninos')), adol: pct(prom('adol')), adultos: pct(prom('adultos')), mayores: pct(prom('mayores')),
    inm: pct(prom('inm')), pueblo: pct(prom('pueblo')), disc: pct(prom('disc')), hacin: pct(prom('hacin')),
    esc: red(prom('esc')), desoc: pct(prom('desoc')), dens: red(prom('dens'), 0), dist: red(prom('dist'), 0)
  };
});

// ---------------------------------------------------------------------
// Salida liviana para el mapa 3D
// ---------------------------------------------------------------------
const salida = {
  type: 'FeatureCollection',
  metadata: {
    comuna: 'Copiapó',
    generado: new Date().toISOString().slice(0, 10),
    fuente: 'Censo 2024 (INE), datos por manzana',
    metodo: `k-means (k=${K}) sobre variables demográficas estandarizadas: ${VARS.join(', ')}. Manzanas con menos de ${MIN_PERSONAS} personas sin perfil.`,
    perfiles
  },
  features: censo.map((f, i) => {
    const r = filas[i];
    return {
      type: 'Feature',
      properties: {
        id: i, uv: r.uv, localidad: r.localidad, cluster: enGrupo.has(i) ? enGrupo.get(i) : -1,
        per: r.per, dens: red(r.dens, 0),
        tp: pct(r.tp), auto: pct(r.auto), camina: pct(r.camina), otros: pct(r.otros),
        adol: pct(r.adol), adultos: pct(r.adultos), disc: pct(r.disc), sinint: pct(r.sinint), jefa: pct(r.jefa),
        pueblo: pct(r.puebloMapa),
        mineria: pct(r.viv.mineria), agua: pct(r.viv.agua), irrec: pct(r.viv.irrec),
        deficit: pct(r.viv.deficit), allegados: pct(r.viv.allegados), sincontrato: pct(r.viv.sincontrato),
        hog: r.hog, edad: red(r.edad), ninos: pct(r.ninos), mayores: pct(r.mayores), inm: pct(r.inm),
        hacin: pct(r.hacin), esc: red(r.esc), desoc: pct(r.desoc), dist: r.dist
      },
      geometry: { type: f.geometry.type, coordinates: redCoords(f.geometry.coordinates) }
    };
  })
};
fs.writeFileSync(`${DIR}/manzanas_3d.geojson`, JSON.stringify(salida));

// ---------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------
console.log(`\nManzanas: ${censo.length} · con perfil: ${validas.length} · k = ${K} · sin cobertura previa (distancia calculada aquí): ${sinCobertura}`);
console.table(perfiles.map(p => ({ perfil: p.letra + ' ' + p.nombre, manzanas: p.manzanas, poblacion: p.poblacion, ninos: p.ninos,
  mayores: p.mayores, inm: p.inm, pueblo: p.pueblo, hacin: p.hacin, esc: p.esc, desoc: p.desoc, dens: p.dens })));
// Dónde vive cada perfil: las 3 UV o localidades con más población del perfil
perfiles.forEach((p, k) => {
  const c = {};
  validas.filter(r => r.cluster === k).forEach(r => { const u = r.uv || r.localidad; c[u] = (c[u] || 0) + r.per; });
  console.log(`${p.letra}: ${Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([u, n]) => `${u} ${n}`).join(' · ')}`);
});
console.log(`\nGenerado: ${DIR}/manzanas_3d.geojson (${Math.round(fs.statSync(`${DIR}/manzanas_3d.geojson`).size / 1024)} KB)`);
