import {
  isArrayLike, fmtNum, shortName, escapeHtml, escapeAttr, pick,
  detectVersion, filterByEpisode, analyzeColumns as analyzeColumnsCore,
  cameraKeysFromInfo, resolveVideoPath, inferCameraKeys,
} from './core.js';

// ============================================================
//  Library loading: hyparquet (pure JS, no WASM) from CDN.
//  Falls back to a local ./lib/ copy for fully-offline use.
// ============================================================
let parquetModule = null, compressorsModule = null;
const CDN = {
  hyparquet: [
    'https://cdn.jsdelivr.net/npm/hyparquet@1.17.0/src/hyparquet.min.js',
    'https://cdn.jsdelivr.net/npm/hyparquet/src/hyparquet.min.js',
    'https://esm.sh/hyparquet@1.17.0',
  ],
  compressors: [
    'https://cdn.jsdelivr.net/npm/hyparquet-compressors/src/hyparquet-compressors.min.js',
    'https://esm.sh/hyparquet-compressors',
  ],
  local: { hyparquet: './lib/hyparquet.min.js', compressors: './lib/hyparquet-compressors.min.js' },
};

async function tryImport(urls) {
  for (const u of urls) {
    try { const m = await import(/* @vite-ignore */ u); if (m) return m; }
    catch (e) { /* try next */ }
  }
  return null;
}

async function loadLibs() {
  setStatus('busy', 'ライブラリ読み込み中…');
  // Prefer local copy if present (offline), else CDN.
  parquetModule = await tryImport([CDN.local.hyparquet, ...CDN.hyparquet]);
  if (!parquetModule) {
    setStatus('err', 'hyparquet を読み込めませんでした');
    document.getElementById('statusLib').textContent = 'オフライン環境では ./lib/ に hyparquet を配置してください';
    throw new Error('hyparquet load failed');
  }
  compressorsModule = await tryImport([CDN.local.compressors, ...CDN.compressors]);
  const compNote = compressorsModule ? 'snappy/gzip/zstd 対応' : 'snappy のみ（compressors未読込）';
  document.getElementById('statusLib').textContent = 'hyparquet ' + compNote;
  setStatus('ok', '準備完了');
  return true;
}

function getCompressors() {
  return compressorsModule ? (compressorsModule.compressors || compressorsModule.default) : undefined;
}

// ============================================================
//  Helpers
// ============================================================
const $ = (id) => document.getElementById(id);
function setStatus(state, text) {
  const dot = $('statusDot');
  dot.className = 'dot' + (state === 'ok' ? ' ok' : state === 'busy' ? ' busy' : state === 'err' ? ' err' : '');
  if (text != null) $('statusText').textContent = text;
}
function showLoading(msg) { $('loadingMsg').textContent = msg || '読み込み中…'; $('loadingOverlay').classList.remove('hidden'); }
function hideLoading() { $('loadingOverlay').classList.add('hidden'); }

// ============================================================
//  Dataset model
// ============================================================
const DS = {
  version: null,        // 'v2' | 'v3'
  info: null,           // parsed meta/info.json
  files: new Map(),     // relativePath -> File
  episodes: [],         // [{index, length, dataFile, rowStart, rowEnd, taskIndex}]
  currentEp: null,      // episode object
  rows: [],             // decoded rows for current episode (array of objects)
  columns: [],          // [{name, type, isArray, dim, sample}]
  cameras: [],          // [{key, file}]  resolved for current episode
  fps: 30,
  page: 0,
  pageSize: 100,
  selectedRow: null,
  plotCols: new Set(),
};

// Build a path->File map from a FileList (webkitdirectory gives webkitRelativePath)
function indexFiles(fileList) {
  const map = new Map();
  for (const f of fileList) {
    let rel = f.webkitRelativePath || f.name;
    // strip the top-level folder name so paths start at dataset root
    const parts = rel.split('/');
    if (parts.length > 1) parts.shift();
    map.set(parts.join('/'), f);
  }
  return map;
}

