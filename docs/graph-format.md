# 探索グラフの形式と出典

配信ファイルは `public/graph/manifest.json` の `file` に示すgzipファイルです。`archiveSha256` はgzipファイル、`sha256` は展開後のバイト列のハッシュです。`coverage` は経路の始終点を指定できる矩形、`graphBounds` は余白を含むデータ矩形です。版と元データのハッシュもマニフェストに記録します。

展開後の形式はバージョン2です。最初の12バイトには符号なし32ビット整数をリトルエンディアンで3個格納します。順に形式バージョン、ノード数、有向エッジ数です。

1. 各ノードの経度・緯度を100万倍した整数を格納します。直前のノードとの差分として格納し、先頭の基準は0です。符号付き差分は非負を `2n`、負を `-2n-1` として非負整数に変換します。
2. 各ノードの出次数を格納し、その直後に有向エッジを格納します。エッジの値は「隣接先と自身のIDの差を上記規則で変換した値 × 重みの種類数 ＋ 重みの番号」です。ノードIDは座標表における0始まりの位置を使います。
3. ヘッダー以外の整数は7ビットずつ下位から格納します。最上位ビットは後続バイトの有無を表します。ブラウザで展開するときに、座標から計算した距離に重みを乗じてエッジのコストを作ります。

探索グラフの出典は © OpenStreetMap contributors です。グラフはOpen Data Commons Open Database License 1.0で提供されます。配信ファイルをダウンロードすると、形式仕様に従って機械的に読み取れます。 [OSMの著作権とライセンス](https://www.openstreetmap.org/copyright) · [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) · [OSM Franceの元データ](https://download.openstreetmap.fr/extracts/asia/japan/)

背景地図の出典は地理院タイル（国土地理院）です。地理院タイルは探索グラフに含まれません。 [地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)
