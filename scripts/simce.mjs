// =====================================================================
// SIMCE 2025 — Copiapó y Tierra Amarilla (Agencia de Calidad de la Educación)
// ---------------------------------------------------------------------
// Resume los resultados por establecimiento y por comuna de 4º básico,
// 8º básico y 2º medio:
//   - puntaje promedio por asignatura y número de estudiantes;
//   - grupo socioeconómico (GSE) del colegio y diferencia con colegios del
//     mismo GSE (con su significancia estadística);
//   - cambio respecto de la evaluación anterior (con significancia);
//   - estándares de aprendizaje: % insuficiente, elemental y adecuado.
// Además calcula, para cada grado y asignatura, el promedio nacional por GSE
// (ponderado por estudiantes), como referencia en la sección de colegios.
// Nota: la Agencia rotula estas bases como "entrega preliminar".
//
// Uso (desde la raíz del repositorio):
//   node scripts/simce.mjs
// Entrada (no se publica, .gitignore):
//   inputs/Colegios/SIMCE/{4B,8B,2M}/Archivos CSV (Planos)/simce{4b,8b,2m}2025_{rbd,comuna,region}_final.csv
// Salida:
//   inputs/simce_2025.json
// =====================================================================

import fs from 'node:fs';

const GRADOS = { '4b': '4º básico', '8b': '8º básico', '2m': '2º medio' };
const ASIG = { lect: 'Lectura', mate: 'Matemática', hist: 'Historia' };
const COMUNAS = { 3101: 'CP', 3103: 'TA' };
const GSE = { 1: 'Bajo', 2: 'Medio bajo', 3: 'Medio', 4: 'Medio alto', 5: 'Alto' };
const DEP2 = { 1: 'Municipal', 2: 'Particular subvencionado', 3: 'Particular pagado', 4: 'Servicio Local de Educación' };

