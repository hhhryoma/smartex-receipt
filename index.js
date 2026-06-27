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

  const browser = await chromium.launch({
    headless: !IS_DEBUG,
    slowMo: IS_DEBUG ? 500 : 0,
  });
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
      console.log(`[DEBUG] エラー時のスクリーンショットを保存: ${debugDir}/error.png`);
      console.log(`[DEBUG] 現在のURL: ${page.url()}`);
      console.log(`[DEBUG] ページタイトル: ${await page.title()}`);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

function validateConfig() {
  if (!CONFIG.memberId || !CONFIG.password) {
    console.error('エラー: .envにSMARTEX_MEMBER_IDとSMARTEX_PASSWORDを設定してください。');
    console.error('.env.exampleを参考に .env ファイルを作成してください。');
    process.exit(1);
  }
}

async function debugScreenshot(page, debugDir, name) {
  if (!IS_DEBUG) return;
  const filePath = path.join(debugDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`[DEBUG] ${name}: ${page.url()}`);
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

  const currentUrl = page.url();
  if (currentUrl.includes('smart_index')) {
    throw new Error('ログインに失敗しました。会員IDとパスワードを確認してください。');
  }

  console.log('[SmartEX] ログイン成功');
}

async function downloadReceipts(page, context, monthDir, debugDir, year, month) {
  console.log('[SmartEX] 領収書一覧を取得中...');

  const navigated = await navigateToHistory(page);
  await debugScreenshot(page, debugDir, '03_history_page');

  if (!navigated) {
    console.log('[SmartEX] 利用履歴ページへの遷移に失敗。ページ構造を確認してください。');
    if (IS_DEBUG) {
      const html = await page.content();
      fs.writeFileSync(path.join(debugDir, '03_page.html'), html);
    }
    return 0;
  }

  await setDateRange(page, year, month);
  await debugScreenshot(page, debugDir, '04_date_filtered');

  const receiptButtons = await collectReceiptButtons(page);
  if (receiptButtons.length === 0) {
    console.log('[SmartEX] 当月の領収書が見つかりませんでした。');
    if (IS_DEBUG) {
      const html = await page.content();
      fs.writeFileSync(path.join(debugDir, '04_page.html'), html);
    }
    return 0;
  }

  console.log(`[SmartEX] ${receiptButtons.length}件の領収書を検出`);
  return await processReceiptButtons(page, context, receiptButtons, monthDir, debugDir);
}

async function navigateToHistory(page) {
  const keywords = ['ご利用履歴', '領収書の発行', '購入履歴', '利用履歴・領収書', '利用履歴'];

  // セレクタベースで探す
  for (const kw of keywords) {
    const link = await page.$(`a:has-text("${kw}")`);
    if (link) {
      await link.click();
      await page.waitForLoadState('domcontentloaded');
      return true;
    }
  }

  // href属性で探す
  for (const pattern of ['history', 'receipt', 'rireki']) {
    const link = await page.$(`a[href*="${pattern}"]`);
    if (link) {
      await link.click();
      await page.waitForLoadState('domcontentloaded');
      return true;
    }
  }

  // 全リンクをテキストで探す
  const links = await page.$$('a');
  for (const link of links) {
    const text = await link.textContent().catch(() => '');
    if (text && keywords.some((kw) => text.includes(kw))) {
      await link.click();
      await page.waitForLoadState('domcontentloaded');
      return true;
    }
  }

  return false;
}

async function setDateRange(page, year, month) {
  const selects = await page.$$('select');
  let foundDateControls = false;

  for (const select of selects) {
    const name = (await select.getAttribute('name')) || '';
    const id = (await select.getAttribute('id')) || '';
    const label = name + id;

    if (/year|nen|yyyy/i.test(label)) {
      await select.selectOption(String(year)).catch(() => {});
      foundDateControls = true;
    }
    if (/month|gatsu|tsuki|mm/i.test(label)) {
      await select.selectOption(String(month)).catch(() => {});
      foundDateControls = true;
    }
  }

  // 照会/検索ボタンを押す
  const btnSelectors = [
    'input[value*="照会"]', 'input[value*="検索"]', 'input[value*="表示"]',
    'button:has-text("照会")', 'button:has-text("検索")',
    'a:has-text("照会")', 'a:has-text("検索")',
  ];
  for (const sel of btnSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click();
      await page.waitForLoadState('domcontentloaded');
      break;
    }
  }
}

