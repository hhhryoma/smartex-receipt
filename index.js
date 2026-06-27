const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const _7z = require('7zip-min');
require('dotenv').config();

const CONFIG = {
  memberId: process.env.SMARTEX_MEMBER_ID,
  password: process.env.SMARTEX_PASSWORD,
  addressee: process.env.RECEIPT_ADDRESSEE || '',
  lineToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  lineUserId: process.env.LINE_USER_ID,
  outputDir: path.resolve(process.env.OUTPUT_DIR || './output'),
};

const IS_DEBUG = process.argv.includes('--debug');
const SMARTEX_LOGIN_URL = 'https://shinkansen2.jr-central.co.jp/RSV_P/smart_index.htm';

function waitForOtp(filePath, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content.length >= 6) {
          clearInterval(interval);
          fs.unlinkSync(filePath);
          resolve(content);
        }
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 1000);
  });
}

async function main() {
  validateConfig();

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const monthStr = `${year}年${month}月`;
  console.log(`[SmartEX] ${monthStr}分の領収書を取得します...`);

  const monthDir = path.join(CONFIG.outputDir, `${year}-${String(month).padStart(2, '0')}`);
  const debugDir = path.join(CONFIG.outputDir, 'debug');
  fs.mkdirSync(monthDir, { recursive: true });
  if (IS_DEBUG) fs.mkdirSync(debugDir, { recursive: true });

  // page.pdf()はheadless必須
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await login(page, debugDir);
    const receiptCount = await downloadReceipts(page, context, monthDir, debugDir, year, month);

    if (receiptCount === 0) {
      console.log(`[SmartEX] ${monthStr}分の領収書はありませんでした。`);
      await browser.close();
      return { month: monthStr, count: 0 };
    }

    console.log(`[SmartEX] ${receiptCount}件の領収書をダウンロードしました。`);

    const archivePath = path.join(CONFIG.outputDir, `smartex_receipts_${year}-${String(month).padStart(2, '0')}.7z`);
    await compress7z(monthDir, archivePath);
    console.log(`[SmartEX] 7z圧縮完了: ${archivePath}`);

    if (CONFIG.lineToken && CONFIG.lineUserId) {
      await sendLineNotification(monthStr, receiptCount, archivePath);
    }

    console.log(`[SmartEX] 完了！ファイル: ${archivePath}`);
    return { month: monthStr, count: receiptCount, file: archivePath };
  } catch (err) {
    console.error('[SmartEX] エラー:', err.message);
    if (IS_DEBUG) {
      await page.screenshot({ path: path.join(debugDir, 'error.png'), fullPage: true });
      console.log(`[DEBUG] エラー時URL: ${page.url()}`);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

function validateConfig() {
  if (!CONFIG.memberId || !CONFIG.password) {
    console.error('エラー: .envにSMARTEX_MEMBER_IDとSMARTEX_PASSWORDを設定してください。');
    process.exit(1);
  }
}

async function debugScreenshot(page, debugDir, name) {
  if (!IS_DEBUG) return;
  const filePath = path.join(debugDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`[DEBUG] ${name}: ${page.url()}`);
}

async function debugSaveHtml(page, debugDir, name) {
  if (!IS_DEBUG) return;
  const html = await page.content();
  fs.writeFileSync(path.join(debugDir, `${name}.html`), html);
}

async function login(page, debugDir) {
  console.log('[SmartEX] ログイン中...');
  await page.goto(SMARTEX_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await debugScreenshot(page, debugDir, '01_login_page');

  await page.fill('input[name="01"]', CONFIG.memberId);
  await page.fill('input[name="02"]', CONFIG.password);
  await page.click('input[type="submit"][value="ログイン"]');

  await page.waitForURL((url) => !url.href.includes('smart_index'), { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded');
  await debugScreenshot(page, debugDir, '02_after_login');

  if (page.url().includes('smart_index')) {
    throw new Error('ログインに失敗しました。会員IDとパスワードを確認してください。');
  }

  const pageText = await page.textContent('body');
  if (pageText.includes('ワンタイムパスワード')) {
    console.log('[SmartEX] SMS認証が必要です。');
    await debugSaveHtml(page, debugDir, '02_otp_page');

    const smsBtn = await page.$('input[value*="SMS送信"], a:has-text("SMS送信"), button:has-text("SMS送信")');
    if (smsBtn) {
      await smsBtn.click();
      await page.waitForTimeout(2000);
      await page.evaluate(() => {
        document.querySelectorAll('.LBX-curtain, .LBX-window, [class*="LBX"]').forEach((el) => el.remove());
      });
      await page.waitForTimeout(1000);
      console.log('[SmartEX] SMSを送信しました。');
    }

    const otpFile = path.join(CONFIG.outputDir, 'otp.txt');
    if (fs.existsSync(otpFile)) fs.unlinkSync(otpFile);
    console.log(`[SmartEX] OTP待ち: ${otpFile} にワンタイムパスワードを書き込んでください...`);
    console.log('[SmartEX] ※SMSに届いた最新の6桁コードを書き込んでください');

    const otp = await waitForOtp(otpFile, 300000);
    if (!otp) throw new Error('ワンタイムパスワードがタイムアウトしました。');
    console.log(`[SmartEX] OTP受信: ${otp}`);

    // OTP入力フィールドを探す（複数のセレクタで試行）
    let otpInput = await page.$('input[type="tel"]');
    if (!otpInput) otpInput = await page.$('input[placeholder*="6桁"]');
    if (!otpInput) otpInput = await page.$('input[placeholder*="数字"]');
    if (!otpInput) otpInput = await page.$('input[placeholder*="半角"]');
    if (!otpInput) {
      // フォーム内のテキスト入力を探す
      otpInput = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"]');
        for (const input of inputs) {
          if (input.name && !input.name.startsWith('_')) return input.name;
        }
        return null;
      });
      if (otpInput) {
        console.log(`[SmartEX] OTP入力フィールド発見（name="${otpInput}"）`);
        await page.fill(`input[name="${otpInput}"]`, otp);
      } else {
        console.warn('[SmartEX] OTP入力フィールドが見つかりません');
      }
    } else {
      const inputName = await otpInput.getAttribute('name');
      console.log(`[SmartEX] OTP入力フィールド発見（name="${inputName}"）`);
      await otpInput.fill(otp);
    }

    await debugScreenshot(page, debugDir, '02c_otp_filled');

    await page.evaluate(() => {
      document.querySelectorAll('.LBX-curtain, .LBX-window').forEach((el) => el.remove());
    });

    // OK/次へボタンをクリック
    let okBtn = await page.$('input[value*="OK 次へ"]');
    if (!okBtn) okBtn = await page.$('input[value*="OK"]');
    if (!okBtn) okBtn = await page.$('a:has-text("OK")');
    if (!okBtn) {
      // フォールバック: submit系ボタンを探す
      okBtn = await page.evaluate(() => {
        const btns = document.querySelectorAll('input[type="submit"], button[type="submit"], a');
        for (const btn of btns) {
          const text = btn.value || btn.textContent || '';
          if (text.includes('OK') || text.includes('次へ')) return true;
        }
        return false;
      });
    }
    if (okBtn && typeof okBtn !== 'boolean') {
      await okBtn.click({ force: true });
    } else {
      // JS経由でクリック
      await page.evaluate(() => {
        const btns = document.querySelectorAll('input[type="submit"], button[type="submit"], a');
        for (const btn of btns) {
          const text = btn.value || btn.textContent || '';
          if (text.includes('OK') || text.includes('次へ')) { btn.click(); return; }
        }
      });
    }
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    await debugScreenshot(page, debugDir, '02d_after_otp');

    // OTPエラーチェック
    const afterOtpText = await page.textContent('body');
    if (afterOtpText.includes('正しくありません') || afterOtpText.includes('無効')) {
      throw new Error('ワンタイムパスワードが正しくありません。最新のSMSコードを確認して再実行してください。');
    }
  }

  console.log('[SmartEX] ログイン成功');
}

async function downloadReceipts(page, context, monthDir, debugDir, year, month) {
  console.log('[SmartEX] 領収書一覧を取得中...');

  await navigateToHistory(page);
  await debugScreenshot(page, debugDir, '03_history_list_before_filter');

  await debugScreenshot(page, debugDir, '03_history_list');
  await debugSaveHtml(page, debugDir, '03_history_list');

  // 「領収書表示」ボタンの数を取得（name="b1", value="領収書表示"）
  const receiptCount_total = await page.locator('input[name="b1"][value="領収書表示"]').count();
  console.log(`[SmartEX] 「領収書表示」ボタン: ${receiptCount_total}件`);

  if (receiptCount_total === 0) {
    console.log('[SmartEX] 当月の領収書が見つかりませんでした。');
    return 0;
  }

  let receiptCount = 0;

  for (let i = 0; i < receiptCount_total; i++) {
    console.log(`[SmartEX] 領収書 ${i + 1}/${receiptCount_total} を処理中...`);

    try {
      // 現在のページで i番目の「領収書表示」ボタンをクリック
      const receiptBtn = page.locator('input[name="b1"][value="領収書表示"]').nth(i);
      const btnCount = await page.locator('input[name="b1"][value="領収書表示"]').count();
      if (i >= btnCount) {
        console.warn(`[SmartEX] 領収書 ${i + 1}: ボタンが見つかりません（現在${btnCount}個）。終了。`);
        break;
      }

      await receiptBtn.scrollIntoViewIfNeeded();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        receiptBtn.click({ force: true }),
      ]);
      await page.waitForTimeout(1500);
      await debugScreenshot(page, debugDir, `04_receipt_${i + 1}_page`);
      await debugSaveHtml(page, debugDir, `04_receipt_${i + 1}_page`);

      // 領収書ページかチェック（印刷ボタンが存在するか）
      const printBtn = await page.$('input[name="b1"][value="印刷"]');
      if (!printBtn) {
        const bodyText = await page.textContent('body').catch(() => '');
        console.warn(`[SmartEX] 領収書 ${i + 1}: 印刷ボタンなし。ページ内容: ${bodyText.substring(0, 100)}`);
        await clickBackButton(page);
        await page.waitForTimeout(1000);
        continue;
      }

      // 乗車日を読み取り、当月分かチェック
      const rideDate = await page.evaluate(() => {
        const body = document.body.textContent;
        const m = body.match(/乗車日\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
        return m ? { year: parseInt(m[1]), month: parseInt(m[2]), day: parseInt(m[3]) } : null;
      });

      if (rideDate) {
        console.log(`[SmartEX] 領収書 ${i + 1}: 乗車日 ${rideDate.year}年${rideDate.month}月${rideDate.day}日`);
        if (rideDate.year !== year || rideDate.month !== month) {
          console.log(`[SmartEX] 領収書 ${i + 1}: 当月(${month}月)分ではないためスキップ`);
          await clickBackButton(page);
          await page.waitForTimeout(1000);
          continue;
        }
      }

      // 宛名入力（i1=1行目）
      if (CONFIG.addressee) {
        const i1 = await page.$('input[name="i1"]');
        if (i1) await i1.fill(CONFIG.addressee);
      }

      // 印刷ボタンクリック → 新しいウィンドウが開く
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
        page.evaluate(() => {
          const btn = document.querySelector('input[name="b1"][value="印刷"]');
          if (btn) btn.click();
        }),
      ]);

      if (popup) {
        await popup.waitForLoadState('domcontentloaded');
        await popup.waitForTimeout(3000);
        await debugScreenshot(popup, debugDir, `05_receipt_${i + 1}_print`);

        const pdfPath = path.join(monthDir, `receipt_${String(i + 1).padStart(3, '0')}.pdf`);
        await popup.pdf({
          path: pdfPath,
          format: 'A4',
          printBackground: true,
          margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
        });
        receiptCount++;
        console.log(`[SmartEX] 保存: ${pdfPath}`);
        await popup.close();
      } else {
        console.warn(`[SmartEX] 領収書 ${i + 1}: 印刷ウィンドウが開きませんでした。`);
      }

      // 戻るボタンで一覧に戻る
      await clickBackButton(page);
      await page.waitForTimeout(1000);
      await debugScreenshot(page, debugDir, `06_back_to_list_${i + 1}`);

    } catch (err) {
      console.warn(`[SmartEX] 領収書 ${i + 1} でエラー: ${err.message}`);
      if (IS_DEBUG) await debugScreenshot(page, debugDir, `error_receipt_${i + 1}`);
      await clickBackButton(page).catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  return receiptCount;
}

async function navigateToHistory(page) {
  const links = await page.$$('a[onclick*="cfEXPY_doAction"]');
  for (const link of links) {
    const text = await link.textContent().catch(() => '');
    if (text.includes('利用履歴') || text.includes('領収書') || text.includes('購入履歴')) {
      console.log(`[SmartEX] メニュー遷移: "${text.trim()}"`);
      await link.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);
      return;
    }
  }

  const allLinks = await page.$$('a');
  for (const link of allLinks) {
    const text = await link.textContent().catch(() => '');
    if (text && (text.includes('利用履歴') || text.includes('購入履歴'))) {
      console.log(`[SmartEX] リンク遷移: "${text.trim()}"`);
      await link.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1000);
      return;
    }
  }

  console.warn('[SmartEX] 利用履歴リンクが見つかりません。現在のページを使用します。');
}

