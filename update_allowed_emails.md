# ALLOWED_EMAILS 更新手順

## 1. `allowed_emails.txt` にメールアドレスを追加

改行して追加します。

例:

```txt
user1@gmail.com
user2@gmail.com
```

## 2. 環境変数を更新

ターミナルで実行します。

```bash
cat allowed_emails.txt | firebase functions:secrets:set ALLOWED_EMAILS
```

## 3. Functions を再デプロイ

```bash
firebase deploy --only functions
```

## 4. セキュリティ

`allowed_emails.txt` は Git に push しません。
`.gitignore` に `allowed_emails.txt` を追加済みです。
