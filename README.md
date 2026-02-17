# LP 売上フェルミ博士（Browser Game）

URL・業種・平均決済額・広告費を入力すると、

- **LP偏差値（スマホUI/UX）**：45項目×1〜5点 → 偏差値(20〜80)
- **フェルミ推定の売上**：広告費 → クリック → 成約 → 売上

を **ブラウザ上で**計算し、プロセスをリアルタイムにログ表示します。  
（博士キャラクターが計算ロジックを分かりやすく解説します）

---

## 公開（Cloudflare Pages / GitHub）

### 1) GitHub に置く
このリポジトリ直下に以下がある状態にします：

```
index.html
styles.css
app.js
_routes.json
functions/proxy.js
```

### 2) Cloudflare Pages に接続してデプロイ
Cloudflare Pages で以下の設定で作成します：

- **Framework preset**: None / No framework
- **Build command**: `exit 0`
- **Build output directory**: `.`

デプロイ後、 `https://xxxxx.pages.dev` のURLが発行されます。

### 3) /proxy が生きているか確認（重要）
デプロイ後、以下にアクセスして HTML が返るか確認してください：

```
https://xxxxx.pages.dev/proxy?url=https%3A%2F%2Fexample.com
```

---

## ローカルで試す

### 1) 静的サーバーで起動（推奨）
`file://` 直開きだと環境によってJSが動かないことがあります。ローカルサーバー推奨。

```bash
python -m http.server 8080
```

```
http://localhost:8080
```

※ ローカルだけで /proxy を使いたい場合は、Cloudflare Pages 上での動作確認をおすすめします。

---

## 仕組み（ざっくり）

### LP偏差値（20〜80）
- 45項目を **各1〜5点**で採点（合計最大225点）
- 偏差値 = `20 + 60 * (合計点 / 225)`

※ 取得制限でHTMLが取れないLPは、暫定で偏差値50扱いで計算します（ゲームが止まらないため）。

### 売上フェルミ推定
ベースは次の流れです：

1. CPC（業種別の目安）からクリック数を推定  
   `クリック数 = 広告費 ÷ CPC`
2. 業種別の成約率（CVR）を、LP偏差値で補正  
   `成約率 = 業種CVR × 偏差値補正`
3. `成約数 = クリック数 × 成約率`
4. `売上 = 成約数 × 平均決済額`

---

## 注意（重要）
- 本ツールは **フェルミ推定**です。正確な予測ではなく「当たりをつける」目的です。
- 相手サイトのWAF/ボット対策により、HTML取得がブロックされることがあります。
- `/proxy` は公開すると悪用される可能性があるため、必要に応じて Cloudflare 側で **Rate Limit** を設定してください。

---

## License
社内利用想定（必要なら追記してください）
