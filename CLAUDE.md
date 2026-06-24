# CLAUDE.md

LeRobot データセット（Parquet + MP4）を **ブラウザだけ** で閲覧するローカルビューワー。
このファイルは Claude Code が本リポジトリで作業する際の前提と規約を定義する。

## このプロジェクトの絶対要件（壊さないこと）

1. **配布物は単一 HTML。** `dist/lerobot-viewer.html` はブラウザで開くだけで動くこと。
2. **ランタイムは npm 非依存。** 利用者側で `npm install` を要求しない。実行時依存は hyparquet（CDN またはローカル `lib/`）のみ。
3. **追加ソフトのインストールほぼ不要。** Python / サーバ / ビルドツールを利用者に強制しない。
4. **Windows / Ubuntu 両対応。** ブラウザ（Chrome/Edge/Firefox）で動けばよい。
5. **データは外部送信しない。** すべてブラウザ内で処理する。解析・テレメトリ送信を足さない。

新機能を足すときも、この5点を破る変更（バンドラ導入、サーバ常駐前提、外部 API 送信など）はしない。
どうしても必要なら、まず Issue で相談する形にする。

## 開発フロー

ソースは `src/` で分割管理し、`scripts/build.js` で単一 HTML に結合する。

```
src/index.html   画面の構造（外部 CSS/JS を参照）
src/styles.css   スタイル
src/app.js       DOM・状態・描画（ブラウザ専用、core.js を import）
src/core.js      純ロジック（DOM 非依存・テスト対象）
```

- **ビルド:** `node scripts/build.js` → `dist/lerobot-viewer.html` を生成（依存ゼロ）
- **テスト:** `node test/core.test.mjs`（依存ゼロ）
- **開発中の表示確認:** `src/index.html` を直接ブラウザで開く（分割のまま動く）

`package.json` のスクリプトも使える: `npm run build` / `npm test`。
ただし devDependencies は持たない方針なので `npm install` は不要。

## コードを変更したら必ず

1. `node test/core.test.mjs` が全件パスすること
2. `node scripts/build.js` が成功し、`dist/lerobot-viewer.html` の `<script>` 内が
   構文エラーなしであること（CI でも検証）
3. ロジックを足したら `src/core.js` に置き、`test/core.test.mjs` にテストを追加する

純粋な判定・変換ロジック（バージョン検出、列解析、パス解決、フォーマット）は
**必ず `core.js`** に書く。DOM を触る描画・イベントは `app.js`。この分離を保つこと。

## ビルドの注意（既知の落とし穴）

`scripts/build.js` の `String.replace` は置換“文字列”内の `$&` や `\` を特殊解釈する。
インライン化はすべて **置換関数（`() => ...`）** で渡している。文字列を直接渡すと
正規表現リテラル中の `\\.` や `$` が壊れる。ここは変更しないこと。

## LeRobot 形式の前提

- 画像は Parquet に入らない。カメラ映像は MP4、Parquet はフレーム参照のみ。
- v2: `data/chunk-xxx/episode_NNNNNN.parquet`（1エピソード1ファイル）
- v3: `data/chunk-xxx/file-NNN.parquet`（複数エピソード1ファイル）+ `meta/episodes/**.parquet` で境界解決
- v3 のエピソードメタは lerobot バージョンで列名が揺れる。`core.js` の `pick()` で候補名を広く探索している。
  新しい列名パターンに出会ったら候補を増やし、テストを足す。

## やらないこと

- バンドラ（webpack/vite/esbuild 等）やトランスパイラの導入
- ランタイムでの外部 API 呼び出し（CDN からのライブラリ取得を除く）
- 利用者にサーバ起動や Python 実行を要求する設計
