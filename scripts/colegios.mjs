// =====================================================================
// Colegios y liceos — Copiapó y Tierra Amarilla (Mineduc, matrícula 2026)
// ---------------------------------------------------------------------
// Une los polígonos de los establecimientos (dibujados en QGIS) con la
// matrícula oficial 2026 por RBD, y calcula:
//   - por colegio: matrícula por nivel, extranjeros, pueblos originarios,
//     integración (PIE), comuna donde viven sus alumnos, sobreedad,
//     especialidades técnico-profesionales y distancia al relave más cercano;
//   - por manzana: distancia al colegio más cercano (con básica o media).
// Quedan fuera los jardines infantiles y los establecimientos sin matrícula.
//
// Uso (desde la raíz del repositorio, después de scripts/relaves.mjs):
//   node scripts/colegios.mjs
//
// Entradas (filtradas a la provincia 31; no se publican, están en .gitignore):
//   inputs/Colegios/colegios.geojson                      (polígonos, RBD)
//   inputs/Colegios/Resumen_matricula_2026_prov31.csv     (un registro por establecimiento)
//   inputs/Colegios/Matricula_oficial_2026_prov31.csv     (un registro por estudiante, anónimo)
//   inputs/relaves.geojson, inputs/manzanas_3d.geojson, inputs/manzanas_3d_ta.geojson
// Salidas:
//   inputs/colegios_atlas.geojson      (colegios con sus indicadores)
//   inputs/colegios_manzanas.json      (por manzana: distancia al colegio más cercano; totales por comuna)
// =====================================================================

import fs from 'node:fs';

const COMUNAS = { 3101: 'CP', 3103: 'TA' };
const leer = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const csv = (f, sep) => {
  const L = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const h = L[0].split(sep).map(s => s.trim());
  return L.slice(1).map(l => { const a = l.split(sep); return Object.fromEntries(h.map((k, i) => [k, (a[i] || '').trim()])); });
};
const n = v => +v || 0;

// ---------------------------------------------------------------------
// 1) Resumen por establecimiento
// ---------------------------------------------------------------------
const resumen = new Map(csv('inputs/Colegios/Resumen_matricula_2026_prov31.csv', ',').map(r => [+r.RBD, r]));

// ---------------------------------------------------------------------
// 2) Matrícula por estudiante: comuna de residencia, sobreedad, especialidad
// ---------------------------------------------------------------------
const SECTORES = { 410: 'Administración y comercio', 510: 'Construcción', 520: 'Metalmecánica', 530: 'Electricidad',
  540: 'Minería', 550: 'Gráfica', 560: 'Química', 570: 'Confección', 580: 'Tecnología y telecomunicaciones',
  610: 'Alimentación', 620: 'Programas sociales', 630: 'Hotelería y turismo', 640: 'Salud y educación',
  710: 'Maderero', 720: 'Agropecuario', 810: 'Marítimo', 910: 'Artes visuales', 920: 'Teatro', 930: 'Danza' };
const porRBD = new Map();
for (const a of csv('inputs/Colegios/Matricula_oficial_2026_prov31.csv', ';')) {
  const rbd = +a.RBD;
  if (!porRBD.has(rbd)) porRBD.set(rbd, { total: 0, conCom: 0, otraCom: 0, deCom: {}, base: 0, sobre: 0, sectores: {} });
  const o = porRBD.get(rbd);
  o.total++;
  const ca = n(a.COD_COM_ALU), ce = n(a.COD_COM_RBD);
  if (ca) {
    o.conCom++;
    if (ca !== ce) o.otraCom++;
    o.deCom[a.NOM_COM_ALU] = (o.deCom[a.NOM_COM_ALU] || 0) + 1;
  }
  // Sobreedad: 2 años o más sobre la edad esperada del curso (edad al 30 de junio).
  // Básica niños regular (ENS 3): 1º básico = 6 años. Media jóvenes (ENS 5 a 8): 1º medio = 14 años.
  const ens = n(a.ENS), g = n(a.COD_GRADO), edad = n(a.EDAD_ALU);
  let esperada = null;
  if (ens === 3 && g >= 1 && g <= 8) esperada = 5 + g;
  if (ens >= 5 && ens <= 8 && g >= 1 && g <= 4) esperada = 13 + g;
  if (esperada != null && edad > 0) { o.base++; if (edad >= esperada + 2) o.sobre++; }
  const sec = n(a.COD_SEC);
  if (SECTORES[sec]) o.sectores[sec] = (o.sectores[sec] || 0) + 1;
}

