# CatchUpBot — 見逃し防止ダイジェスト Bot

しばらく Discord を見られなかった人のために、サーバーの流れを Gemini が要約し、
「自分宛のメンションのうち、まだ返していないもの」だけを抜き出して DM で届けるボット。

## 何が起きるか

1. サーバー内の発言を PostgreSQL に蓄積する
2. `@自分` 宛のメンションを 1 件ずつ「未対応タスク」として記録する
3. 返信 / リアクション / 同チャンネルでの発言を検知して、対応済みのものを自動で外す
4. 毎朝決まった時刻に「前日のまとめ + あなた宛の未対応 n 件」を DM で送る

## コマンド

| コマンド | 内容 |
| --- | --- |
| `/help` | 使い方を表示 |
| `/catchup [hours]` | 直近 hours 時間（既定 24）のまとめを今すぐ DM |
| `/subscribe [time]` | 毎日決まった時刻に自動配信（例 `time:08:00`） |
| `/unsubscribe` | 自動配信を停止 |
| `/todo` | 自分宛の未対応メンション一覧 |

## ローカルで動かす

```bash
cp .env.example .env      # DISCORD_TOKEN と GEMINI_API_KEY を書く
docker compose up --build
```

- ステータスページ: http://localhost:3000
- pgAdmin: http://localhost:8083

## Discord Developer Portal の設定

Bot → Privileged Gateway Intents で **MESSAGE CONTENT INTENT** を ON にする。
（発言内容を読めないとダイジェストが作れないため）

招待 URL のスコープは `bot` + `applications.commands`、
権限は「メッセージを読む / メッセージ履歴を読む / メッセージを送信する」。

## Render へのデプロイ

1. **PostgreSQL** を作成し、`Internal Database URL` を控える
2. **Web Service** を作成（このリポジトリを指定）
   - Runtime: Docker（または Node、その場合 Build: `npm install` / Start: `npm start`）
3. Environment に以下を設定
   - `DISCORD_TOKEN`
   - `GEMINI_API_KEY`
   - `DB_INFO` = 1 で控えた Internal Database URL
   - `TZ` = `Asia/Tokyo`
   - `PORT` は Render が自動で入れるので設定不要
4. デプロイ後、割り当てられた URL をブラウザで開くとスリープが解除される

### スリープ対策について

Render の無料プランはアクセスが無いとスリープし、その間タイマーも止まる。
そのため定期配信は cron ではなく「毎分、配信時刻を過ぎていて今日まだ送っていない人を探す」
方式にしてある。スリープから復帰した時点で、その日の未配信ぶんがまとめて届く。

## 注意

発言内容をデータベースに保存するため、導入するサーバーのメンバーに周知すること。
提出用の動作確認は、自分で作ったテスト用サーバーで行うこと。
