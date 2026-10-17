# 🃏 LINE ポーカー幹事Bot セットアップ手順

## Codexでの開発

開発エージェント向けの構成・仕様・確認手順はルートの [AGENTS.md](AGENTS.md) にまとめています。
Codexはこのファイルを開発指示として読み込みます。
詳細は [OpenAI公式ドキュメント](https://learn.chatgpt.com/docs/agent-configuration/agents-md) を参照してください。
`.claude/settings.local.json` はClaude Code専用のローカル実行許可設定です。
既存ファイルは残していますが、Gitの管理対象から除外し、Codexへの移植は不要です。

## 全体像

```
LINEグループ ⇄ Messaging API ⇄ Cloud Functions (webhook)
                                      │
                                 Firestore
                                      │
             Cloud Scheduler(毎月20日/毎日9時) → push送信
```

日程調整そのものは幹事(輪番)が人力で行い、Botはそのサポートに徹します。

| 機能 | 実装 |
|---|---|
| 幹事アナウンス | 毎月20日 10:00 に輪番の担当者をメンションし、翌月の日程調整を促す |
| 開催日登録 | 幹事が `@poker 開催日 8/8` で登録(日程調整はLINE上で人力) |
| リマインド | 登録された開催日の3日前・前日の朝9時にプッシュ |
| 点数管理 | 各自が `@poker 1000` で自分の素点を記録、累積ランキング表示(厳密な管理はNotion側) |

## 1. LINE Developers 側の設定

1. https://developers.line.biz/ でプロバイダー作成 → **Messaging APIチャネル**を作成
2. 「Messaging API設定」タブで:
   - **チャネルアクセストークン(長期)** を発行してメモ
   - 「グループ・複数人チャットへの参加を許可する」を **オン**
   - 応答メッセージ(自動応答)を **オフ**(LINE Official Account Manager側)
3. 「チャネル基本設定」タブで **チャネルシークレット** をメモ

## 2. Firebase 側の設定

```bash
# 既存のFirebaseプロジェクトを使う場合はそのプロジェクトで
firebase init functions   # 言語: JavaScript / Node 20
# このリポジトリの functions/ を上書きコピー

cd functions && npm install

# シークレット登録(Secret Manager)
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET

firebase deploy --only functions
```

デプロイ後に表示される `webhook` 関数のURL(例:
`https://asia-northeast1-<project>.cloudfunctions.net/webhook`)を
LINE Developers の「Webhook URL」に設定し、**Webhookの利用をオン**にして
「検証」ボタンで疎通確認。

## 3. グループに招待

BotをLINEグループに招待すると自動でグループIDがFirestoreに保存され、
以降のアナウンス・リマインドはそのグループに送られます。

## 4. 初期設定(グループ内で1回だけ)

1. `@poker 幹事登録 太郎 花子 次郎` … 輪番リストを回す順に設定
2. 各メンバーが自分で `@poker 登録 太郎` … 自分のLINEアカウントを名前に紐づけ
   (これでメンション通知が届き、`@poker 1000` の点数記録もこの名前で付く。
   未登録の場合、メンションは平文「@太郎 さん」、点数はLINEの表示名で記録)

## 5. 動作確認

- `@poker ヘルプ` … コマンド一覧
- `@poker 幹事` … 今の担当者と輪番リストを表示
- `@poker 開催日 8/8` … 開催日を登録 → `@poker 今月` で確認
- `@poker 1000` … 自分の点数を記録 → `@poker ランキング` で確認

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `@poker 幹事` | 今の担当者と輪番リストを表示 |
| `@poker 幹事登録 太郎 花子 次郎` | 輪番リストを設定(先頭から順に回る) |
| `@poker 登録 太郎` | 送信者自身をその名前に紐づけ(メンション用) |
| `@poker 開催日 8/8` | 開催日を登録(`2026-08-08` 形式も可) |
| `@poker 今月` | 登録済みの開催日を表示 |
| `@poker 1000` | 自分の点数を今日の日付で記録(同日の再入力は上書き) |
| `@poker 結果 8/8 太郎 500 花子 300` | まとめて記録(代理入力・後日入力用。同じ日・同じ名前は上書き) |
| `@poker ランキング` | 累積ランキング表示 |
| `@poker ヘルプ` | コマンド一覧 |

## カスタマイズ(index.js 冒頭の定数)

| 定数 | 意味 | デフォルト |
|---|---|---|
| `EVENT_TIME` | 開催時刻の表示 | 19:00〜22:00 |
| `ANNOUNCE_DAY` | 幹事アナウンス日(前月) | 20日 |

## 点数データの持ち方

- 記録は `games` コレクションに **1日1人1ドキュメント**(`games/2026-08-08_太郎`)で保存
- ランキングは表示のたびに `games` 全件を集計して算出(累計キャッシュなし)
- 記録を修正したいときは、同じ日にもう一度送れば上書き。過去分は
  Firestoreコンソールで該当ドキュメントを直接編集/削除すればランキングに即反映

## 注意

- 無料プランのプッシュ通知は月200通まで。この構成の月間送信数は
  幹事アナウンス1通+リマインド2通程度なので余裕です
- 輪番リストはFirestore(`config/organizers`)に保存され、毎月のアナウンス後に
  自動で次の人へ進みます。順番を変えたいときは `@poker 幹事登録 ...` で再設定
  してください(先頭にリセットされます)
- メンションはLINEのuserIdが必要なため、各自の `@poker 登録 名前` が前提です。
  未登録の担当者には平文の「@名前 さん」でアナウンスされます
