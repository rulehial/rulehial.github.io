// =====================================================================
// Relaves mineros — Copiapó y Tierra Amarilla (Sernageomin)
// ---------------------------------------------------------------------
// Filtra el catastro de depósitos de relaves (polígonos) para las dos
// comunas del Atlas y calcula cuánta población vive cerca de cada uno,
// usando los centros de las manzanas del Censo 2024.
//
// Uso (desde la raíz del repositorio, después de los scripts de manzanas):
//   node scripts/relaves.mjs
//
// Entradas:
//   inputs/Respaldos/Sernageomin/geojson/Relaves_y_Pasivos_Ambientales_Depositos_de_R_2.geojson
//   inputs/manzanas_3d.geojson      (Copiapó)
//   inputs/manzanas_3d_ta.geojson   (Tierra Amarilla)
// Salidas:
//   inputs/relaves.geojson            (depósitos, con población a 500 m y 1 km)
//   inputs/relaves_manzanas.json      (por manzana: distancia al relave más cercano;
//                                       por relave: manzanas a menos de 1 km; totales por comuna)
// =====================================================================

import fs from 'node:fs';

const ORIGEN = 'inputs/Respaldos/Sernageomin/geojson/Relaves_y_Pasivos_Ambientales_Depositos_de_R_2.geojson';
// Geoquímica: muestras del material de los relaves (concentraciones en mg/kg = ppm)
const GEOQUIMICA = 'inputs/Respaldos/Sernageomin/geojson/Relaves_y_Pasivos_Ambientales_Geoquimica_de_Relaves.geojson';

// Valores de referencia: Guías de calidad de suelo de Canadá (CCME), uso residencial/parques, mg/kg.
// Chile no tiene norma de suelos; esta guía es la referencia más usada en estudios nacionales.
// "piso" = valor que el laboratorio informa cuando el elemento está bajo su límite de detección.
const ELEMENTOS = {
  AS: { ref: 12,  piso: 10 },   // arsénico
  PB: { ref: 140, piso: 2.5 },  // plomo
  CD: { ref: 10,  piso: 0.5 },  // cadmio
  HG: { ref: 6.6, piso: 0.01 }, // mercurio
  CU: { ref: 63,  piso: null }, // cobre
  ZN: { ref: 250, piso: 2.5 },  // zinc
  CR: { ref: 64,  piso: 5 },    // cromo total
  NI: { ref: 45,  piso: 2.5 },  // níquel
  SB: { ref: 20,  piso: 5 },    // antimonio
  CO: { ref: 50,  piso: 2.5 },  // cobalto
  MO: { ref: 10,  piso: 2.5 }   // molibdeno
};
const COMUNAS = { '03101': 'CP', '03103': 'TA' };

const leer = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const depositos = leer(ORIGEN).features.filter(f => COMUNAS[String(f.properties.CUT_COM).padStart(5, '0')]);
const manzanas = [...leer('inputs/manzanas_3d.geojson').features, ...leer('inputs/manzanas_3d_ta.geojson').features]
  .filter(f => !f.properties.sinPoblacion);

// Proyección local en metros
const R = 6371008.8, COS = Math.cos(-27.45 * Math.PI / 180);
const aM = ([lon, lat]) => [R * lon * Math.PI / 180 * COS, R * lat * Math.PI / 180];
const poligonos = g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;

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
const distSeg = ([px, py], [ax, ay], [bx, by]) => {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};
// Distancia (m) de un punto a un polígono (0 si está dentro)
function distancia(pt, anillosM) {
  if (anillosM.some(([ext, ...hs]) => dentroAnillo(pt, ext) && !hs.some(h => dentroAnillo(pt, h)))) return 0;
  let d = Infinity;
  anillosM.forEach(p => p.forEach(r => { for (let i = 1; i < r.length; i++) d = Math.min(d, distSeg(pt, r[i - 1], r[i])); }));
  return d;
}

// Simplificación liviana: descarta vértices a menos de ~3 m del anterior
const simplificar = anillo => {
  const out = [anillo[0]];
  for (let i = 1; i < anillo.length - 1; i++) {
    const [a, b] = [aM(out[out.length - 1]), aM(anillo[i])];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) >= 3) out.push(anillo[i]);
  }
  out.push(anillo[anillo.length - 1]);
  return out.length >= 4 ? out : anillo;
};
const red6 = c => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

