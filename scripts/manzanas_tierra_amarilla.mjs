// =====================================================================
// Tierra Amarilla — manzanas y UV para el Atlas (Censo 2024, INE)
// ---------------------------------------------------------------------
// Perfiles PROPIOS de Tierra Amarilla: k-means (k=4, semilla fija) solo con
// variables demográficas del Censo (sin transporte, porque no hay datos de
// buses en la comuna): niños, mayores, inmigrantes, pueblos originarios,
// hacinamiento, escolaridad, desocupación y densidad (logarítmica).
//
// Los nombres de los perfiles (PERFILES_TA) se escribieron mirando el
// resultado. Si cambian los datos, revise la tabla que imprime el script
// y ajuste los nombres si hace falta.
//
// Uso (desde la raíz del repositorio):
//   node scripts/manzanas_tierra_amarilla.mjs
//
// Entradas:
//   inputs/TierraAmarilla/manzanas_TA.geojson    (Censo 2024 por manzana)
//   inputs/TierraAmarilla/UV_TA_v2.geojson       (UV dibujadas a mano, ajustadas a las manzanas)
// Salidas:
//   inputs/manzanas_3d_ta.geojson   (manzanas livianas para el mapa 3D)
//   inputs/UV_TIERRA_AMARILLA.geojson (UV con el formato de UV_COPIAPO)
//   inputs/resumen_uv_ta.json        (totales del Censo por UV)
//
// Sin recorridos de bus en Tierra Amarilla: la distancia al bus queda vacía.
// =====================================================================

import fs from 'node:fs';

const DIR = 'inputs';
const MIN_PERSONAS = 20;
const ID_BASE = 100000;   // ids distintos a los de Copiapó (0…2480)
const K = 4;
const INTENTOS = 25;

// Cada nombre se asigna al grupo por su rasgo (campo `rasgo`), no por su tamaño:
// se elige en este orden: más inmigrantes → más hacinamiento → más mayores → el resto.
const PERFILES_TA = [
  { letra: '1', rasgo: null, nombre: 'Barrios densos con familias', color: '#4cc9f0',
    desc: 'Las manzanas más densas del pueblo: familias con niños, pocos adultos mayores y la escolaridad más alta de la comuna. Más de un tercio declara pertenecer a un pueblo originario.' },
  { letra: '2', rasgo: 'mayores', nombre: 'Barrios envejecidos', color: '#c77dff',
    desc: 'Uno de cada cuatro habitantes tiene 60 años o más. Baja densidad, pocos niños y más personas con discapacidad.' },
  { letra: '3', rasgo: 'hacin', nombre: 'Familias con hacinamiento', color: '#ff6b6b',
    desc: 'Muchos niños y el mayor hacinamiento de la comuna. Alta presencia de pueblos originarios. Incluye buena parte de Nantoco.' },
  { letra: '4', rasgo: 'inm', nombre: 'Alta migración', color: '#ffd166',
    desc: 'Casi 3 de cada 10 habitantes son inmigrantes, con hacinamiento sobre el promedio. Sobre todo en Los Loros.' }
];

const leer = f => JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
const censo = leer('TierraAmarilla/manzanas_TA.geojson').features;
const uvsTA = leer('TierraAmarilla/UV_TA_v2.geojson').features;

// ---------------------------------------------------------------------
// Nombres de UV: en mayúsculas como en Copiapó. Si se repite un nombre
// de Copiapó (Centro, Balmaceda) se agrega "T. AMARILLA".
// ---------------------------------------------------------------------
const nombresCopiapo = new Set(leer('UV_COPIAPO.geojson').features.map(f => f.properties.NOMBRE_UV));
const nombreUV = s => {
  const n = s.trim().toLocaleUpperCase('es-CL');
  return nombresCopiapo.has(n) ? n + ' T. AMARILLA' : n;
};