// ---------------------------------------------------------------------
// Geometría (proyección local en metros)
// ---------------------------------------------------------------------
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
// Distancia entre dos polígonos (borde a borde; 0 si se tocan)
const vertices = anillosM => anillosM.flatMap(p => p.flatMap(r => r));
const distPoligonos = (A, B) => Math.min(...vertices(A).map(v => distancia(v, B)), ...vertices(B).map(v => distancia(v, A)));
const red6 = c => [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6];

const relaves = leer('inputs/relaves.geojson').features.map(f => ({
  id: f.properties.id, comuna: f.properties.comuna, nombre: f.properties.nombre,
  anillos: poligonos(f.geometry).map(pl => pl.map(r => r.map(aM)))
}));
const manzanas = [...leer('inputs/manzanas_3d.geojson').features, ...leer('inputs/manzanas_3d_ta.geojson').features]
  .filter(f => !f.properties.sinPoblacion)
  .map(f => ({ id: f.properties.id, comuna: f.properties.comuna === 'TA' ? 'TA' : 'CP', pt: aM(centro(f.geometry)),
    per: f.properties.per || 0, ninos: (f.properties.per || 0) * (f.properties.ninos || 0) / 100, cerca: Infinity, colegio: null,
    anillos: poligonos(f.geometry).map(pl => pl.map(r => r.map(aM))) }));
// Manzanas que pisa un colegio (en el mapa se apoya sobre su techo para que no quede escondido dentro)
const pisa = anillos => {
  const pts = vertices(anillos);
  const c = [pts.reduce((s, v) => s + v[0], 0) / pts.length, pts.reduce((s, v) => s + v[1], 0) / pts.length];
  return manzanas.filter(m => distancia(c, m.anillos) === 0 || distancia(m.pt, anillos) === 0
    || pts.filter(v => distancia(v, m.anillos) === 0).length >= Math.max(2, pts.length / 3)).map(m => m.id);
};