const centrosMz = manzanas.map(f => ({ id: f.properties.id, comuna: f.properties.comuna === 'TA' ? 'TA' : 'CP',
  pt: aM(centro(f.geometry)), per: f.properties.per || 0, cerca: Infinity, relave: null }));
const mzPorRelave = {};
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const titulo = t => String(t || '').trim();

const muestras = leer(GEOQUIMICA).features
  .filter(f => /COPIAP|TIERRA AMARILLA/i.test(String(f.properties.COMUNA)) && f.geometry)
  .map(f => ({ pt: aM(f.geometry.coordinates), p: f.properties }));
const muestrasDe = new Map();      // índice del depósito → muestras
const anillosDep = depositos.map(f => poligonos(f.geometry).map(pl => pl.map(r => r.map(aM))));
let sinDeposito = 0;
muestras.forEach(m => {
  let mejor = -1, md = 150;
  anillosDep.forEach((a, k) => { const d = distancia(m.pt, a); if (d < md || (d === 0 && md !== 0)) { md = d; mejor = k; } });
  if (mejor < 0) { sinDeposito++; return; }
  if (!muestrasDe.has(mejor)) muestrasDe.set(mejor, []);
  muestrasDe.get(mejor).push(m.p);
});
// Resumen químico de un depósito: promedio y máximo de cada elemento, y veces sobre la referencia
function quimicaDe(lista) {
  if (!lista || !lista.length) return null;
  const q = { n: lista.length, el: {} };
  Object.entries(ELEMENTOS).forEach(([e, { ref, piso }]) => {
    const vs = lista.map(m => +m['CON_' + e]).filter(v => isFinite(v) && v > 0);
    if (!vs.length) return;
    const bajoLimite = piso != null && vs.every(v => v <= piso);
    const prom = vs.reduce((a, b) => a + b, 0) / vs.length, max = Math.max(...vs);
    q.el[e] = { prom: +prom.toPrecision(3), max: +max.toPrecision(3), veces: bajoLimite ? 0 : +(prom / ref).toFixed(1), bajo: bajoLimite || undefined };
  });
  return q;
}

const salida = depositos
  .map((f, k) => ({ f, quimica: quimicaDe(muestrasDe.get(k)) }))
  .filter(({ f }) => titulo(f.properties.ESTADO_INSTALACION_2026).toUpperCase() !== 'ELIMINADO')
  .map(({ f, quimica }, i) => {
    const p = f.properties;
    const anillosM = poligonos(f.geometry).map(pl => pl.map(r => r.map(aM)));
    let p500 = 0, p1000 = 0, minDist = Infinity;
    const cerca = [];
    centrosMz.forEach(m => {
      const d = distancia(m.pt, anillosM);
      if (d < m.cerca) { m.cerca = d; m.relave = i; }
      if (m.per <= 0) return;
      if (d <= 500) p500 += m.per;
      if (d <= 1000) { p1000 += m.per; cerca.push(m.id); }
      minDist = Math.min(minDist, d);
    });
    mzPorRelave[i] = cerca;
    const coords = poligonos(f.geometry).map(pl => pl.map(r => simplificar(r).map(red6)));
    return {
      type: 'Feature',
      properties: {
        id: i,
        comuna: COMUNAS[String(p.CUT_COM).padStart(5, '0')],
        codigo: titulo(p.ID),
        nombre: titulo(p.NOMBRE_INSTALACION) || 'Sin nombre',
        faena: titulo(p.NOMBRE_FAENA),
        empresa: titulo(p.NOMBRE_EMPRESA_O_PRODUCTOR_MINE),
        tipo: titulo(p.TIPO_DEPOSITO),
        recurso: titulo(p.RECURSO),
        estado: titulo(p.ESTADO_INSTALACION_2026).toUpperCase(),
        toneladas: num(p.TONELAJE_AUTORIZADO),
        volumen: num(p.VOL_AUTORIZADO),
        area_ha: Math.round((p.Shape__Area || 0) / 100) / 100,
        resolucion: titulo(p.RES_APRUEBA),
        fecha_res: p.FECHA_RES_APRUEBA ? String(p.FECHA_RES_APRUEBA).slice(0, 10) : '',
        pob_500: p500,
        pob_1000: p1000,
        dist_casas: Math.round(minDist),
        // Química del material (se guarda como texto: las propiedades de un mapa no pueden ser objetos anidados)
        quimica: quimica ? JSON.stringify(quimica) : null,
        // Elemento que más supera su referencia (para la leyenda y el tooltip)
        peor: quimica ? (Object.entries(quimica.el).sort((a, b) => b[1].veces - a[1].veces)[0] || [null])[0] : null,
        peor_veces: quimica ? Math.max(0, ...Object.values(quimica.el).map(x => x.veces)) : null
      },
      geometry: { type: f.geometry.type, coordinates: f.geometry.type === 'Polygon' ? coords[0] : coords }
    };
  });

