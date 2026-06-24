// core.js — pure, DOM-free logic for the LeRobot viewer.
// Everything here is unit-testable in Node without a browser.

export function isArrayLike(v) {
  return v != null && (Array.isArray(v) || ArrayBuffer.isView(v)) && typeof v !== 'string';
}

export function fmtNum(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4).replace(/\.?0+$/, '');
}

export function shortName(n) { return n.replace(/^observation\./, 'obs.'); }

export function escapeHtml(s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
export function escapeAttr(s) {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Probe an object for the first present key among candidates. BigInt -> Number.
export function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return typeof obj[k] === 'bigint' ? Number(obj[k]) : obj[k];
  }
  return null;
}

// Detect dataset version from the list of relative paths.
//   v3: meta/episodes/**.parquet present, OR data/**file-NNN.parquet with no episode_*.parquet
//   v2: data/**episode_NNNNNN.parquet (one file per episode)
export function detectVersion(paths) {
  const epMetaParquet = paths.filter(p => /meta\/episodes\/.*\.parquet$/.test(p));
  const dataParquet = paths.filter(p => /(^|\/)data\/.*\.parquet$/.test(p));
  const v2Episodes = paths.filter(p => /data\/.*episode_\d+\.parquet$/.test(p));
  if (epMetaParquet.length > 0 ||
      (dataParquet.some(p => /file[-_]\d+\.parquet$/.test(p)) && v2Episodes.length === 0)) {
    return 'v3';
  }
  return 'v2';
}

// Filter decoded rows down to a single episode by the episode_index column.
export function filterByEpisode(rows, epIndex) {
  if (!rows.length) return rows;
  if ('episode_index' in rows[0]) {
    const f = rows.filter(r => Number(r.episode_index) === Number(epIndex));
    return f.length ? f : rows;
  }
  return rows;
}

// Analyze columns from the first decoded row.
// Returns { columns:[{name,type,isArray,dim,sample}], plotCols:Set }
export function analyzeColumns(rows, info) {
  const columns = [];
  const plotCols = new Set();
  if (!rows.length) return { columns, plotCols };
  const sample = rows[0];
  for (const name of Object.keys(sample)) {
    const v = sample[name];
    let type, isArray = false, dim = null;
    if (isArrayLike(v)) {
      isArray = true; dim = v.length;
      type = (typeof v[0] === 'number') ? 'array<number>' : 'array';
    } else if (typeof v === 'number' || typeof v === 'bigint') {
      type = 'number';
    } else if (typeof v === 'boolean') {
      type = 'bool';
    } else if (typeof v === 'string') {
      type = 'string';
    } else if (v && typeof v === 'object') {
      type = 'object';
    } else {
      type = typeof v;
    }
    columns.push({ name, type, isArray, dim, sample: v });
  }
  for (const c of columns) {
    if ((c.name === 'observation.state' || c.name === 'action') && (c.isArray || c.type === 'number')) {
      plotCols.add(c.name);
    }
  }
  if (plotCols.size === 0) {
    for (const c of columns) {
      if ((c.type === 'number' || c.type === 'array<number>') && !/index$|timestamp|frame/.test(c.name)) {
        plotCols.add(c.name);
        if (plotCols.size >= 2) break;
      }
    }
  }
  return { columns, plotCols };
}

// Resolve the camera key list from info.json features, or null to signal
// "infer from videos/ directory" (handled by the caller with file paths).
export function cameraKeysFromInfo(info) {
  if (info && info.features) {
    return Object.keys(info.features).filter(
      k => /observation\.images?\./.test(k) || info.features[k].dtype === 'video');
  }
  return [];
}

// Given a list of video relative paths, choose the file for (camKey, episode).
// Mirrors the v2/v3 resolution rules. Returns the path string or undefined.
export function resolveVideoPath(paths, camKey, ep) {
  const epStr = String(ep.index).padStart(6, '0');
  let hit = paths.find(p => p.includes(camKey) && p.endsWith(`episode_${epStr}.mp4`));
  if (hit) return hit;
  hit = paths.find(p => p.includes(camKey) && new RegExp(`episode_0*${ep.index}\\.mp4$`).test(p));
  if (hit) return hit;
  if (ep.chunkIdx != null && ep.fileIdx != null) {
    hit = paths.find(p => p.includes(camKey) &&
      new RegExp(`chunk[-_]0*${ep.chunkIdx}\\b`).test(p) &&
      new RegExp(`file[-_]0*${ep.fileIdx}\\b`).test(p));
    if (hit) return hit;
  }
  hit = paths.find(p => p.includes(camKey) && p.endsWith('.mp4'));
  return hit;
}

// Infer camera keys from videos/ directory paths when info.json lacks them.
export function inferCameraKeys(paths) {
  const set = new Set();
  for (const p of paths) {
    const m = p.match(/videos\/(observation\.images?\.[^/]+)\//)
      || p.match(/videos\/[^/]*\/(observation\.images?\.[^/]+)\//);
    if (m) set.add(m[1]);
  }
  return [...set];
}