function findFile(predicate) {
  for (const [path, file] of DS.files) if (predicate(path, file)) return { path, file };
  return null;
}
function findAll(predicate) {
  const out = [];
  for (const [path, file] of DS.files) if (predicate(path, file)) out.push({ path, file });
  return out;
}

// ============================================================
//  Parquet reading
// ============================================================
async function readParquet(file, opts = {}) {
  const buf = await file.arrayBuffer();
  const { parquetReadObjects } = parquetModule;
  // Wrap the in-memory ArrayBuffer as an AsyncBuffer (hyparquet's expected shape).
  const asyncBuffer = {
    byteLength: buf.byteLength,
    slice: (start, end) => buf.slice(start, end ?? buf.byteLength),
  };
  const readOpts = { file: asyncBuffer, rowFormat: 'object' };
  const comp = getCompressors();
  if (comp) readOpts.compressors = comp;
  if (opts.rowStart != null) readOpts.rowStart = opts.rowStart;
  if (opts.rowEnd != null) readOpts.rowEnd = opts.rowEnd;
  if (opts.columns) readOpts.columns = opts.columns;
  return await parquetReadObjects(readOpts);
}

async function readParquetMeta(file) {
  const buf = await file.arrayBuffer();
  const { parquetMetadataAsync } = parquetModule;
  const asyncBuffer = { byteLength: buf.byteLength, slice: (s, e) => buf.slice(s, e ?? buf.byteLength) };
  try { return await parquetMetadataAsync(asyncBuffer); }
  catch (e) { return null; }
}

// ============================================================
//  Dataset detection & loading
// ============================================================
async function loadDataset(fileList) {
  DS.files = indexFiles(fileList);
  if (DS.files.size === 0) { setStatus('err', 'ファイルが見つかりません'); return; }

  showLoading('データセット構造を解析中…');
  try {
    // --- info.json ---
    const infoEntry = findFile((p) => p.endsWith('meta/info.json') || p === 'info.json');
    if (infoEntry) {
      try { DS.info = JSON.parse(await infoEntry.file.text()); } catch { DS.info = null; }
    }

    // --- detect version (delegated to core.detectVersion) ---
    const allPaths = [...DS.files.keys()];
    const epMetaParquet = findAll((p) => /meta\/episodes\/.*\.parquet$/.test(p));
    const dataParquet = findAll((p) => /(^|\/)data\/.*\.parquet$/.test(p));
    const v2Episodes = findAll((p) => /data\/.*episode_\d+\.parquet$/.test(p));

    DS.version = detectVersion(allPaths);
    if (DS.version === 'v3') {
      await loadV3(epMetaParquet, dataParquet);
    } else {
      await loadV2(v2Episodes.length ? v2Episodes : dataParquet);
    }

    DS.fps = (DS.info && (DS.info.fps || DS.info.frame_rate)) || 30;

    renderDatasetInfo();
    renderEpisodeList();
    if (DS.episodes.length > 0) await selectEpisode(DS.episodes[0]);
    setStatus('ok', `${DS.version} データセット / ${DS.episodes.length} エピソード`);
  } catch (e) {
    console.error(e);
    setStatus('err', '読み込みエラー: ' + e.message);
    alert('読み込みに失敗しました: ' + e.message);
  } finally {
    hideLoading();
  }
}

// ---- v2: one parquet per episode ----
async function loadV2(entries) {
  // sort by episode number
  entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  DS.episodes = entries.map((e, i) => {
    const m = e.path.match(/episode_(\d+)\.parquet$/);
    const idx = m ? parseInt(m[1], 10) : i;
    return { index: idx, length: null, dataFile: e.file, dataPath: e.path, rowStart: null, rowEnd: null, mode: 'whole' };
  });

  // optional: read episode lengths from meta/episodes.jsonl
  const epJsonl = findFile((p) => p.endsWith('meta/episodes.jsonl'));
  if (epJsonl) {
    try {
      const text = await epJsonl.file.text();
      const lenByIdx = {};
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const o = JSON.parse(line);
        if (o.episode_index != null && o.length != null) lenByIdx[o.episode_index] = o.length;
      }
      for (const ep of DS.episodes) if (lenByIdx[ep.index] != null) ep.length = lenByIdx[ep.index];
    } catch {}
  }
}