async function collectReceiptButtons(page) {
  // まず明示的なセレクタで探す
  let buttons = await page.$$('a:has-text("領収書表示"), button:has-text("領収書表示"), input[value="領収書表示"]');
  if (buttons.length > 0) return buttons;

  // フォールバック：全要素から「領収書」を含むボタン/リンクを探す
  const allClickable = await page.$$('a, button, input[type="button"], input[type="submit"]');
  const candidates = [];
  for (const el of allClickable) {
    const text = await el.textContent().catch(() => '');
    const value = (await el.getAttribute('value')) || '';
    if ((text && text.includes('領収書')) || value.includes('領収書')) {
      candidates.push(el);
    }
  }
  return candidates;
}

async function processReceiptButtons(page, context, buttons, monthDir, debugDir) {
  let receiptCount = 0;
  const totalCount = buttons.length;

  for (let i = 0; i < totalCount; i++) {
    console.log(`[SmartEX] 領収書 ${i + 1}/${totalCount} を処理中...`);

    try {
      // ポップアップを待ちつつクリック
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
        buttons[i].click(),
      ]);

      const receiptPage = popup || page;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded');
      } else {
        await page.waitForTimeout(2000);
      }
      await debugScreenshot(receiptPage, debugDir, `05_receipt_${i + 1}_opened`);

      // 宛名入力
      if (CONFIG.addressee) {
        const inputs = await receiptPage.$$('input[type="text"]');
        for (const input of inputs) {
          const placeholder = (await input.getAttribute('placeholder')) || '';
          const name = (await input.getAttribute('name')) || '';
          if (/宛名|atena|name/i.test(placeholder + name) || inputs.length === 1) {
            await input.fill(CONFIG.addressee);
            break;
          }
        }
      }

      // 「印刷」ボタンを探してクリック → インボイス対応領収書表示
      const printBtn = await receiptPage.$('input[value*="印刷"], button:has-text("印刷"), a:has-text("印刷")');
      let finalPage = receiptPage;

      if (printBtn) {
        const [invoicePage] = await Promise.all([
          context.waitForEvent('page', { timeout: 10000 }).catch(() => null),
          printBtn.click(),
        ]);
        if (invoicePage) {
          await invoicePage.waitForLoadState('domcontentloaded');
          finalPage = invoicePage;
        } else {
          await receiptPage.waitForTimeout(2000);
        }
      }

      await debugScreenshot(finalPage, debugDir, `06_receipt_${i + 1}_final`);

      // PDFとして保存
      const pdfPath = path.join(monthDir, `receipt_${String(i + 1).padStart(3, '0')}.pdf`);
      await finalPage.pdf({
        path: pdfPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      });
      receiptCount++;
      console.log(`[SmartEX] 保存: ${pdfPath}`);

      // ポップアップを閉じる
      if (finalPage !== receiptPage && finalPage !== page) await finalPage.close();
      if (popup) await popup.close();

      await page.waitForTimeout(1000);

      // DOM更新に対応するためボタンリストを再取得
      if (i < totalCount - 1) {
        const refreshed = await collectReceiptButtons(page);
        if (refreshed.length > i + 1) {
          buttons[i + 1] = refreshed[i + 1];
        }
      }
    } catch (err) {
      console.warn(`[SmartEX] 領収書 ${i + 1} の取得でエラー: ${err.message}`);
      await debugScreenshot(page, debugDir, `error_receipt_${i + 1}`);
    }
  }

  return receiptCount;
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
