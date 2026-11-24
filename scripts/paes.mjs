// =====================================================================
// PAES 2026 por colegio — Copiapó y Tierra Amarilla (DEMRE, Archivo C)
// ---------------------------------------------------------------------
// Resume la base oficial del DEMRE (un registro por estudiante, anónimo)
// por colegio (RBD) y por rama, con los mismos criterios de los reportes
// "Tabla de frecuencias" del DEMRE (verificado con el Colegio Alicanto):
//   - promoción del año, alumno regular (SITUACION_EGRESO = 1);
//   - puntajes de la rendición regular del proceso actual (*_REG_ACTUAL);
//   - promedio de obligatorias = (Competencia Lectora + Matemática 1) / 2,
//     solo para quienes rindieron ambas.
// Referencia "colegios similares": misma dependencia y rama, en todo el país.
// Grupos con menos de MIN_N estudiantes no muestran promedios (poco confiables).
// El DEMRE pide no usar estos resultados para clasificar colegios ni hacer
// rankings: el Atlas los muestra solo en la ficha de cada colegio.
//
// Uso (desde la raíz del repositorio):
//   node scripts/paes.mjs
// Entrada (no se publica, .gitignore):
//   inputs/Colegios/PAES/Rinden_Admisión2026/ArchivoC_Adm2026REG.csv
// Salida:
//   inputs/paes_2026.json
// =====================================================================

import fs from 'node:fs';

const ORIGEN = 'inputs/Colegios/PAES/Rinden_Admisión2026/ArchivoC_Adm2026REG.csv';
const COMUNAS = { 3101: 'CP', 3103: 'TA' };
const MIN_N = 10;
const PRUEBAS = { clec: 'CLEC_REG_ACTUAL', m1: 'MATE1_REG_ACTUAL', m2: 'MATE2_REG_ACTUAL', hist: 'HCSOC_REG_ACTUAL', cien: 'CIEN_REG_ACTUAL' };
const RAMAS = { H1: 'Científico-humanista diurno', H2: 'Científico-humanista nocturno', H3: 'Validación de estudios', H4: 'Reconocimiento de estudios',
  T1: 'Técnico-profesional comercial', T2: 'Técnico-profesional industrial', T3: 'Técnico-profesional técnica y servicios',
  T4: 'Técnico-profesional agrícola', T5: 'Técnico-profesional marítima' };
const DEPENDENCIA = { 1: 'Particular pagado', 2: 'Particular subvencionado', 3: 'Municipal', 4: 'Servicio Local de Educación' };

