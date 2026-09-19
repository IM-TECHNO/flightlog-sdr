// Generates the static map data used by projector mode (public/geo/).
//   node scripts/make-geo.mjs [airport-codes.csv] [admin1-lines.geojson]
// - countries.json : country borders and coastlines from the `world-atlas` package (Natural Earth, public domain)
// - airports.json  : airports with an IATA code, from an airport-codes CSV (columns ICAO,IATA,Full_name,Continent,Location,Longitude,Latitude)
// - states.json    : state/province borders, only when a Natural Earth admin-1 *lines* GeoJSON is given
// The outputs are committed, so this only needs re-running to refresh the data.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mesh } from "topojson-client";

const [csvPath, statesPath] = process.argv.slice(2);
const outDir = new URL("../public/geo/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const write = (name, data) => {
  const json = JSON.stringify(data);
  writeFileSync(new URL(name, outDir), json);
  console.log(`wrote public/geo/${name}  ${(json.length / 1024).toFixed(0)} KB`);
};

// A line is stored flat as [lon0, lat0, lon1, lat1, ...], rounded to 0.01 degrees (about 1 km), repeats dropped.
const flat = (coords) => {
  const out = [];
  for (const [x, y] of coords) {
    const qx = Math.round(x * 100) / 100, qy = Math.round(y * 100) / 100;
    if (out.length >= 2 && out[out.length - 2] === qx && out[out.length - 1] === qy) continue;
    out.push(qx, qy);
  }
  return out;
};

const topo = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/countries-50m.json", import.meta.url), "utf8"));
write("countries.json", mesh(topo, topo.objects.countries).coordinates.map(flat).filter((l) => l.length >= 4));

if (statesPath) {
  const g = JSON.parse(readFileSync(statesPath, "utf8"));
  const lines = [];
  for (const f of g.features) {
    const geom = f.geometry;
    if (geom.type === "LineString") lines.push(geom.coordinates);
    else if (geom.type === "MultiLineString") lines.push(...geom.coordinates);
  }
  write("states.json", lines.map(flat).filter((l) => l.length >= 4));
}

if (csvPath) {
  if (!existsSync(csvPath)) throw new Error(`no such file: ${csvPath}`);
  // minimal CSV reader: handles quoted fields and doubled quotes
  const rows = [];
  let row = [], field = "", quoted = false;
  const text = readFileSync(csvPath, "utf8");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\" && text[i + 1] === '"') { field += '"'; i++; } // some rows escape a quote as \"
      else if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; if (row.length > 1) rows.push(row); row = []; }
    else field += c;
  }
  const airports = rows.slice(1)
    .filter((r) => r.length === 7) // skip any row that is still malformed
    .filter((r) => r[1] && Number.isFinite(+r[5]) && Number.isFinite(+r[6]))
    .map((r) => [r[0], r[1], r[2], Math.round(+r[6] * 1e4) / 1e4, Math.round(+r[5] * 1e4) / 1e4, /international/i.test(r[2]) ? 1 : 0]);
  write("airports.json", airports); // [icao, iata, name, lat, lon, international?]
}