const ruta = (g, nivel) => `inputs/Colegios/SIMCE/${g.toUpperCase()}/Archivos CSV (Planos)/simce${g}2025_${nivel}_final.csv`;
function leerCSV(f) {
  const t = fs.readFileSync(f, 'latin1').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const sep = (t[0].match(/;/g) || []).length > (t[0].match(/,/g) || []).length ? ';' : ',';
  const cab = t[0].split(sep).map(s => s.replace(/"/g, '').trim());
  return t.slice(1).map(l => { const a = l.split(sep); return Object.fromEntries(cab.map((k, i) => [k, (a[i] || '').replace(/"/g, '').trim()])); });
}
const num = v => { if (v == null || v === '') return null; const x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : null; };
const ent = v => { const x = num(v); return x == null ? null : Math.round(x); };

const colegios = {}, comunas = { CP: {}, TA: {} }, region = {}, nacionalGse = {};
for (const g of Object.keys(GRADOS)) {
  // Establecimientos (todo el país: para la referencia por GSE)
  const filas = leerCSV(ruta(g, 'rbd'));
  const asigs = Object.keys(ASIG).filter(a => filas[0] && (`prom_${a}${g}_rbd` in filas[0]));
  nacionalGse[g] = {};
  for (const r of filas) {
    const gse = ent(r.cod_grupo);
    asigs.forEach(a => {
      const n = num(r[`nalu_${a}${g}_rbd`]), p = num(r[`prom_${a}${g}_rbd`]);
      if (!gse || !n || p == null) return;
      const k = nacionalGse[g][gse] ||= {};
      const s = k[a] ||= { suma: 0, n: 0, ins: 0 };
      s.suma += p * n; s.n += n;
      const ins = num(r[`palu_eda_ins_${a}${g}_rbd`]); if (ins != null) s.ins += ins * n;
    });
    const comuna = COMUNAS[ent(r.cod_com_rbd)];
    if (!comuna) continue;
    const rbd = ent(r.rbd);
    const c = colegios[rbd] ||= { comuna, nombre: r.nom_rbd.replace(/\s+/g, ' '), dep2: ent(r.cod_depe2), gse: gse || null, grados: {} };
    if (!c.gse && gse) c.gse = gse;
    const grado = {};
    asigs.forEach(a => {
      const prom = ent(r[`prom_${a}${g}_rbd`]);
      grado[a] = {
        n: ent(r[`nalu_${a}${g}_rbd`]), prom,
        dif: ent(r[`dif_${a}${g}_rbd`]), sigdif: ent(r[`sigdif_${a}${g}_rbd`]),
        difgru: ent(r[`difgru_${a}${g}_rbd`]), siggru: ent(r[`siggru_${a}${g}_rbd`]),
        ins: num(r[`palu_eda_ins_${a}${g}_rbd`]), ele: num(r[`palu_eda_ele_${a}${g}_rbd`]), ade: num(r[`palu_eda_ade_${a}${g}_rbd`]),
        marca: ent(r[`marca_${a}${g}_rbd`])
      };
      if (prom == null) delete grado[a].prom;
    });
    if (Object.values(grado).some(x => x.prom != null)) c.grados[g] = grado;
  }
  // Promedio nacional por GSE
  Object.values(nacionalGse[g]).forEach(k => Object.keys(k).forEach(a => {
    const s = k[a]; k[a] = { prom: Math.round(s.suma / s.n), ins: Math.round(10 * s.ins / s.n) / 10, n: s.n };
  }));
  // Comunas (cifras oficiales de la Agencia)
  for (const r of leerCSV(ruta(g, 'comuna'))) {
    const comuna = COMUNAS[ent(r.cod_com)];
    if (!comuna) continue;
    comunas[comuna][g] = Object.fromEntries(asigs.map(a => [a, {
      prom: ent(r[`prom_${a}${g}_com`]), dif: ent(r[`dif_${a}${g}_com`]), sigdif: ent(r[`sigdif_${a}${g}_com`]),
      ins: num(r[`palu_eda_ins_${a}${g}_com`]), ele: num(r[`palu_eda_ele_${a}${g}_com`]), ade: num(r[`palu_eda_ade_${a}${g}_com`])
    }]).filter(([, v]) => v.prom != null));
  }
  // Región de Atacama
  for (const r of leerCSV(ruta(g, 'region'))) {
    if (ent(r.cod_reg) !== 3) continue;
    region[g] = Object.fromEntries(asigs.map(a => [a, { prom: ent(r[`prom_${a}${g}_reg`]), ins: num(r[`palu_eda_ins_${a}${g}_reg`]) }]).filter(([, v]) => v.prom != null));
  }
}
// Colegios sin ningún resultado publicable: fuera
Object.keys(colegios).forEach(k => { if (!Object.keys(colegios[k].grados).length) delete colegios[k]; });

fs.writeFileSync('inputs/simce_2025.json', JSON.stringify({
  metadata: {
    fuente: 'Agencia de Calidad de la Educación, Simce 2025 (4º básico, 8º básico y 2º medio), bases por establecimiento, comuna y región. Entrega preliminar.',
    generado: new Date().toISOString().slice(0, 10), grados: GRADOS, asignaturas: ASIG, gse: GSE, dependencias: DEP2
  },
  colegios, comunas, region, nacional_gse: nacionalGse
}));

// Reporte
const atlas = new Set(JSON.parse(fs.readFileSync('inputs/colegios_atlas.geojson', 'utf8')).features.map(f => f.properties.rbd));
console.log(`Colegios de CP y TA con resultados: ${Object.keys(colegios).length} · en la capa del Atlas: ${Object.keys(colegios).filter(k => atlas.has(+k)).length}`);
console.table(Object.entries(comunas).flatMap(([c, gs]) => Object.entries(gs).flatMap(([g, as]) => Object.entries(as).map(([a, v]) =>
  ({ comuna: c, grado: GRADOS[g], asignatura: ASIG[a], promedio: v.prom, 'insuficiente %': v.ins, 'adecuado %': v.ade, 'vs anterior': v.dif, sig: v.sigdif })))));
console.log(`Generado: inputs/simce_2025.json (${Math.round(fs.statSync('inputs/simce_2025.json').size / 1024)} KB)`);