// ---------------------------------------------------------------------
// Geometría
// ---------------------------------------------------------------------
const R = 6371008.8, COS = Math.cos(-27.5 * Math.PI / 180);
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
// Centro del polígono más grande (centroide de área)
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
function dentroAnillo([x, y], r) {
  let d = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) d = !d;
  }
  return d;
}
const dentro = (pt, g) => poligonos(g).some(([ext, ...hs]) => dentroAnillo(pt, ext) && !hs.some(h => dentroAnillo(pt, h)));

// UV de cada manzana: la que cubre más superficie de la manzana (muestreo en grilla).
// Si ninguna la toca, la UV más cercana. Se anotan las manzanas repartidas entre UV.
// ---------------------------------------------------------------------
// Partes de manzanas del INE sin viviendas: se separan para que no se pinten
// con los datos de la manzana. La población queda en el resto de la manzana.
// (punto = un lugar dentro de la parte a separar)
// ---------------------------------------------------------------------
const PARTES_SIN_POBLACION = [
  { manzana: 3103011003001, punto: [-70.2712, -27.4867], nombre: 'Parque (sin viviendas)' }
];
const areasSinPoblacion = [];
PARTES_SIN_POBLACION.forEach(cfg => {
  const f = censo.find(f => f.properties.MANZENT === cfg.manzana);
  if (!f || f.geometry.type !== 'MultiPolygon') return console.log(`Aviso: no se pudo separar ${cfg.manzana}`);
  const partes = f.geometry.coordinates;
  const d = c => Math.hypot(c[0] - cfg.punto[0], c[1] - cfg.punto[1]);
  const k = partes.map((pt, i) => [i, d(centro({ type: 'Polygon', coordinates: pt }))]).sort((a, b) => a[1] - b[1])[0][0];
  areasSinPoblacion.push({ nombre: cfg.nombre, manzana: cfg.manzana, geometry: { type: 'Polygon', coordinates: partes[k] } });
  f.geometry = { type: 'MultiPolygon', coordinates: partes.filter((_, i) => i !== k) };
});

const uvs = uvsTA.map(f => ({ nombre: nombreUV(f.properties.Sector), id: f.properties.id, g: f.geometry, c: centro(f.geometry) }));
const cajaDe = g => {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  poligonos(g).forEach(p => p[0].forEach(([x, y]) => { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; }));
  return b;
};
uvs.forEach(u => { u.caja = cajaDe(u.g); });
const repartidas = [];
function uvDe(g, codigo, per) {
  const b = cajaDe(g);
  const paso = Math.max(b[2] - b[0], b[3] - b[1]) / 60;
  const cuenta = {};
  let total = 0;
  for (let x = b[0] + paso / 2; x < b[2]; x += paso) {
    for (let y = b[1] + paso / 2; y < b[3]; y += paso) {
      if (!dentro([x, y], g)) continue;
      total++;
      const u = uvs.find(u => x >= u.caja[0] && x <= u.caja[2] && y >= u.caja[1] && y <= u.caja[3] && dentro([x, y], u.g));
      const k = u ? u.nombre : '(fuera de toda UV)';
      cuenta[k] = (cuenta[k] || 0) + 1;
    }
  }
  const partes = Object.entries(cuenta).map(([k, n]) => [k, 100 * n / (total || 1)]).sort((a, b) => b[1] - a[1]);
  if (partes.length > 1 && partes[1][1] >= 5) repartidas.push({ manzana: codigo, personas: per, partes: partes.filter(p => p[1] >= 1).map(([k, v]) => `${k} ${v.toFixed(0)} %`).join(', ') });
  const dentroDeUV = partes.find(([k]) => k !== '(fuera de toda UV)');
  if (dentroDeUV) return dentroDeUV[0];
  const c = centro(g);
  return uvs.reduce((m, u) => (Math.hypot(u.c[0] - c[0], u.c[1] - c[1]) < Math.hypot(m.c[0] - c[0], m.c[1] - c[1]) ? u : m)).nombre;
}