// ---- v3: many episodes per parquet, boundaries in meta ----
async function loadV3(epMetaEntries, dataEntries) {
  dataEntries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));

  // Read episode metadata parquet(s) to get per-episode boundaries.
  let epMeta = [];
  for (const e of epMetaEntries) {
    try { const rows = await readParquet(e.file); epMeta = epMeta.concat(rows); } catch {}
  }

  if (epMeta.length > 0) {
    // Typical columns: episode_index, length, tasks, data/chunk_index, data/file_index,
    // and frame/byte offsets. Field names vary across lerobot versions, so probe.
    DS.episodes = epMeta.map((r, i) => {
      const idx = pick(r, ['episode_index', 'index', 'episode']) ?? i;
      const length = pick(r, ['length', 'num_frames', 'frame_count', 'episode_length']);
      const fromIdx = pick(r, ['dataset_from_index', 'data_from_index', 'from_index', 'global_index_from']);
      const toIdx = pick(r, ['dataset_to_index', 'data_to_index', 'to_index', 'global_index_to']);
      const chunkIdx = pick(r, ['data/chunk_index', 'chunk_index', 'data_chunk_index']);
      const fileIdx = pick(r, ['data/file_index', 'file_index', 'data_file_index']);
      return {
        index: idx, length, mode: 'slice',
        rowStart: fromIdx, rowEnd: toIdx,
        chunkIdx, fileIdx, _meta: r,
        dataEntries,
      };
    });
    DS.episodes.sort((a, b) => a.index - b.index);
  } else {
    // Fallback: no usable episode meta — treat each data parquet as a "segment".
    DS.episodes = dataEntries.map((e, i) => ({
      index: i, length: null, mode: 'whole', dataFile: e.file, dataPath: e.path,
    }));
  }
  DS._v3DataEntries = dataEntries;
}


// Resolve which data parquet + row-range to read for a v3 episode.
async function resolveV3Rows(ep) {
  // Strategy A: explicit chunk/file index → find that file, slice by within-file offset.
  // Strategy B: global from/to index → walk concatenated files counting rows.
  const entries = DS._v3DataEntries || [];
  // Try matching by chunk/file index in the path.
  if (ep.chunkIdx != null && ep.fileIdx != null) {
    const want = entries.find(e =>
      new RegExp(`chunk[-_]0*${ep.chunkIdx}\\b`).test(e.path) &&
      new RegExp(`file[-_]0*${ep.fileIdx}\\b`).test(e.path));
    if (want) {
      const rows = await readParquet(want.file);
      // within-file slice if we can infer it
      const localFrom = pick(ep._meta, ['data/from_index','chunk_from_index']) ?? 0;
      const localTo = pick(ep._meta, ['data/to_index','chunk_to_index']) ?? rows.length;
      if (localFrom < rows.length) return rows.slice(localFrom, localTo);
      // else filter by episode_index column if present
      return filterByEpisode(rows, ep.index);
    }
  }
  // Strategy B: global index walk.
  if (ep.rowStart != null && ep.rowEnd != null) {
    let acc = 0, collected = [];
    for (const e of entries) {
      const meta = await readParquetMeta(e.file);
      const nRows = meta ? Number(meta.num_rows ?? meta.numRows ?? 0) : 0;
      const fileStart = acc, fileEnd = acc + nRows;
      if (ep.rowEnd > fileStart && ep.rowStart < fileEnd) {
        const rows = await readParquet(e.file);
        const s = Math.max(0, ep.rowStart - fileStart);
        const en = Math.min(rows.length, ep.rowEnd - fileStart);
        collected = collected.concat(rows.slice(s, en));
      }
      acc = fileEnd;
      if (acc >= ep.rowEnd) break;
    }
    if (collected.length) return collected;
  }
  // Fallback: read first data file and filter by episode_index column.
  if (entries.length) {
    const rows = await readParquet(entries[0].file);
    return filterByEpisode(rows, ep.index);
  }
  return [];
}