// Lectura del CSV (separador ;, decimales con coma, texto entre comillas)
const texto = fs.readFileSync(ORIGEN, 'latin1').split(/\r?\n/).filter(Boolean);
const cab = texto[0].split(';').map(s => s.replace(/"/g, ''));
const col = Object.fromEntries(cab.map((k, i) => [k, i]));
const num = v => { const x = parseFloat(String(v || '').replace(/"/g, '').replace(',', '.')); return x > 0 ? x : null; };
const txt = v => String(v || '').replace(/"/g, '');

// Acumulador de un grupo de estudiantes
const nuevo = () => ({ inscritos: 0, oblig: [], nem: [], ranking: [], ...Object.fromEntries(Object.keys(PRUEBAS).map(k => [k, []])) });
function sumar(g, a) {
  g.inscritos++;
  Object.entries(PRUEBAS).forEach(([k, c]) => { const x = num(a[col[c]]); if (x) g[k].push(x); });
  const c = num(a[col.CLEC_REG_ACTUAL]), m = num(a[col.MATE1_REG_ACTUAL]);
  if (c && m) g.oblig.push((c + m) / 2);
  const nem = num(a[col.PTJE_NEM]), rk = num(a[col.PTJE_RANKING]);
  if (nem) g.nem.push(nem);
  if (rk) g.ranking.push(rk);
}
const prom = xs => xs.length ? Math.round(10 * xs.reduce((s, x) => s + x, 0) / xs.length) / 10 : null;
const mediana = xs => { if (!xs.length) return null; const o = xs.slice().sort((a, b) => a - b), m = o.length >> 1; return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
// Resumen publicable: N y promedios (solo si hay al menos MIN_N estudiantes); distribución de obligatorias en tramos de 50
function resumen(g) {
  const r = { inscritos: g.inscritos, n_oblig: g.oblig.length };
  const ok = xs => xs.length >= MIN_N;
  [...Object.keys(PRUEBAS), 'oblig', 'nem', 'ranking'].forEach(k => {
    r['n_' + k] = g[k].length;
    r[k] = ok(g[k]) ? prom(g[k]) : null;
  });
  r.oblig_mediana = ok(g.oblig) ? mediana(g.oblig) : null;
  if (ok(g.oblig)) {
    const tramos = Array(18).fill(0);                       // 100–149, 150–199, …, 950–1000
    g.oblig.forEach(x => { tramos[Math.min(17, Math.max(0, Math.floor((x - 100) / 50)))]++; });
    r.tramos = tramos;
  }
  return r;
}

const porColegio = new Map();   // RBD → { comuna, dep, total, ramas: Map(cod_ens → grupo) }
const similares = new Map();    // "dep|rama" → { nacional, region, CP, TA }
const porComuna = { CP: nuevo(), TA: nuevo() };   // todos los colegios de la comuna (promedio comunal)
// Por tipo de colegio y por rama, dentro de cada comuna (sección 04 del Atlas)
const GRUPO_RAMA = r => r === 'H1' ? 'HC' : r.startsWith('T') ? 'TP' : 'AD';   // HC diurno · técnico-profesional · adultos y otros
const porComunaDep = { CP: {}, TA: {} }, porComunaRama = { CP: {}, TA: {} };
let filasPromocion = 0;
for (let i = 1; i < texto.length; i++) {
  const a = texto[i].split(';');
  if (txt(a[col.SITUACION_EGRESO]) !== '1') continue;       // solo promoción del año, alumno regular
  filasPromocion++;
  const dep = txt(a[col.GRUPO_DEPENDENCIA]), rama = txt(a[col.RAMA_EDUCACIONAL]), comuna = COMUNAS[+txt(a[col.CODIGO_COMUNA])];
  const clave = dep + '|' + rama;
  if (!similares.has(clave)) similares.set(clave, { nacional: nuevo(), region: nuevo(), CP: nuevo(), TA: nuevo() });
  const s = similares.get(clave);
  sumar(s.nacional, a);
  if (txt(a[col.CODIGO_REGION]) === '3') sumar(s.region, a);
  if (comuna) sumar(s[comuna], a);
  if (!comuna) continue;
  sumar(porComuna[comuna], a);
  (porComunaDep[comuna][dep] ||= nuevo(), sumar(porComunaDep[comuna][dep], a));
  const gr = GRUPO_RAMA(rama);
  (porComunaRama[comuna][gr] ||= nuevo(), sumar(porComunaRama[comuna][gr], a));
  const rbd = +txt(a[col.RBD]), cod = txt(a[col.COD_ENS]);
  if (!porColegio.has(rbd)) porColegio.set(rbd, { comuna, dep, total: nuevo(), ramas: new Map() });
  const c = porColegio.get(rbd);
  sumar(c.total, a);
  if (!c.ramas.has(cod)) c.ramas.set(cod, { rama, grupo: nuevo() });
  sumar(c.ramas.get(cod).grupo, a);
}

// Salida
const colegios = {};
porColegio.forEach((c, rbd) => {
  colegios[rbd] = {
    comuna: c.comuna, dep: +c.dep, dependencia: DEPENDENCIA[c.dep],
    total: resumen(c.total),
    ramas: [...c.ramas].map(([cod, { rama, grupo }]) => ({ cod_ens: +cod, rama, nombre: RAMAS[rama] || rama, ...resumen(grupo) }))
      .sort((a, b) => b.inscritos - a.inscritos)
  };
});
const sim = {};
similares.forEach((s, clave) => {
  const corto = g => ({ n_oblig: g.oblig.length, oblig: g.oblig.length >= MIN_N ? prom(g.oblig) : null,
    clec: g.clec.length >= MIN_N ? prom(g.clec) : null, m1: g.m1.length >= MIN_N ? prom(g.m1) : null });
  sim[clave] = { nacional: corto(s.nacional), region: corto(s.region), CP: corto(s.CP), TA: corto(s.TA) };
});
fs.writeFileSync('inputs/paes_2026.json', JSON.stringify({
  metadata: {
    fuente: 'DEMRE, Archivo C (rinden) Admisión 2026. Promoción del año, alumno regular; rendición regular.',
    generado: new Date().toISOString().slice(0, 10), min_n: MIN_N,
    aviso: 'El DEMRE indica que estos resultados no deben usarse para clasificar establecimientos o generar rankings.',
    ramas: RAMAS, dependencias: DEPENDENCIA
  },
  colegios, similares: sim,
  comunas: Object.fromEntries(['CP', 'TA'].map(c => [c, {
    ...resumen(porComuna[c]),
    por_dep: Object.fromEntries(Object.entries(porComunaDep[c]).map(([d, g]) => [d, resumen(g)])),
    por_rama: Object.fromEntries(Object.entries(porComunaRama[c]).map(([r, g]) => [r, resumen(g)]))
  }]))
}));

// Reporte y verificación con el reporte DEMRE del Colegio Alicanto (41780-310)
const al = colegios[41780] && colegios[41780].ramas.find(r => r.cod_ens === 310);
console.log(`Promoción del año en el país: ${filasPromocion} · colegios de CP y TA con estudiantes: ${porColegio.size}`);
if (al) console.log(`Verificación Alicanto 310: N=${al.n_oblig} (DEMRE 33) · Lectora ${al.clec} (680,4) · M1 ${al.m1} (741,4) · obligatorias ${al.oblig} (710,9)`);
const atlas = new Set(JSON.parse(fs.readFileSync('inputs/colegios_atlas.geojson', 'utf8')).features.map(f => f.properties.rbd));
console.log('Promedio comunal (todos los colegios):', Object.fromEntries(Object.entries(porComuna).map(([k, g]) => [k,
  { rindieron: g.oblig.length, obligatorias: prom(g.oblig), lectora: prom(g.clec), m1: prom(g.m1) }])));
console.table(Object.entries(colegios).sort((a, b) => b[1].total.inscritos - a[1].total.inscritos).map(([rbd, c]) => ({
  rbd, comuna: c.comuna, dep: c.dependencia, 'en el atlas': atlas.has(+rbd) ? 'sí' : 'no',
  inscritos: c.total.inscritos, 'rindió oblig.': c.total.n_oblig, 'prom. oblig.': c.total.oblig,
  ramas: c.ramas.map(r => r.rama + '·' + r.n_oblig).join(' ')
})));
console.log(`Generado: inputs/paes_2026.json (${Math.round(fs.statSync('inputs/paes_2026.json').size / 1024)} KB)`);