async function clickBackButton(page) {
  // 戻るボタンを探す: button[name="b2"] または button[name="b5"] または value="戻る"
  const backBtn = await page.$('button[name="b2"], button[name="b5"], input[value="戻る"], button:has-text("戻る")');
  if (backBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      backBtn.click({ force: true }),
    ]);
    console.log('[SmartEX] 戻る');
  } else {
    console.warn('[SmartEX] 戻るボタンが見つかりません');
  }
}

function compress7z(sourceDir, archivePath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    _7z.pack(sourceDir, archivePath, (err) => {
      if (err) reject(new Error(`7z圧縮エラー: ${err.message}`));
      else resolve();
    });
  });
}

async function sendLineNotification(monthStr, receiptCount, archivePath) {
  const fileSize = fs.statSync(archivePath).size;
  const fileSizeKB = Math.round(fileSize / 1024);

  const message = [
    `SmartEX 領収書取得完了`,
    ``,
    `期間: ${monthStr}`,
    `件数: ${receiptCount}件`,
    `ファイル: ${path.basename(archivePath)}`,
    `サイズ: ${fileSizeKB}KB`,
    ``,
    `保存先: ${archivePath}`,
  ].join('\n');

  try {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.lineToken}`,
      },
      body: JSON.stringify({
        to: CONFIG.lineUserId,
        messages: [{ type: 'text', text: message }],
      }),
    });

    if (response.ok) {
      console.log('[LINE] 通知送信完了');
    } else {
      const errorBody = await response.text();
      console.warn(`[LINE] 通知送信エラー: ${response.status} ${errorBody}`);
    }
  } catch (err) {
    console.warn(`[LINE] 通知送信エラー: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