// Por manzana: [distancia en m, id del relave más cercano]; totales sin contar dos veces a nadie
const totales = {};
['CP', 'TA'].forEach(c => {
  const ms = centrosMz.filter(m => m.comuna === c);
  totales[c] = {
    poblacion: ms.reduce((s, m) => s + m.per, 0),
    menos_500: ms.filter(m => m.cerca <= 500).reduce((s, m) => s + m.per, 0),
    menos_1000: ms.filter(m => m.cerca <= 1000).reduce((s, m) => s + m.per, 0),
    relaves: salida.filter(f => f.properties.comuna === c).length
  };
});
fs.writeFileSync('inputs/relaves_manzanas.json', JSON.stringify({
  manzanas: Object.fromEntries(centrosMz.map(m => [m.id, [Math.round(m.cerca), m.relave]])),
  porRelave: mzPorRelave,
  totales
}));

fs.writeFileSync('inputs/relaves.geojson', JSON.stringify({
  type: 'FeatureCollection',
  metadata: {
    fuente: 'Sernageomin, Catastro de Depósitos de Relaves (polígonos), estado 2026',
    generado: new Date().toISOString().slice(0, 10),
    metodo: 'Población cercana: personas de las manzanas del Censo 2024 cuyo centro está a menos de 500 m / 1 km del borde del depósito.'
  },
  features: salida
}));

// Reporte
console.log(`\nGeoquímica: ${muestras.length} muestras · ${muestras.length - sinDeposito} asignadas a ${muestrasDe.size} depósitos · ${sinDeposito} lejos de todo depósito`);
console.log(`Depósitos del Atlas con análisis químico: ${salida.filter(f => f.properties.quimica).length} de ${salida.length}`);
console.table(salida.filter(f => f.properties.quimica).sort((a, b) => b.properties.peor_veces - a.properties.peor_veces).slice(0, 10)
  .map(f => ({ comuna: f.properties.comuna, nombre: f.properties.nombre, muestras: JSON.parse(f.properties.quimica).n,
    'peor elemento': f.properties.peor, 'veces la ref.': f.properties.peor_veces, 'pers <1 km': f.properties.pob_1000 })));
console.log(`\nRelaves: ${salida.length} (sin los eliminados)`);
const resumen = {};
salida.forEach(f => {
  const k = `${f.properties.comuna} · ${f.properties.estado}`;
  resumen[k] = (resumen[k] || 0) + 1;
});
console.table(resumen);
console.log('\nMás cercanos a viviendas:');
console.table(salida.slice().sort((a, b) => b.properties.pob_1000 - a.properties.pob_1000).slice(0, 12)
  .map(f => ({ comuna: f.properties.comuna, nombre: f.properties.nombre, estado: f.properties.estado,
    toneladas: f.properties.toneladas, 'pers <500 m': f.properties.pob_500, 'pers <1 km': f.properties.pob_1000, 'casas a (m)': f.properties.dist_casas })));
console.log('\nPoblación cerca de algún relave (sin contar dos veces):');
console.table(totales);
console.log(`Generado: inputs/relaves_manzanas.json (${Math.round(fs.statSync('inputs/relaves_manzanas.json').size / 1024)} KB)`);
console.log(`\nGenerado: inputs/relaves.geojson (${Math.round(fs.statSync('inputs/relaves.geojson').size / 1024)} KB)`);