// ---------------------------------------------------------------------
// Indicadores (igual que clusters_manzanas.mjs)
// ---------------------------------------------------------------------
const MODOS = ['publico', 'auto', 'camina', 'bicicleta', 'motocicleta', 'cab_lan_bote', 'otros'];
const div = (a, b) => b ? a / b : null;

const filas = censo.map((f, i) => {
  const p = f.properties;
  const per = p.n_per || 0;
  const tras = MODOS.reduce((s, m) => s + (p['n_transporte_' + m] || 0), 0);
  const ha = areaHa(f.geometry);
  return {
    i, per, ha,
    dens: ha > 0 ? per / ha : null,
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
    inm: div(p.n_inmigrantes || 0, per),
    pueblo: div(p.n_pueblos_orig || 0, per),
    hacin: div(p.n_viv_hacinadas || 0, p.n_vp_ocupada || 0),
    esc: p.prom_escolaridad18 ?? null,
    desoc: div(p.n_desocupado || 0, (p.n_ocupado || 0) + (p.n_desocupado || 0)),
    uv: uvDe(f.geometry, p.MANZENT, per),
    localidad: p.LOCALIDAD
  };
});

// ---------------------------------------------------------------------
// k-means++ propio (variables demográficas, z-score, semilla fija)
// ---------------------------------------------------------------------
const VARS = ['ninos', 'mayores', 'inm', 'pueblo', 'hacin', 'esc', 'desoc', 'densLog'];
filas.forEach(r => { r.densLog = r.dens != null ? Math.log1p(r.dens) : null; });
const validas = filas.filter(r => r.per >= MIN_PERSONAS && VARS.every(v => r[v] != null && isFinite(r[v])));
const media = {}, desv = {};
VARS.forEach(v => {
  const xs = validas.map(r => r[v]);
  media[v] = xs.reduce((a, b) => a + b, 0) / xs.length;
  desv[v] = Math.sqrt(xs.reduce((a, b) => a + (b - media[v]) ** 2, 0) / xs.length) || 1;
});
const X = validas.map(r => VARS.map(v => (r[v] - media[v]) / desv[v]));

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
      const ms = X.filter((_, j) => asign[j] === k);
      if (ms.length) centros[k] = VARS.map((_, v) => ms.reduce((s, m) => s + m[v], 0) / ms.length);
    }
    if (!cambio) break;
  }
  return { asign, inercia: X.reduce((s, x, j) => s + d2(x, centros[asign[j]]), 0) };
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
const grupoDe = {};                                   // índice del perfil → grupo k-means
['inm', 'hacin', 'mayores'].forEach(v => {
  const k = [...libres].sort((a, b) => promK(b, v) - promK(a, v))[0];
  grupoDe[PERFILES_TA.findIndex(d => d.rasgo === v)] = k;
  libres.delete(k);
});
grupoDe[PERFILES_TA.findIndex(d => d.rasgo === null)] = [...libres][0];
const nuevoId = Object.fromEntries(Object.entries(grupoDe).map(([i, k]) => [k, +i]));
filas.forEach(r => { r.cluster = -1; });
validas.forEach((r, j) => { r.cluster = nuevoId[mejor.asign[j]]; });