// ============================================================
//  Episode selection
// ============================================================
async function selectEpisode(ep) {
  DS.currentEp = ep;
  DS.page = 0;
  DS.selectedRow = null;
  showLoading(`エピソード ${ep.index} を読み込み中…`);
  setStatus('busy', `エピソード ${ep.index} 読み込み中`);
  try {
    let rows;
    if (ep.mode === 'whole' && ep.dataFile) {
      rows = await readParquet(ep.dataFile);
    } else if (DS.version === 'v3') {
      rows = await resolveV3Rows(ep);
    } else {
      rows = await readParquet(ep.dataFile);
    }
    DS.rows = rows || [];
    if (ep.length == null) ep.length = DS.rows.length;
    analyzeColumns();
    resolveCameras(ep);
    renderEpisodeList();
    renderActiveTab();
    setStatus('ok', `エピソード ${ep.index} / ${DS.rows.length} フレーム`);
  } catch (e) {
    console.error(e);
    setStatus('err', 'エピソード読み込み失敗: ' + e.message);
    DS.rows = [];
  } finally {
    hideLoading();
  }
}

function analyzeColumns() {
  const { columns, plotCols } = analyzeColumnsCore(DS.rows, DS.info);
  DS.columns = columns;
  DS.plotCols = plotCols;
}

// ============================================================
//  Camera / video resolution
// ============================================================
function resolveCameras(ep) {
  DS.cameras = [];
  const allPaths = [...DS.files.keys()];
  let camKeys = cameraKeysFromInfo(DS.info);
  if (camKeys.length === 0) camKeys = inferCameraKeys(allPaths);

  for (const key of camKeys) {
    const path = resolveVideoPath(allPaths, key, ep);
    if (path) DS.cameras.push({ key, file: DS.files.get(path), path });
  }
}

