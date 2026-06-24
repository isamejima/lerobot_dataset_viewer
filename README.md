# LeRobot Dataset Viewer

LeRobot データセット（Parquet + MP4）を **ブラウザだけ** で閲覧するローカルビューワー。
配布物は単一の `dist/lerobot-viewer.html`。サーバ・npm・Python なしで、ブラウザで開けば動きます。

## 使う

`dist/lerobot-viewer.html` をブラウザ（Chrome / Edge 推奨）で開き、データセットの
**ルートフォルダ**を選択（またはドラッグ＆ドロップ）するだけ。

- **v2 / v3 両対応** — 形式を自動判別
- **テーブル** — 行ページング、配列セルはホバーで全要素表示
- **グラフ** — `observation.state` / `action` などを時系列プロット（配列は次元ごとに系列展開）
- **動画** — 対応 MP4 を再生（複数カメラ同時）。スクラブ・グラフクリック・行クリックでフレーム同期
- **スキーマ** — 列名・型・shape・サンプル一覧

すべてブラウザ内で完結し、データは外部に送信されません。

### オフライン / 閉域環境

既定では Parquet パーサ（hyparquet）を CDN から読み込みます。ネットに出られない環境では、
以下2ファイルを `dist/` の隣に `lib/` を作って置けば CDN 不要になります。

- `lib/hyparquet.min.js` … `https://cdn.jsdelivr.net/npm/hyparquet/src/hyparquet.min.js`
- `lib/hyparquet-compressors.min.js` … `https://cdn.jsdelivr.net/npm/hyparquet-compressors/src/hyparquet-compressors.min.js`

`hyparquet-compressors` は zstd / gzip / brotli 圧縮の Parquet 用。snappy・非圧縮のみなら不要です。

## 開発する

ソースは `src/` で分割し、`scripts/build.js` で単一 HTML に結合します。**ビルドもテストも依存ゼロ**で、
`npm install` は不要です（Node があれば動く）。

```
src/index.html   画面の構造（開発時は外部 CSS/JS を参照）
src/styles.css   スタイル
src/app.js       DOM・状態・描画（core.js を import）
src/core.js      純ロジック（DOM 非依存・テスト対象）
scripts/build.js src/ を dist/lerobot-viewer.html に結合
test/core.test.mjs  core.js のユニットテスト
```

```bash
node test/core.test.mjs    # テスト（または npm test）
node scripts/build.js      # ビルド（または npm run build）
```

開発中は `src/index.html` を直接ブラウザで開けば分割のまま動きます。
仕上げに `node scripts/build.js` で配布物を更新してください。

新しいロジックは `src/core.js` に置き、`test/core.test.mjs` にテストを足す方針です。
詳しい規約は [`CLAUDE.md`](./CLAUDE.md) を参照。

## 既知の制約

- 画像は Parquet に入っていません（LeRobot はカメラ画像を MP4 に格納）。本ビューワーは数値・状態・
  アクション列を表示し、映像は MP4 タブで再生します。
- v3 のエピソード境界は `meta/episodes/**.parquet` から解決します。列名は lerobot の
  バージョンで揺れるため候補名を広く探索しており、想定外スキーマでは `episode_index` 列での
  フィルタにフォールバックします。
- `file://` 直開きは hyparquet（純 JS）のため基本動作しますが、ブラウザによっては ES module の
  動的 import に制限が出ることがあります。その場合は任意の静的ホスティング経由で開いてください。
- 巨大ファイルは選択エピソード分をメモリに展開します。

## ライセンス

MIT