// ---------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------
const red = (x, d = 1) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const pct = x => x == null ? null : red(100 * x, 1);
const redCoords = c => Array.isArray(c[0]) ? c.map(redCoords) : [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

// Perfil de cada cluster en Tierra Amarilla (promedios ponderados por población)
const perfiles = PERFILES_TA.map((def, k) => {
  const ms = filas.filter(r => r.cluster === k);
  const pob = ms.reduce((s, r) => s + r.per, 0);
  const prom = v => pob ? ms.reduce((s, r) => s + (r[v] ?? 0) * r.per, 0) / pob : null;
  return {
    ...def, cluster: k, manzanas: ms.length, poblacion: Math.round(pob),
    tp: pct(prom('tp')), auto: pct(prom('auto')), camina: pct(prom('camina')), otros: pct(prom('otros')),
    ninos: pct(prom('ninos')), adol: pct(prom('adol')), adultos: pct(prom('adultos')), mayores: pct(prom('mayores')),
    inm: pct(prom('inm')), pueblo: pct(prom('pueblo')), disc: pct(prom('disc')), hacin: pct(prom('hacin')), esc: red(prom('esc')),
    desoc: pct(prom('desoc')), dens: red(prom('dens'), 0), dist: null
  };
});

// Vista inicial: el pueblo (manzanas urbanas de Tierra Amarilla)
const urbanas = censo.filter(f => f.properties.LOCALIDAD === 'TIERRA AMARILLA' && f.properties.AREA_C === 'URBANO');
const cs = urbanas.map(f => centro(f.geometry));
const pesoTot = urbanas.reduce((s, f) => s + (f.properties.n_per || 0), 0);
const vista = [
  red(urbanas.reduce((s, f, i) => s + cs[i][0] * (f.properties.n_per || 0), 0) / pesoTot, 4),
  red(urbanas.reduce((s, f, i) => s + cs[i][1] * (f.properties.n_per || 0), 0) / pesoTot, 4)
];

const salida = {
  type: 'FeatureCollection',
  metadata: {
    comuna: 'Tierra Amarilla',
    generado: new Date().toISOString().slice(0, 10),
    fuente: 'Censo 2024 (INE), datos por manzana. UV dibujadas a mano.',
    metodo: `k-means (k=${K}) sobre variables demográficas estandarizadas: ${VARS.join(', ')}. Manzanas con menos de ${MIN_PERSONAS} personas sin perfil. Sin recorridos de bus: distancia vacía.`,
    centro: vista,
    perfiles
  },
  features: censo.map((f, i) => {
    const r = filas[i];
    return {
      type: 'Feature',
      properties: {
        id: ID_BASE + i, comuna: 'TA', uv: r.uv, localidad: r.localidad, cluster: r.cluster,
        per: r.per, dens: red(r.dens, 0), tp: pct(r.tp), auto: pct(r.auto), camina: pct(r.camina), otros: pct(r.otros),
        adol: pct(r.adol), adultos: pct(r.adultos), disc: pct(r.disc), hog: r.hog, edad: red(r.edad),
        ninos: pct(r.ninos), mayores: pct(r.mayores), inm: pct(r.inm), pueblo: pct(r.pueblo), hacin: pct(r.hacin), esc: red(r.esc),
        desoc: pct(r.desoc), dist: null
      },
      geometry: { type: f.geometry.type, coordinates: redCoords(f.geometry.coordinates) }
    };
  }).concat(areasSinPoblacion.map((a, k) => ({
    // Sin datos: el mapa la pinta en gris con cualquier indicador
    type: 'Feature',
    properties: {
      id: ID_BASE + censo.length + k, comuna: 'TA', uv: uvDe(a.geometry, a.manzana + ' (parte sin viviendas)', 0),
      cluster: -1, sinPoblacion: true, nombre: a.nombre, manzana: a.manzana,
      per: null, dens: null, tp: null, auto: null, camina: null, otros: null, adol: null, adultos: null, disc: null, hog: null,
      edad: null, ninos: null, mayores: null, inm: null, pueblo: null, hacin: null, esc: null, desoc: null, dist: null
    },
    geometry: { type: 'Polygon', coordinates: redCoords(a.geometry.coordinates) }
  })))
};
fs.writeFileSync(`${DIR}/manzanas_3d_ta.geojson`, JSON.stringify(salida));

// UV con el formato de UV_COPIAPO (NOMBRE_UV, CODIGO_UV, urbano)
fs.writeFileSync(`${DIR}/UV_TIERRA_AMARILLA.geojson`, JSON.stringify({
  type: 'FeatureCollection',
  features: uvsTA.map((f, i) => ({
    type: 'Feature',
    properties: { NOMBRE_UV: uvs[i].nombre, CODIGO_UV: String(f.properties.id), urbano: 1, comuna: 'TA', sector: f.properties.Sector },
    geometry: { type: f.geometry.type, coordinates: redCoords(f.geometry.coordinates) }
  }))
}));

// Totales del Censo por UV (mismos campos que cobertura_uv.json → censo)
const CAMPOS = ['n_per', 'n_hombres', 'n_mujeres', 'n_edad_0_5', 'n_edad_6_13', 'n_edad_14_17', 'n_edad_18_24', 'n_edad_25_44',
  'n_edad_45_59', 'n_edad_60_mas', 'n_inmigrantes', 'n_nacionalidad', 'n_pueblos_orig', 'n_discapacidad', 'n_religion',
  'n_ocupado', 'n_desocupado', 'n_fuera_fuerza_trabajo', 'n_asistencia_basica', 'n_asistencia_media', 'n_asistencia_superior',
  ...MODOS.map(m => 'n_transporte_' + m), 'n_hog', 'n_internet', 'n_jefatura_mujer', 'n_vp_ocupada', 'n_viv_hacinadas'];
function sumar(ids) {
  const c = Object.fromEntries(CAMPOS.map(k => [k, 0]));
  let edad = 0, pesoEsc = 0, esc = 0;
  ids.forEach(i => {
    const p = censo[i].properties;
    CAMPOS.forEach(k => { c[k] += p[k] || 0; });
    if (p.prom_edad != null) edad += p.prom_edad * (p.n_per || 0);
    const adultos = (p.n_edad_18_24 || 0) + (p.n_edad_25_44 || 0) + (p.n_edad_45_59 || 0) + (p.n_edad_60_mas || 0);
    if (p.prom_escolaridad18 != null) { esc += p.prom_escolaridad18 * adultos; pesoEsc += adultos; }
  });
  c.prom_edad = c.n_per ? red(edad / c.n_per) : null;
  c.prom_escolaridad18 = pesoEsc ? red(esc / pesoEsc) : null;
  return { poblacion: c.n_per, manzanas: ids.length, censo: c };
}
const todos = censo.map((_, i) => i);
const resumen = {
  generado: salida.metadata.generado,
  fuente_poblacion: 'Censo 2024 (INE), datos por manzana',
  total: sumar(todos),
  uv: Object.fromEntries(uvs.map(u => [u.nombre, sumar(todos.filter(i => filas[i].uv === u.nombre))]))
};
fs.writeFileSync(`${DIR}/resumen_uv_ta.json`, JSON.stringify(resumen));

// ---------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------
console.log(`\nTierra Amarilla · manzanas: ${censo.length} · personas: ${resumen.total.poblacion} · con perfil: ${filas.filter(r => r.cluster >= 0).length}`);
console.log(`Centro del pueblo: ${vista}`);
areasSinPoblacion.forEach(a => console.log(`Separada: ${a.nombre} de la manzana ${a.manzana} (${areaHa(a.geometry).toFixed(1)} ha)`));
console.table(perfiles.map(p => ({ perfil: p.letra + ' ' + p.nombre, manzanas: p.manzanas, poblacion: p.poblacion, ninos: p.ninos, mayores: p.mayores, inm: p.inm, pueblo: p.pueblo, hacin: p.hacin, esc: p.esc, desoc: p.desoc, dens: p.dens })));
console.table(Object.entries(resumen.uv).map(([n, v]) => ({ uv: n, personas: v.poblacion, manzanas: v.manzanas })));
if (repartidas.length) {
  console.log(`\nOJO: ${repartidas.length} manzana(s) repartidas entre UV (5 % o más fuera de su UV principal):`);
  console.table(repartidas);
} else console.log('\nControl: ninguna manzana queda repartida entre dos UV.');
['manzanas_3d_ta.geojson', 'UV_TIERRA_AMARILLA.geojson', 'resumen_uv_ta.json']
  .forEach(f => console.log(`Generado: ${DIR}/${f} (${Math.round(fs.statSync(`${DIR}/${f}`).size / 1024)} KB)`));