// ============================================================
//  Rendering: dataset info + episodes
// ============================================================
function renderDatasetInfo() {
  const tag = $('datasetTag');
  tag.classList.remove('hidden');
  tag.innerHTML = `<span class="badge">${DS.version.toUpperCase()}</span>${
    (DS.info && (DS.info.repo_id || DS.info.dataset_name)) || 'local dataset'}`;

  const rows = [];
  if (DS.info) {
    if (DS.info.robot_type) rows.push(['robot', DS.info.robot_type]);
    rows.push(['fps', DS.fps]);
    if (DS.info.total_episodes != null) rows.push(['episodes', DS.info.total_episodes]);
    if (DS.info.total_frames != null) rows.push(['frames', DS.info.total_frames]);
    if (DS.info.features) rows.push(['features', Object.keys(DS.info.features).length]);
  } else {
    rows.push(['format', DS.version]);
    rows.push(['fps', DS.fps]);
  }
  $('infoRows').innerHTML = rows.map(([k, v]) =>
    `<div class="meta-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
}

function renderEpisodeList() {
  const el = $('episodeItems');
  if (!DS.episodes.length) { el.innerHTML = '<div style="padding:8px;color:var(--ink-faint)">なし</div>'; return; }
  el.innerHTML = DS.episodes.map(ep => `
    <div class="ep-item ${DS.currentEp === ep ? 'active' : ''}" data-idx="${ep.index}">
      <span>ep ${String(ep.index).padStart(4, '0')}</span>
      <span class="len">${ep.length != null ? ep.length + 'f' : ''}</span>
    </div>`).join('');
  el.querySelectorAll('.ep-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.idx, 10);
      const ep = DS.episodes.find(e => e.index === idx);
      if (ep && ep !== DS.currentEp) selectEpisode(ep);
    });
  });
}

// ============================================================
//  Rendering: table
// ============================================================
function renderTable() {
  const thead = $('dataTable').querySelector('thead');
  const tbody = $('dataTable').querySelector('tbody');
  if (!DS.rows.length) { thead.innerHTML = ''; tbody.innerHTML = '<tr><td>データなし</td></tr>'; $('rowRange').textContent = '—'; return; }

  thead.innerHTML = '<tr><th>#</th>' + DS.columns.map(c =>
    `<th>${c.name}<span class="type">${c.type}${c.dim ? `[${c.dim}]` : ''}</span></th>`).join('') + '</tr>';

  const start = DS.page * DS.pageSize;
  const end = Math.min(start + DS.pageSize, DS.rows.length);
  const frag = [];
  for (let i = start; i < end; i++) {
    const r = DS.rows[i];
    const cells = DS.columns.map(c => {
      const v = r[c.name];
      if (isArrayLike(v)) {
        const preview = Array.from(v).slice(0, 4).map(fmtNum).join(', ');
        const more = v.length > 4 ? ` …(${v.length})` : '';
        return `<td class="arr" data-full="${escapeAttr(Array.from(v).map(fmtNum).join(', '))}">[${preview}${more}]</td>`;
      }
      if (typeof v === 'number' || typeof v === 'bigint') return `<td class="num">${fmtNum(Number(v))}</td>`;
      if (v && typeof v === 'object') return `<td class="arr" data-full="${escapeAttr(JSON.stringify(v))}">{…}</td>`;
      return `<td>${v == null ? '<span style="color:var(--ink-faint)">null</span>' : escapeHtml(String(v))}</td>`;
    }).join('');
    frag.push(`<tr data-row="${i}" class="${DS.selectedRow === i ? 'selected' : ''}"><td class="idx">${i}</td>${cells}</tr>`);
  }
  tbody.innerHTML = frag.join('');
  $('rowRange').textContent = `${start + 1}–${end} / ${DS.rows.length} 行`;

  // array cell tooltip
  tbody.querySelectorAll('td.arr').forEach(td => {
    td.addEventListener('mouseenter', (e) => showTooltip(e, td.dataset.full));
    td.addEventListener('mousemove', moveTooltip);
    td.addEventListener('mouseleave', hideTooltip);
  });
  tbody.querySelectorAll('tr[data-row]').forEach(tr => {
    tr.addEventListener('click', () => { DS.selectedRow = parseInt(tr.dataset.row, 10); seekToFrame(DS.selectedRow); renderTable(); });
  });
}

// ============================================================
//  Rendering: schema
// ============================================================
function renderSchema() {
  const tbody = $('schemaTable').querySelector('tbody');
  if (!DS.columns.length) { tbody.innerHTML = '<tr><td colspan="4">データなし</td></tr>'; return; }
  tbody.innerHTML = DS.columns.map(c => {
    let sample = c.sample;
    if (isArrayLike(sample)) sample = '[' + Array.from(sample).slice(0, 3).map(fmtNum).join(', ') + (sample.length > 3 ? ', …' : '') + ']';
    else if (sample && typeof sample === 'object') sample = JSON.stringify(sample).slice(0, 60);
    else sample = String(sample);
    const featDim = DS.info?.features?.[c.name]?.shape;
    const dimStr = featDim ? JSON.stringify(featDim) : (c.dim != null ? `(${c.dim},)` : '—');
    return `<tr><td class="name">${c.name}</td><td class="type">${c.type}</td><td class="dim">${dimStr}</td><td style="color:var(--ink-dim);font-family:var(--mono);font-size:12px">${escapeHtml(sample)}</td></tr>`;
  }).join('');
}

// ============================================================
//  Rendering: plot
// ============================================================
function getSeries() {
  // Expand selected columns into individual numeric series.
  const series = [];
  let colorIdx = 0;
  for (const colName of DS.plotCols) {
    const col = DS.columns.find(c => c.name === colName);
    if (!col) continue;
    if (col.isArray) {
      const dim = col.dim || (DS.rows[0]?.[colName]?.length ?? 0);
      for (let d = 0; d < dim; d++) {
        series.push({
          label: `${shortName(colName)}[${d}]`,
          color: `var(--series-${colorIdx % 7})`,
          values: DS.rows.map(r => { const a = r[colName]; return a ? Number(a[d]) : NaN; }),
        });
        colorIdx++;
      }
    } else {
      series.push({
        label: shortName(colName),
        color: `var(--series-${colorIdx % 7})`,
        values: DS.rows.map(r => Number(r[colName])),
      });
      colorIdx++;
    }
  }
  return series;
}

function renderPlotChips() {
  const wrap = $('plotChips');
  const plottable = DS.columns.filter(c => c.type === 'number' || c.type === 'array<number>');
  if (!plottable.length) { wrap.innerHTML = '<span style="color:var(--ink-faint)">プロット可能な数値列がありません</span>'; return; }
  let colorIdx = 0;
  wrap.innerHTML = plottable.map(c => {
    const on = DS.plotCols.has(c.name);
    const col = on ? `var(--series-${colorIdx % 7})` : 'transparent';
    const chip = `<span class="chip ${on ? 'on' : ''}" data-col="${c.name}" style="${on ? `background:${col};border-color:${col}` : ''}">${shortName(c.name)}${c.dim ? `·${c.dim}` : ''}</span>`;
    if (on) colorIdx++;
    return chip;
  }).join('');
  wrap.querySelectorAll('.chip').forEach(ch => {
    ch.addEventListener('click', () => {
      const col = ch.dataset.col;
      if (DS.plotCols.has(col)) DS.plotCols.delete(col); else DS.plotCols.add(col);
      renderPlotChips(); renderPlot();
    });
  });
}

function renderPlot() {
  const svg = $('plotSvg');
  const W = 900, H = 360, padL = 48, padR = 16, padT = 14, padB = 26;
  const series = getSeries();
  const n = DS.rows.length;
  if (!series.length || !n) {
    svg.innerHTML = `<text x="${W/2}" y="${H/2}" text-anchor="middle">系列を選択してください</text>`;
    $('plotLegend').innerHTML = ''; return;
  }
  // y-range
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) for (const v of s.values) { if (Number.isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; } }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.06; yMin -= pad; yMax += pad;

  const xOf = (i) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const yOf = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);

  let svgContent = '';
  // grid + y axis labels
  const yticks = 5;
  svgContent += '<g class="grid">';
  for (let t = 0; t <= yticks; t++) {
    const yv = yMin + (t / yticks) * (yMax - yMin);
    const yp = yOf(yv);
    svgContent += `<line x1="${padL}" y1="${yp}" x2="${W-padR}" y2="${yp}"/>`;
  }
  svgContent += '</g><g class="axis">';
  for (let t = 0; t <= yticks; t++) {
    const yv = yMin + (t / yticks) * (yMax - yMin);
    const yp = yOf(yv);
    svgContent += `<text x="${padL-6}" y="${yp+3}" text-anchor="end">${fmtNum(yv)}</text>`;
  }
  // x axis labels (frames)
  const xticks = 6;
  for (let t = 0; t <= xticks; t++) {
    const xi = Math.round((t / xticks) * (n - 1));
    svgContent += `<text x="${xOf(xi)}" y="${H-8}" text-anchor="middle">${xi}</text>`;
  }
  svgContent += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H-padB}"/><line x1="${padL}" y1="${H-padB}" x2="${W-padR}" y2="${H-padB}"/></g>`;

  // series paths (decimate if huge)
  const step = Math.max(1, Math.floor(n / 1600));
  for (const s of series) {
    let d = '';
    for (let i = 0; i < n; i += step) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      d += (d ? 'L' : 'M') + xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1);
    }
    svgContent += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.2" opacity="0.9"/>`;
  }

  // cursor (current frame)
  const cf = currentFrame();
  if (cf != null && cf >= 0 && cf < n) {
    svgContent += `<line class="cursor" x1="${xOf(cf)}" y1="${padT}" x2="${xOf(cf)}" y2="${H-padB}"/>`;
  }
  // hover crosshair (invisible until mousemove)
  svgContent += `<line id="plotHover" x1="0" y1="${padT}" x2="0" y2="${H-padB}" stroke="var(--ink-faint)" stroke-width="1" stroke-dasharray="3,3" opacity="0" pointer-events="none"/>`;
  svg.innerHTML = svgContent;

  // click to seek
  svg.onclick = (e) => {
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * W;
    const frac = (x - padL) / (W - padL - padR);
    const frame = Math.round(frac * (n - 1));
    if (frame >= 0 && frame < n) seekToFrame(frame);
  };

  // hover: show crosshair + tooltip with frame values
  svg.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * W;
    const frac = (x - padL) / (W - padL - padR);
    const frame = Math.round(frac * (n - 1));
    const hoverLine = $('plotHover');
    if (frame < 0 || frame >= n || !hoverLine) { hideTooltip(); if (hoverLine) hoverLine.setAttribute('opacity', '0'); return; }
    const lx = xOf(frame).toFixed(1);
    hoverLine.setAttribute('x1', lx);
    hoverLine.setAttribute('x2', lx);
    hoverLine.setAttribute('opacity', '1');
    const lines = [`frame ${frame}`].concat(series.map(s => {
      const v = s.values[frame];
      return `${s.label}: ${Number.isFinite(v) ? fmtNum(v) : '—'}`;
    }));
    showTooltip(e, lines.join('\n'));
  };
  svg.onmouseleave = () => {
    hideTooltip();
    const hoverLine = $('plotHover');
    if (hoverLine) hoverLine.setAttribute('opacity', '0');
  };

  // legend
  $('plotLegend').innerHTML = series.map(s =>
    `<span class="item"><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`).join('');
}

