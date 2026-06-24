// test/core.test.mjs — unit tests for core.js logic.
// Run with:  node test/core.test.mjs   (zero dependencies)
import {
  isArrayLike, fmtNum, pick, detectVersion, filterByEpisode,
  analyzeColumns, resolveVideoPath, inferCameraKeys, cameraKeysFromInfo,
} from '../src/core.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log('  FAIL', name, '\n    got ', g, '\n    want', w); }
}

console.log('# version detection');
eq('v2 classic', detectVersion([
  'meta/info.json', 'data/chunk-000/episode_000000.parquet', 'data/chunk-000/episode_000001.parquet',
  'videos/chunk-000/observation.images.cam_high/episode_000000.mp4',
]), 'v2');
eq('v3 file-based', detectVersion([
  'meta/info.json', 'meta/episodes/chunk-000/file-000.parquet', 'data/chunk-000/file-000.parquet',
  'videos/observation.images.cam_high/chunk-000/file-000.mp4',
]), 'v3');
eq('v3 no epmeta but file- pattern', detectVersion([
  'data/chunk-000/file-000.parquet', 'data/chunk-000/file-001.parquet',
]), 'v3');
eq('v2 even with data/ prefix', detectVersion([
  'data/chunk-000/episode_000012.parquet',
]), 'v2');

console.log('# column analysis');
const rows1 = [{
  'observation.state': new Float32Array([1, 2, 3, 4, 5, 6, 7]),
  'action': [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  'timestamp': 0.0, 'episode_index': 0, 'frame_index': 0, 'task': 'pick cube',
}];
const { columns, plotCols } = analyzeColumns(rows1, {});
eq('state is array<number>', columns.find(c => c.name === 'observation.state').type, 'array<number>');
eq('state dim 7', columns.find(c => c.name === 'observation.state').dim, 7);
eq('action dim 6', columns.find(c => c.name === 'action').dim, 6);
eq('timestamp number', columns.find(c => c.name === 'timestamp').type, 'number');
eq('task string', columns.find(c => c.name === 'task').type, 'string');
eq('default plot = state+action', [...plotCols].sort(), ['action', 'observation.state']);

console.log('# fallback plot selection (no state/action)');
const rows2 = [{ joint_a: 1.0, joint_b: 2.0, frame_index: 0, timestamp: 0 }];
const r2 = analyzeColumns(rows2, {});
eq('fallback picks numeric non-index cols', [...r2.plotCols].sort(), ['joint_a', 'joint_b']);

console.log('# camera resolution v2');
const v2paths = [
  'videos/chunk-000/observation.images.cam_high/episode_000000.mp4',
  'videos/chunk-000/observation.images.cam_high/episode_000001.mp4',
  'videos/chunk-000/observation.images.cam_low/episode_000000.mp4',
];
eq('v2 ep0 cam_high', resolveVideoPath(v2paths, 'observation.images.cam_high', { index: 0 }),
  'videos/chunk-000/observation.images.cam_high/episode_000000.mp4');
eq('v2 ep1 cam_high', resolveVideoPath(v2paths, 'observation.images.cam_high', { index: 1 }),
  'videos/chunk-000/observation.images.cam_high/episode_000001.mp4');

console.log('# camera resolution v3');
const v3paths = [
  'videos/observation.images.cam_high/chunk-000/file-000.mp4',
  'videos/observation.images.cam_high/chunk-000/file-001.mp4',
  'videos/observation.images.cam_wrist/chunk-000/file-000.mp4',
];
eq('v3 chunk0 file1 cam_high',
  resolveVideoPath(v3paths, 'observation.images.cam_high', { index: 5, chunkIdx: 0, fileIdx: 1 }),
  'videos/observation.images.cam_high/chunk-000/file-001.mp4');
eq('v3 fallback first mp4',
  resolveVideoPath(v3paths, 'observation.images.cam_wrist', { index: 99 }),
  'videos/observation.images.cam_wrist/chunk-000/file-000.mp4');

console.log('# camera key discovery');
eq('keys from info.features',
  cameraKeysFromInfo({ features: { 'observation.images.cam_high': { dtype: 'video' }, 'action': { dtype: 'float32' } } }),
  ['observation.images.cam_high']);
eq('infer keys from v3 paths', inferCameraKeys(v3paths).sort(),
  ['observation.images.cam_high', 'observation.images.cam_wrist']);
eq('infer keys from v2 paths', inferCameraKeys(v2paths).sort(),
  ['observation.images.cam_high', 'observation.images.cam_low']);

console.log('# pick() field probing');
eq('pick episode_index bigint->num', pick({ episode_index: 3n }, ['episode_index', 'index']), 3);
eq('pick fallback key', pick({ to_index: 100 }, ['dataset_to_index', 'to_index']), 100);
eq('pick none present', pick({ x: 1 }, ['a', 'b']), null);

console.log('# misc helpers');
eq('fmtNum int', fmtNum(5), '5');
eq('fmtNum float trim', fmtNum(1.2500), '1.25');
eq('isArrayLike float32', isArrayLike(new Float32Array([1])), true);
eq('isArrayLike string false', isArrayLike('abc'), false);

console.log('# filterByEpisode');
eq('filter by episode_index',
  filterByEpisode([{ episode_index: 0, v: 1 }, { episode_index: 1, v: 2 }, { episode_index: 1, v: 3 }], 1),
  [{ episode_index: 1, v: 2 }, { episode_index: 1, v: 3 }]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