// ---------------------------------------------------------------------
// 3) Colegios: unión por RBD y filtros
// ---------------------------------------------------------------------
const fuera = [];
const colegios = [];
for (const f of leer('inputs/Colegios/colegios.geojson').features) {
  const p = f.properties, rbd = +p.RBD, comuna = COMUNAS[+p.COD_COM_RB];
  if (!comuna) continue;                                         // Caldera
  const r = resumen.get(rbd);
  const nombre = (r ? r.NOM_RBD : p.NOM_RBD).replace(/\s+/g, ' ').trim();
  if (/JARD[IÍ]N/i.test(nombre)) { fuera.push([rbd, nombre, 'jardín infantil']); continue; }
  if (!r || n(r.MAT_TOTAL) === 0 || n(r.ESTADO_ESTAB) !== 1) { fuera.push([rbd, nombre, r ? `sin matrícula 2026 (estado ${r.ESTADO_ESTAB})` : 'no está en 2026']); continue; }
  const mat = n(r.MAT_TOTAL);
  const niv = {
    par: n(r.MAT_ENS_1), bas: n(r.MAT_ENS_2), basA: n(r.MAT_ENS_3), esp: n(r.MAT_ENS_4),
    mhc: n(r.MAT_ENS_5), mhcA: n(r.MAT_ENS_6), mtp: n(r.MAT_ENS_7), mtpA: n(r.MAT_ENS_8)
  };
  if (niv.par === mat) { fuera.push([rbd, nombre, 'solo educación parvularia']); continue; }
  if (!f.geometry || !poligonos(f.geometry).some(pl => pl.length && pl[0].length >= 4)) { fuera.push([rbd, nombre, 'sin polígono dibujado']); continue; }
  const adultos = niv.basA + niv.mhcA + niv.mtpA;
  const tipo = niv.esp / mat > 0.5 ? 'especial' : adultos / mat > 0.5 ? 'adultos' : 'regular';
  const o = porRBD.get(rbd) || { conCom: 0, otraCom: 0, deCom: {}, base: 0, sobre: 0, sectores: {} };
  const anillos = poligonos(f.geometry).map(pl => pl.map(rr => rr.map(aM)));
  // Relave más cercano de la misma comuna o de la vecina (el valle es continuo)
  let relave = null, dRel = Infinity;
  relaves.forEach(rl => { const d = distPoligonos(anillos, rl.anillos); if (d < dRel) { dRel = d; relave = rl.id; } });
  // Niños (0–13) que viven a menos de 1 km
  const ninos1k = manzanas.reduce((s, m) => s + (distancia(m.pt, anillos) <= 1000 ? m.ninos : 0), 0);
  const residencia = Object.entries(o.deCom).sort((a, b) => b[1] - a[1]);
  const sectores = Object.entries(o.sectores).sort((a, b) => b[1] - a[1]).map(([k, v]) => [SECTORES[k], v]);
  colegios.push({
    anillos,
    f: {
      type: 'Feature',
      properties: {
        id: rbd, rbd, nombre, comuna,
        dep: n(r.COD_DEPE2) || +p.TIPO_DEPEN,                   // 1 municipal · 2 part. subvencionado · 3 part. pagado · 4 adm. delegada · 5 Servicio Local
        slep: r.NOMBRE_SLEP || '', rural: n(r.RURAL_RBD), tipo,
        mat, ...niv,
        hom: n(r.MAT_HOM_TOT), muj: n(r.MAT_MUJ_TOT),
        ext: n(r.MAT_EXT), etnia: n(r.MAT_ETNIA), pie: n(r.MAT_INT_TOTAL), cursos: n(r.CUR_SIM_TOT) + n(r.CUR_COMB_TOT),
        con_com: o.conCom, otra_com: o.otraCom,
        residencia: JSON.stringify(residencia.slice(0, 4)),     // [[comuna, alumnos], ...]
        sobre_base: o.base, sobre: o.sobre,
        sectores: sectores.length ? JSON.stringify(sectores) : null,
        minero: o.sectores[540] || 0,
        relave: isFinite(dRel) ? Math.round(dRel) : null, relave_id: relave,
        ninos_1000: Math.round(ninos1k),
        sobre_mz: JSON.stringify(pisa(anillos))                  // ids de las manzanas bajo el colegio
      },
      geometry: { type: 'MultiPolygon', coordinates: poligonos(f.geometry).map(pl => pl.map(rr => rr.map(red6))) }
    }
  });
}

// ---------------------------------------------------------------------
// 4) Por manzana: colegio más cercano con básica o media regular (no escuelas de lenguaje ni de adultos)
// ---------------------------------------------------------------------
const paraAcceso = colegios.filter(c => c.f.properties.tipo === 'regular' && (c.f.properties.bas + c.f.properties.mhc + c.f.properties.mtp) > 0);
manzanas.forEach(m => paraAcceso.forEach(c => {
  const d = distancia(m.pt, c.anillos);
  if (d < m.cerca) { m.cerca = d; m.colegio = c.f.properties.id; }
}));
const totales = {};
['CP', 'TA'].forEach(cm => {
  const ms = manzanas.filter(m => m.comuna === cm), cs = colegios.filter(c => c.f.properties.comuna === cm).map(c => c.f.properties);
  const suma = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
  totales[cm] = {
    colegios: cs.length, matricula: suma(cs, 'mat'),
    ninos: Math.round(suma(ms, 'ninos')),
    ninos_lejos_1000: Math.round(suma(ms.filter(m => m.cerca > 1000), 'ninos')),
    col_rel_500: cs.filter(c => c.relave != null && c.relave <= 500).length,
    col_rel_1000: cs.filter(c => c.relave != null && c.relave <= 1000).length,
    mat_rel_500: suma(cs.filter(c => c.relave != null && c.relave <= 500), 'mat'),
    mat_rel_1000: suma(cs.filter(c => c.relave != null && c.relave <= 1000), 'mat'),
    // Alumnos que viven en la otra comuna del Atlas
    de_la_otra: cs.reduce((s, c) => s + (JSON.parse(c.residencia).find(([k]) => k === (cm === 'CP' ? 'TIERRA AMARILLA' : 'COPIAPÓ')) || [0, 0])[1], 0)
  };
});