// ============================================================
//  Rendering: video + sync
// ============================================================
let videos = [];
let playing = false;
let rafId = null;

function renderVideo() {
  const grid = $('videoGrid');
  videos = [];
  if (!DS.cameras.length) {
    $('videoEmpty').classList.remove('hidden');
    $('videoTransport').style.opacity = '0.4';
    grid.innerHTML = '';
    return;
  }
  $('videoEmpty').classList.add('hidden');
  $('videoTransport').style.opacity = '1';
  grid.innerHTML = DS.cameras.map((c, i) => `
    <div class="video-card">
      <div class="cam-label"><span>${shortName(c.key)}</span><span style="color:var(--ink-faint)">${c.file.name}</span></div>
      <video id="vid${i}" preload="metadata" playsinline muted></video>
    </div>`).join('');

  DS.cameras.forEach((c, i) => {
    const v = $('vid' + i);
    v.src = URL.createObjectURL(c.file);
    videos.push(v);
    if (i === 0) {
      v.addEventListener('loadedmetadata', () => { updateScrubMax(); });
      v.addEventListener('timeupdate', () => { if (!playing) syncFromVideo(); });
    }
  });
}

function updateScrubMax() {
  const n = DS.rows.length || 1;
  $('vScrub').max = String(n - 1);
}
function currentFrame() {
  if (videos.length && videos[0].duration) {
    return Math.min(DS.rows.length - 1, Math.floor(videos[0].currentTime * DS.fps));
  }
  return DS.selectedRow ?? 0;
}
function seekToFrame(frame) {
  DS.selectedRow = frame;
  $('vScrub').value = String(frame);
  $('vReadout').textContent = `frame ${frame} / ${Math.max(0, DS.rows.length - 1)}`;
  const t = frame / DS.fps;
  for (const v of videos) { if (v.duration) try { v.currentTime = t; } catch {} }
  renderPlot();
  // reflect selection in table if visible
  if (!$('tab-table').classList.contains('hidden')) renderTable();
}
function syncFromVideo() {
  const f = currentFrame();
  $('vScrub').value = String(f);
  $('vReadout').textContent = `frame ${f} / ${Math.max(0, DS.rows.length - 1)}`;
  DS.selectedRow = f;
  renderPlot();
}
function playLoop() {
  if (!playing) return;
  syncFromVideo();
  rafId = requestAnimationFrame(playLoop);
}
function togglePlay() {
  playing = !playing;
  $('vPlay').textContent = playing ? '⏸ 停止' : '▶ 再生';
  if (playing) { for (const v of videos) v.play().catch(() => {}); playLoop(); }
  else { for (const v of videos) v.pause(); cancelAnimationFrame(rafId); syncFromVideo(); }
}

