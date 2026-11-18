// =====================================================================
// Cobertura de transporte público e indicadores Censo 2024 — Copiapó
// ---------------------------------------------------------------------
// Para cada manzana:
//   - calcula la distancia en línea recta (metros) desde su centro hasta el
//     recorrido de bus más cercano y la clasifica en bandas:
//       0 = menos de 200 m · 1 = 200 a 400 m · 2 = más de 400 m
//   - calcula el % de quienes se trasladan (trabajo/estudio) en transporte
//     público
// Luego suma por Unidad Vecinal (UV) urbana la población por banda y los
// indicadores del Censo 2024 (edades, movilidad, empleo, hogares, vivienda).
//
// Uso (desde la raíz del repositorio):
//   node scripts/calcular_cobertura.mjs
//
// Entradas:
//   inputs/manzanas_copiapo_V2.geojson  (Censo 2024 por manzana, exportado
//                                        desde QGIS con los campos usados aquí)
//   inputs/RutaBusesV2.geojson          (recorridos de buses)
//   inputs/UV_COPIAPO.geojson           (unidades vecinales, campo urbano = 1)
//   inputs/UV_FICTICIAS.geojson         (opcional: UV ficticias, mismo formato)
// Salidas:
//   inputs/manzanas_cobertura.geojson   (manzanas livianas para el mapa)
//   inputs/cobertura_uv.json            (resumen por UV y total)
//
// Sin dependencias: usa una proyección local (equirectangular) centrada en
// Copiapó, suficientemente precisa a escala de ciudad (error < 0,1 %).
// =====================================================================

import fs from 'node:fs';

const BANDAS = [200, 400]; // límites en metros
const MIN_PERSONAS_TP = 5; // bajo esto el % de transporte público no es confiable
const DIR = 'inputs';
const ARCHIVO_MANZANAS = 'manzanas_copiapo_V2.geojson';

const leer = f => JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));

const manzanas = leer(ARCHIVO_MANZANAS);
const rutas    = leer('RutaBusesV2.geojson');
const uvs      = leer('UV_COPIAPO.geojson');

// UV ficticias: áreas urbanas sin UV propia (p. ej. sectores altos dentro de la
// UV rural COPIAPÓ ESTE). Se suman como una UV urbana más.
if (fs.existsSync(`${DIR}/UV_FICTICIAS.geojson`)) {
  uvs.features.push(...leer('UV_FICTICIAS.geojson').features);
}

// Campos del Censo 2024 que se suman por UV (conteos de personas/hogares/viviendas)
const CAMPOS_SUMA = [
  'n_per', 'n_hombres', 'n_mujeres',
  'n_edad_0_5', 'n_edad_6_13', 'n_edad_14_17', 'n_edad_18_24', 'n_edad_25_44', 'n_edad_45_59', 'n_edad_60_mas',
  'n_inmigrantes', 'n_nacionalidad', 'n_pueblos_orig', 'n_discapacidad', 'n_religion',
  'n_ocupado', 'n_desocupado',
  'n_asistencia_basica', 'n_asistencia_media', 'n_asistencia_superior',
  'n_transporte_publico', 'n_transporte_auto', 'n_transporte_camina', 'n_transporte_bicicleta',
  'n_transporte_motocicleta', 'n_transporte_cab_lan_bote', 'n_transporte_otros',
  'n_hog', 'n_internet', 'n_jefatura_mujer', 'n_vp_ocupada', 'n_viv_hacinadas'
];
// Promedios que se ponderan por población
const CAMPOS_PROMEDIO = ['prom_edad', 'prom_escolaridad18'];
const MODOS = ['publico', 'auto', 'camina', 'bicicleta', 'motocicleta', 'cab_lan_bote', 'otros'];

// ---------------------------------------------------------------------
// Proyección local lon/lat → metros
// ---------------------------------------------------------------------
const R = 6371008.8;
const LAT0 = -27.37 * Math.PI / 180;
const COS_LAT0 = Math.cos(LAT0);
const proyectar = ([lon, lat]) => [
  R * (lon * Math.PI / 180) * COS_LAT0,
  R * (lat * Math.PI / 180)
];

const poligonos = geom =>
  geom.type === 'Polygon' ? [geom.coordinates]
  : geom.type === 'MultiPolygon' ? geom.coordinates
  : [];

const lineas = geom =>
  geom.type === 'LineString' ? [geom.coordinates]
  : geom.type === 'MultiLineString' ? geom.coordinates
  : [];

