# Mochi

学校のPCで持ち物を登録し、スマホで同じチェックリストを見て、指定時刻にWeb Push通知を受け取れるシンプルなPWAです。

## できること
- ID + PINでログイン
- 学校PC / スマホで同じデータを共有
- 今日 / 明日のチェックリスト
- 持ち物の追加・完了・削除
- 指定時刻のWeb Push通知
- iPhoneのホーム画面追加対応

## 起動
Node.js 18以上が必要です。

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開きます。
初回だけ、IDと4〜8桁のPINを作成します。

## スマホと学校PCの両方から使うには
インターネット上のHTTPS対応サーバーへこのフォルダを配置してください。Render / Railway / Fly.io / VPS など、Node.jsを常時起動できる場所なら動作します。

保存先は標準では `./data` です。ホスティングではこのディレクトリを永続ストレージにしてください。環境変数 `DATA_DIR` で保存場所を変更できます。

## iPhone通知
1. Safariで公開したMochiを開く
2. 共有 → 「ホーム画面に追加」
3. ホーム画面からMochiを開く
4. 設定 → 通知 → ON

Web PushはHTTPS環境が必要です（localhostを除く）。

## 環境変数（任意）
- `PORT`: ポート番号
- `DATA_DIR`: データ保存フォルダ
- `SESSION_SECRET`: セッション署名用シークレット
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: Web Push用VAPID鍵
- `VAPID_SUBJECT`: 例 `mailto:you@example.com`
- `ALLOW_SIGNUP=true`: 2人目以降の新規登録を許可

未設定の場合、SESSION_SECRETとVAPID鍵は初回起動時に `data/` へ自動生成されます。

## セキュリティ
- PINはscryptでハッシュ化して保存
- セッションCookieはHttpOnly / SameSite=Lax
- 本番環境ではSecure Cookie
- 初期状態では1アカウント作成後、新規登録を閉じます

## 注意
このアプリは個人向けの軽量構成で、データ保存はJSONファイルです。大人数で使う場合はPostgreSQLなどのDBへの変更を推奨します。