$('vPlay').addEventListener('click', togglePlay);
$('vScrub').addEventListener('input', (e) => { if (playing) togglePlay(); seekToFrame(parseInt(e.target.value, 10)); });

// ============================================================
//  Tooltip
// ============================================================
function showTooltip(e, text) { const t = $('tooltip'); t.textContent = text; t.classList.remove('hidden'); moveTooltip(e); }
function moveTooltip(e) {
  const t = $('tooltip');
  let x = e.clientX + 14, y = e.clientY + 14;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = e.clientX - r.width - 14;
  if (y + r.height > window.innerHeight) y = e.clientY - r.height - 14;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
function hideTooltip() { $('tooltip').classList.add('hidden'); }

// ============================================================
//  Tabs
// ============================================================
let activeTab = 'table';
function renderActiveTab() {
  if (activeTab === 'table') renderTable();
  else if (activeTab === 'plot') { renderPlotChips(); renderPlot(); }
  else if (activeTab === 'video') renderVideo();
  else if (activeTab === 'schema') renderSchema();
}
$('tabs').querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    $('tabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    ['table', 'plot', 'video', 'schema'].forEach(name => {
      $('tab-' + name).classList.toggle('hidden', name !== activeTab);
    });
    $('emptyState').classList.add('hidden');
    renderActiveTab();
  });
});