// ---------------------------------------------------------------------
// Geometría
// ---------------------------------------------------------------------

// Centroide por área (anillo exterior) de un Polygon/MultiPolygon, en metros
function centroide(geom) {
  let A = 0, cx = 0, cy = 0, sx = 0, sy = 0, n = 0;
  for (const poli of poligonos(geom)) {
    const anillo = poli[0].map(proyectar);
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
      const [x0, y0] = anillo[j], [x1, y1] = anillo[i];
      const f = x0 * y1 - x1 * y0;
      A += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
      sx += x1; sy += y1; n++;
    }
  }
  if (Math.abs(A) < 1e-9) return [sx / n, sy / n]; // polígono degenerado
  return [cx / (3 * A), cy / (3 * A)];
}

// Punto dentro de polígono (ray casting, respeta agujeros)
function dentroDeAnillo([x, y], anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      dentro = !dentro;
    }
  }
  return dentro;
}

function dentroDePoligonos(p, polisProyectados) {
  return polisProyectados.some(([exterior, ...agujeros]) =>
    dentroDeAnillo(p, exterior) && !agujeros.some(h => dentroDeAnillo(p, h))
  );
}

// Distancia de un punto a un segmento
function distSegmento([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

// ---------------------------------------------------------------------
// Preparar datos
// ---------------------------------------------------------------------

const segmentos = [];
for (const f of rutas.features) {
  for (const linea of lineas(f.geometry)) {
    const pts = linea.map(proyectar);
    for (let i = 1; i < pts.length; i++) segmentos.push([pts[i - 1], pts[i]]);
  }
}

const uvsUrbanas = uvs.features
  .filter(f => f.properties.urbano === 1)
  .map(f => ({
    nombre: f.properties.NOMBRE_UV,
    polis: poligonos(f.geometry).map(p => p.map(anillo => anillo.map(proyectar)))
  }));

// Manzanas de forma irregular cuyo centro cae justo fuera de su UV:
// se asignan a la UV que contiene la mayoría (≥ 50 %) de sus vértices
function uvPorMayoria(geom) {
  const vertices = poligonos(geom).flatMap(p => p[0]).map(proyectar);
  let mejor = null, mejorCuenta = 0;
  for (const u of uvsUrbanas) {
    const cuenta = vertices.filter(v => dentroDePoligonos(v, u.polis)).length;
    if (cuenta > mejorCuenta) { mejor = u; mejorCuenta = cuenta; }
  }
  return mejorCuenta >= vertices.length / 2 ? mejor : null;
}

const CLAVES = ['menos_200', 'entre_200_400', 'mas_400'];

function vacio() {
  return {
    poblacion: 0, manzanas: 0, menos_200: 0, entre_200_400: 0, mas_400: 0,
    tp_lejos_200: 0, // usuarios de transporte público que viven a 200 m o más de un recorrido
    censo: Object.fromEntries([
      ...CAMPOS_SUMA.map(c => [c, 0]),
      ...CAMPOS_PROMEDIO.flatMap(c => [[c + '_x_per', 0], [c + '_per', 0]])
    ])
  };
}

const resumenUV = Object.fromEntries(uvsUrbanas.map(u => [u.nombre, vacio()]));
const total = vacio();
const fueraUV = vacio();

const redondear = coords =>
  Array.isArray(coords[0])
    ? coords.map(redondear)
    : [Math.round(coords[0] * 1e6) / 1e6, Math.round(coords[1] * 1e6) / 1e6];

// ---------------------------------------------------------------------
// Cálculo por manzana
// ---------------------------------------------------------------------
const salidaManzanas = manzanas.features.map(f => {
  const p = f.properties;
  const pob = p.n_per || 0;
  const c = centroide(f.geometry);

  let dist = Infinity;
  for (const [a, b] of segmentos) {
    const d = distSegmento(c, a, b);
    if (d < dist) dist = d;
  }

  const banda = dist < BANDAS[0] ? 0 : dist <= BANDAS[1] ? 1 : 2;
  const uv = uvsUrbanas.find(u => dentroDePoligonos(c, u.polis)) || uvPorMayoria(f.geometry);
  const destino = uv ? resumenUV[uv.nombre] : fueraUV;

  const seTrasladan = MODOS.reduce((s, m) => s + (p['n_transporte_' + m] || 0), 0);
  const usanTP = p.n_transporte_publico || 0;

  for (const r of [destino, total]) {
    r.poblacion += pob;
    r.manzanas += 1;
    r[CLAVES[banda]] += pob;
    if (banda > 0) r.tp_lejos_200 += usanTP;
    CAMPOS_SUMA.forEach(k => { r.censo[k] += p[k] || 0; });
    CAMPOS_PROMEDIO.forEach(k => {
      if (p[k] != null && pob > 0) {
        r.censo[k + '_x_per'] += p[k] * pob;
        r.censo[k + '_per'] += pob;
      }
    });
  }

  return {
    type: 'Feature',
    properties: {
      n_per: pob,
      dist_ruta: Math.round(dist),
      banda,
      uv: uv ? uv.nombre : null,
      // % que usa transporte público (null si hay muy pocas personas para que sea confiable)
      tp: seTrasladan >= MIN_PERSONAS_TP ? Math.round(100 * usanTP / seTrasladan) : null
    },
    geometry: { type: f.geometry.type, coordinates: redondear(f.geometry.coordinates) }
  };
});

// ---------------------------------------------------------------------
// Limpieza: redondear conteos y convertir promedios ponderados
// ---------------------------------------------------------------------
function limpiar(r) {
  const censo = {};
  CAMPOS_SUMA.forEach(k => { censo[k] = Math.round(r.censo[k]); });
  CAMPOS_PROMEDIO.forEach(k => {
    const base = r.censo[k + '_per'];
    censo[k] = base ? Math.round(10 * r.censo[k + '_x_per'] / base) / 10 : null;
  });
  return {
    poblacion: Math.round(r.poblacion),
    manzanas: r.manzanas,
    menos_200: Math.round(r.menos_200),
    entre_200_400: Math.round(r.entre_200_400),
    mas_400: Math.round(r.mas_400),
    tp_lejos_200: Math.round(r.tp_lejos_200),
    censo
  };
}

const resumen = {
  generado: new Date().toISOString().slice(0, 10),
  metodo: 'Distancia en línea recta desde el centro de cada manzana al recorrido de bus más cercano.',
  bandas_m: BANDAS,
  fuente_poblacion: 'Censo 2024 (INE), datos por manzana',
  total: limpiar(total),
  fuera_uv_urbana: limpiar(fueraUV),
  uv: Object.fromEntries(Object.entries(resumenUV).map(([k, v]) => [k, limpiar(v)]))
};

fs.writeFileSync(
  `${DIR}/manzanas_cobertura.geojson`,
  JSON.stringify({ type: 'FeatureCollection', features: salidaManzanas })
);
fs.writeFileSync(`${DIR}/cobertura_uv.json`, JSON.stringify(resumen, null, 2));

// ---------------------------------------------------------------------
// Reporte en consola
// ---------------------------------------------------------------------
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '0.0') + ' %';
const t = resumen.total;
const tTras = MODOS.reduce((s, m) => s + t.censo['n_transporte_' + m], 0);
console.log(`\nManzanas: ${manzanas.features.length} · Segmentos de ruta: ${segmentos.length}`);
console.log(`Población total: ${t.poblacion}`);
console.log(`  < ${BANDAS[0]} m: ${pct(t.menos_200, t.poblacion)} · ${BANDAS[0]}–${BANDAS[1]} m: ${pct(t.entre_200_400, t.poblacion)} · > ${BANDAS[1]} m: ${pct(t.mas_400, t.poblacion)}`);
console.log(`Usan transporte público: ${pct(t.censo.n_transporte_publico, tTras)} de quienes se trasladan`);
console.log(`Usuarios de transporte público a 200 m o más de un recorrido: ${t.tp_lejos_200}`);
console.log(`Fuera de UV urbanas: ${resumen.fuera_uv_urbana.poblacion} personas\n`);

console.log('UV'.padEnd(20), 'Pobl.'.padStart(7), '<200m'.padStart(8), '%TP'.padStart(7), 'TP lejos'.padStart(9));
Object.entries(resumen.uv)
  .sort((a, b) => b[1].tp_lejos_200 - a[1].tp_lejos_200)
  .forEach(([k, v]) => {
    const tras = MODOS.reduce((s, m) => s + v.censo['n_transporte_' + m], 0);
    console.log(
      k.padEnd(20),
      String(v.poblacion).padStart(7),
      pct(v.menos_200, v.poblacion).padStart(8),
      pct(v.censo.n_transporte_publico, tras).padStart(7),
      String(v.tp_lejos_200).padStart(9)
    );
  });
console.log(`\nArchivos generados en ${DIR}/: manzanas_cobertura.geojson, cobertura_uv.json`);
