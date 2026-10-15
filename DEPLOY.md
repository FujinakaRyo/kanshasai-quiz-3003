# クラウド展開手順（Render）

dev tunnels のポート制限（1500件/分）では 450人の同時参加に対応できません。Render を使ってクラウドにデプロイします。

## 準備
- Render のアカウント：https://render.com （GitHub ログインで作成可能）
- リポジトリまたはデプロイ用イメージ

## 手順

### 1. Render にログイン
https://dashboard.render.com にアクセスします。

### 2. 新しい Web Service を作成
- 「New」→「Web Service」をクリック
- リポジトリ接続方法を選択：
  - **方法A（推奨）：** GitHub リポジトリにこのフォルダを push し、Render でリポジトリから直接デプロイ
  - **方法B：** 以下の Docker イメージ URL を使用：
    ```
    ghcr.io/（GitHubユーザー名）/kanshasai-quiz:latest
    ```

### 3. サービス設定

| 項目 | 値 |
|---|---|
| **Name** | `kanshasai-quiz` など わかりやすい名前 |
| **Region** | 東京（Tokyo） |
| **Runtime** | Docker または Node（方法A の場合） |
| **Build Command** | `npm install`（Node の場合、このアプリでは不要） |
| **Start Command** | `node server.js`（または Docker なら不指定） |

### 4. 環境変数（デフォルトでOK）
設定しない場合、ポート `3000` で起動します。Render が自動的にポート割り当てします。

### 5. プラン選択
- **当日限定プラン**（推奨）：
  - テストまで：無料プラン（アイドル中に停止）
  - 本番当日：Pro プラン（$7/月）に変更
  - 翌日：無料に戻すか削除
- または 月額$2-7のスタンダードプラン で常時稼働

### 6. デプロイ実行
「Create Web Service」をクリック。デプロイが開始され、3-5分で完了します。

## 公開 URL
デプロイ完了後、Render ダッシュボードに表示される URL（例：`https://kanshasai-quiz.onrender.com`）がこのアプリの公開 URL です。

参加者はこの URL をスマホで開きます。

## 状態確認

### 動作確認
ブラウザで以下にアクセス：
- 参加者画面：`https://kanshasai-quiz.onrender.com/`
- 管理者画面：`https://kanshasai-quiz.onrender.com/admin`
- 投影画面：`https://kanshasai-quiz.onrender.com/present`

### ログ確認
Render ダッシュボード →「Logs」タブで、サーバーログをリアルタイム監視できます。

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| 「Free instance が休止状態」と表示される | 無料プランで 15 分以上アクセスがない | Pro プランに変更、または「Resume」ボタンをクリック |
| 参加者が繋がらない | 設定不足 | `DEPLOY.md` の手順を確認 |
| 画像が表示されない | アップロード済み画像がない | 以前のセッションから `uploads/` フォルダの内容を事前にコピー |

## 当日の流れ

1. **当日午前**：Render のプランを無料 → Pro に変更
2. **本番開始**：管理画面から開始
3. **本番終了**：プランを無料に戻すか、Web Service を削除

## 注意点
- Render は無料プランで 15 分のアイドルで一時停止します。本番直前は 1 回アクセスして、復帰させておいてください。
- データ（参加者、得点）はサーバーのメモリに保持されます。Render で再デプロイするとリセットされます。本番当日は再デプロイしないでください。
- 進行状態は `kanshasai-quiz-3003.state.json` に自動保存されますが、Render の無料プランではファイルシステムが永続化されないため、状態復元は 1 回のセッション内だけ有効です。