// ============================================================
//  Pagination
// ============================================================
$('pagePrev').addEventListener('click', () => { if (DS.page > 0) { DS.page--; renderTable(); } });
$('pageNext').addEventListener('click', () => {
  if ((DS.page + 1) * DS.pageSize < DS.rows.length) { DS.page++; renderTable(); }
});
$('pageSize').addEventListener('change', (e) => { DS.pageSize = parseInt(e.target.value, 10); DS.page = 0; renderTable(); });

// ============================================================
//  Folder input + drag/drop
// ============================================================
function showWorkspace() {
  $('emptyState').classList.add('hidden');
  $('tab-' + activeTab).classList.remove('hidden');
}
async function handleFiles(fileList) {
  if (!fileList || !fileList.length) return;
  if (!parquetModule) { try { await loadLibs(); } catch { return; } }
  showWorkspace();
  await loadDataset(fileList);
}
$('folderInput').addEventListener('change', (e) => handleFiles(e.target.files));
$('folderInput2').addEventListener('change', (e) => handleFiles(e.target.files));

const dropCard = $('dropCard');
['dragenter', 'dragover'].forEach(ev => dropCard.addEventListener(ev, (e) => { e.preventDefault(); dropCard.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dropCard.addEventListener(ev, (e) => { e.preventDefault(); dropCard.classList.remove('drag'); }));
dropCard.addEventListener('drop', async (e) => {
  e.preventDefault();
  const items = e.dataTransfer.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const files = [];
    const roots = [];
    for (const it of items) { const en = it.webkitGetAsEntry(); if (en) roots.push(en); }
    showLoading('フォルダを走査中…');
    for (const root of roots) await walkEntry(root, files);
    hideLoading();
    // synthesize webkitRelativePath
    handleFiles(files);
  } else {
    handleFiles(e.dataTransfer.files);
  }
});

// Recursively read a dropped directory entry into File objects with relative paths.
async function walkEntry(entry, out, prefix = '') {
  if (entry.isFile) {
    await new Promise((res) => entry.file((f) => {
      try { Object.defineProperty(f, 'webkitRelativePath', { value: prefix + entry.name, configurable: true }); } catch {}
      out.push(f); res();
    }, () => res()));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    await new Promise((res) => {
      const readBatch = () => reader.readEntries(async (ents) => {
        if (!ents.length) { res(); return; }
        for (const e of ents) await walkEntry(e, out, prefix + entry.name + '/');
        readBatch();
      }, () => res());
      readBatch();
    });
  }
}

// ============================================================
//  Boot
// ============================================================
setStatus('', 'フォルダ未選択');
$('statusLib').textContent = 'hyparquet 未読込（フォルダ選択時に読み込み）';