fs.writeFileSync('inputs/colegios_manzanas.json', JSON.stringify({
  manzanas: Object.fromEntries(manzanas.filter(m => m.colegio != null).map(m => [m.id, [Math.round(m.cerca), m.colegio]])),
  totales
}));
fs.writeFileSync('inputs/colegios_atlas.geojson', JSON.stringify({
  type: 'FeatureCollection',
  metadata: {
    fuente: 'Mineduc, Resumen de Matrícula por Establecimiento y Matrícula Oficial por Estudiante 2026 (corte 30-04-2026). Polígonos: elaboración propia en QGIS.',
    generado: new Date().toISOString().slice(0, 10),
    metodo: 'Unión por RBD. Sin jardines infantiles ni establecimientos sin matrícula 2026. Sobreedad: 2 años o más sobre la edad esperada del curso (edad al 30 de junio), en básica y media regular de niños y jóvenes. Distancias de borde a borde.'
  },
  features: colegios.map(c => c.f)
}));

// Reporte
console.log('\nFuera de la capa:');
console.table(fuera.map(([rbd, nombre, motivo]) => ({ rbd, nombre, motivo })));
const conPoligono = new Set([...colegios.map(c => c.f.properties.id), ...fuera.map(([rbd]) => rbd)]);
const sinPoligono = [...resumen.values()].filter(r => COMUNAS[+r.COD_COM_RBD] && n(r.MAT_TOTAL) > 0 && n(r.ESTADO_ESTAB) === 1
  && !conPoligono.has(+r.RBD) && !/JARD[IÍ]N/i.test(r.NOM_RBD) && n(r.MAT_ENS_1) !== n(r.MAT_TOTAL));
console.log('\nCon matrícula 2026 pero sin polígono (sin contar jardines):');
console.table(sinPoligono.map(r => ({ rbd: r.RBD, nombre: r.NOM_RBD.trim(), comuna: r.NOM_COM_RBD.trim(), matricula: +r.MAT_TOTAL })));
console.log(`\nColegios en la capa: ${colegios.length}`);
const cuenta = {};
colegios.forEach(c => { const k = `${c.f.properties.comuna} · dep ${c.f.properties.dep} · ${c.f.properties.tipo}`; cuenta[k] = (cuenta[k] || 0) + 1; });
console.table(cuenta);
console.log('\nMás cercanos a un relave:');
console.table(colegios.map(c => c.f.properties).sort((a, b) => a.relave - b.relave).slice(0, 12)
  .map(p => ({ comuna: p.comuna, nombre: p.nombre, matricula: p.mat, 'relave a (m)': p.relave, relave: relaves.find(r => r.id === p.relave_id)?.nombre })));
console.log(`\nColegios sobre alguna manzana censal: ${colegios.filter(c => JSON.parse(c.f.properties.sobre_mz).length).length} de ${colegios.length}`);
console.log('\nTotales por comuna:');
console.table(totales);
console.log(`Generado: inputs/colegios_atlas.geojson (${Math.round(fs.statSync('inputs/colegios_atlas.geojson').size / 1024)} KB)`);
console.log(`Generado: inputs/colegios_manzanas.json (${Math.round(fs.statSync('inputs/colegios_manzanas.json').size / 1024)} KB)`);
