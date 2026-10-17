# 開発エージェント向けガイド

## プロジェクト

LINEグループでポーカーの幹事の輪番通知、開催日登録、リマインドを行うBot。
点数管理は外部の専用アプリに移行済み。当日朝は別メッセージで入力リンクを案内する。
従来のBot側の点数記録・ランキング機能は残っているが、専用アプリとの自動同期はない。
日程調整自体は人がLINE上で行う。利用者向けの説明は `README.md` を参照する。
回答、コメント、利用者向けメッセージは既存の日本語に合わせる。

## 構成

- `functions/index.js`: 全アプリ実装。CommonJS形式のJavaScript。
  - `webhook`: LINE署名検証、イベント受付、`@poker` コマンド処理。
  - `announceOrganizer`: 毎月20日10時に幹事を通知し、輪番を進める。
  - `remind`: 毎日9時に開催日の3日前・前日・当日かを判定して通知する。
    当日のみ入力リンクを「点数入力はこちら」と別のtextメッセージで送る。
- `functions/reminder.js`: 通知対象日の判定とメッセージの作成。`SCORE_ENTRY_URL` はここで管理する。
- `functions/test/reminder.test.js`: 外部通信しないNode.js標準のテスト。
- `functions/package.json`: Node.js 22指定、LINE SDK、Firebase Admin/Functionsの依存関係。
- `.github/workflows/ci-cd.yml`: PRとmasterのCI、CI成功後のmasterの自動デプロイ。
- `docs/ci-cd.md`: CI/CDの解説と初期設定・運用手順。
- `firebase.json`: FunctionsとFirestoreの設定。
- `firestore.rules`: クライアントの直接読み書きは禁止。FunctionsからAdmin SDKでアクセスする。
- `firestore.indexes.json`: Firestoreインデックス定義。
- `.firebaserc`: Firebaseプロジェクトの対応設定。

独立したフロントエンド、LIFF実装、Notion連携コードは現在存在しない。

## 維持する仕様

- リージョンは `asia-northeast1`、日付とスケジュールは `Asia/Tokyo` 基準。
- `@poker 1000` は送信者の当日の点数を記録する。同日・同名の再入力は上書き。
- `@poker 結果 8/8 太郎 500 花子 300` は代理・過去分の入力用。
- 成績は `games/{YYYY-MM-DD}_{名前}` に保存し、名前の `/` は `_` に置換する。
- ランキングは `games` 全件の点数から算出する。
- `config/group` は通知先グループ、`config/organizers` は輪番、
  `config/members` は名前とLINE userIdの対応、`config/nextEvent` は次の開催日。
  現在はグループごとのデータ分離を行っていない。
- 開催日の `M/D` は今日以降の直近の日付、結果の `M/D` は今年の日付として解釈する。

## 開発・確認

リポジトリのルートから実行する。

```powershell
# lockfileどおりに依存関係をインストール
npm ci --prefix functions

# 外部サービスに接続せず構文確認
npm run check --prefix functions
npm test --prefix functions

# Firebase設定JSONの構文確認
node -e 'const fs = require("fs"); for (const p of ["functions/package.json", "firebase.json", "firestore.indexes.json", ".firebaserc"]) { JSON.parse(fs.readFileSync(p, "utf8")); console.log(p + " OK"); }'
```

自動テストは `npm test --prefix functions`、構文確認は `npm run check --prefix functions`。
lint、buildのスクリプトやEmulator設定はない。
構文確認だけではLINE/Firebaseの動作確認にはならない。変更した処理の検証方法と、
実施できなかった確認を報告する。コマンドや仕様を変更したら `README.md` も更新する。

## 認証情報・運用

- `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_CHANNEL_SECRET` はFirebase Secret Managerで管理する。
  値をソース、ドキュメント、ログに記載しない。
- Webhookの `req.rawBody` によるLINE署名検証を維持する。
- デプロイ、実グループへの送信、本番Firestoreの更新は実環境に影響する操作として扱う。
  ローカル検証の代わりに実行せず、ユーザーの依頼範囲内で行う。
- 本番デプロイは原則としてActions経由。masterへのpushまたはmasterでの手動実行で、
  CI成功後に `firebase deploy --only functions --project poker-bot-d0190 --non-interactive` を実行する。
  masterへのpushには本番反映が伴う。Firestoreルール等の反映は別途対象を指定する。
- Google Cloudの認証はWorkload Identity Federationを使う。サービスアカウントの秘密鍵を作成・保存しない。
- `.claude/settings.local.json` はClaude Code固有のローカル許可履歴。
  Codexの指示や実行許可の根拠として扱わず、この `AGENTS.md` を開発ガイドとして使う。
