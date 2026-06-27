# smartex-receipt

スマートEX（新幹線予約サービス）の領収書を自動取得し、7z圧縮するCLIツール。

## 機能

- スマートEXにログインし、指定月の領収書PDFを一括ダウンロード
- SMS OTP（ワンタイムパスワード）認証に対応
- 7z圧縮で1ファイルにまとめる
- LINE通知（オプション）

## セットアップ

```bash
git clone https://github.com/hhhryoma/smartex-receipt.git
cd smartex-receipt
npm install
npx playwright install chromium
```

`.env.example` をコピーして `.env` を作成し、認証情報を設定：

```bash
cp .env.example .env
```

```env
SMARTEX_MEMBER_ID=あなたの会員ID
SMARTEX_PASSWORD=あなたのパスワード
RECEIPT_ADDRESSEE=株式会社サンプル
```

## 使い方

### 当月の領収書を取得

```bash
node index.js
```

### 過去月を指定して取得

```bash
node index.js --month 2026-05
```

### デバッグモード

```bash
node index.js --debug
```

`output/debug/` にスクリーンショットとHTMLが保存されます。

## SMS認証（OTP）

スマートEXのSMS認証が求められた場合、スクリプトは `output/otp.txt` へのOTP書き込みを待ちます。

SMSに届いた6桁のコードを書き込んでください：

```bash
echo 123456 > output/otp.txt
```

OTPが正しくない場合、最大3回までリトライできます。

## 出力

```
output/
  2026-06/
    20260624_東京_新大阪.pdf
    20260622_東京_名古屋.pdf
    ...
  smartex_receipts_2026-06.7z
```

## LINE通知（オプション）

`.env` に LINE Messaging API のトークンを設定すると、完了時にLINE通知を送信します：

```env
LINE_CHANNEL_ACCESS_TOKEN=your_token
LINE_USER_ID=your_user_id
```

## 注意事項

- Playwright（headless Chromium）を使用するため、初回は `npx playwright install chromium` が必要
- `.env` に認証情報が含まれるため、絶対にコミットしないこと
- スマートEXの仕様変更により動作しなくなる可能性があります
