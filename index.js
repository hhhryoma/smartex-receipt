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
const OTP_MAX_RETRIES = 3;

function parseArgs() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flags = process.argv.slice(2);
  let year, month;

  const monthIdx = flags.indexOf('--month');
  if (monthIdx !== -1 && flags[monthIdx + 1]) {
    const val = flags[monthIdx + 1];
    const m = val.match(/^(\d{4})-(\d{1,2})$/);
    if (m) {
      year = parseInt(m[1]);
      month = parseInt(m[2]);
    } else {
      console.error('エラー: --month は YYYY-MM 形式で指定してください（例: --month 2026-05）');
      process.exit(1);
    }
  }

  if (!year || !month) {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }

  return { year, month };
}

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

  const { year, month } = parseArgs();
  const monthStr = `${year}年${month}月`;
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  console.log(`[SmartEX] ${monthStr}分の領収書を取得します...`);

  const monthDir = path.join(CONFIG.outputDir, monthKey);
  const debugDir = path.join(CONFIG.outputDir, 'debug');

  // 再実行時は前回のPDFをクリア
  if (fs.existsSync(monthDir)) {
    const oldFiles = fs.readdirSync(monthDir).filter((f) => f.endsWith('.pdf'));
    if (oldFiles.length > 0) {
      console.log(`[SmartEX] 前回のPDF ${oldFiles.length}件を削除します`);
      oldFiles.forEach((f) => fs.unlinkSync(path.join(monthDir, f)));
    }
  }
  fs.mkdirSync(monthDir, { recursive: true });
  if (IS_DEBUG) fs.mkdirSync(debugDir, { recursive: true });

  const profileDir = path.join(CONFIG.outputDir, '.browser-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    acceptDownloads: true,
  });
  const page = await context.newPage();

  try {
    await login(page, debugDir);
    const receipts = await downloadReceipts(page, context, monthDir, debugDir, year, month);

    if (receipts.length === 0) {
      console.log(`[SmartEX] ${monthStr}分の領収書はありませんでした。`);
      return { month: monthStr, count: 0 };
    }

    console.log(`[SmartEX] ${receipts.length}件の領収書をダウンロードしました。`);

    const archivePath = path.join(CONFIG.outputDir, `smartex_receipts_${monthKey}.7z`);
    await compress7z(monthDir, archivePath);
    console.log(`[SmartEX] 7z圧縮完了: ${archivePath}`);

    if (CONFIG.lineToken && CONFIG.lineUserId) {
      await sendLineNotification(monthStr, receipts, archivePath);
    }

    console.log(`[SmartEX] 完了！ファイル: ${archivePath}`);
    return { month: monthStr, count: receipts.length, file: archivePath };
  } catch (err) {
    console.error('[SmartEX] エラー:', err.message);
    if (IS_DEBUG) {
      await page.screenshot({ path: path.join(debugDir, 'error.png'), fullPage: true });
      console.log(`[DEBUG] エラー時URL: ${page.url()}`);
    }
    throw err;
  } finally {
    await context.close();
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
  await page.screenshot({ path: path.join(debugDir, `${name}.png`), fullPage: true });
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

  await page.locator('input[name="01"]').fill(CONFIG.memberId);
  await page.locator('input[name="02"]').fill(CONFIG.password);
  await page.locator('input[type="submit"][value="ログイン"]').click();

  await page.waitForURL((url) => !url.href.includes('smart_index'), { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded');
  await debugScreenshot(page, debugDir, '02_after_login');

  if (page.url().includes('smart_index')) {
    throw new Error('ログインに失敗しました。会員IDとパスワードを確認してください。');
  }

  const bodyText = await page.locator('body').textContent();
  if (!bodyText.includes('ワンタイムパスワード')) {
    console.log('[SmartEX] ログイン成功');
    return;
  }

  console.log('[SmartEX] SMS認証が必要です。');
  await debugSaveHtml(page, debugDir, '02_otp_page');

  const smsBtn = page.locator('input[value*="SMS送信"], a:has-text("SMS送信"), button:has-text("SMS送信")').first();
  if (await smsBtn.count() > 0) {
    await smsBtn.click();
    await page.waitForLoadState('domcontentloaded');
    await removeLightbox(page);
    console.log('[SmartEX] SMSを送信しました。');
  }

  // OTPリトライループ
  for (let attempt = 1; attempt <= OTP_MAX_RETRIES; attempt++) {
    const otpFile = path.join(CONFIG.outputDir, 'otp.txt');
    if (fs.existsSync(otpFile)) fs.unlinkSync(otpFile);

    if (attempt > 1) {
      console.log(`[SmartEX] OTP再入力 (${attempt}/${OTP_MAX_RETRIES})...`);
    }
    console.log(`[SmartEX] OTP待ち: ${otpFile} にワンタイムパスワードを書き込んでください...`);
    console.log('[SmartEX] ※SMSに届いた最新の6桁コードを書き込んでください');

    const otp = await waitForOtp(otpFile, 300000);
    if (!otp) throw new Error('ワンタイムパスワードがタイムアウトしました。');
    console.log(`[SmartEX] OTP受信: ${otp}`);

    await fillOtpField(page, otp);
    await debugScreenshot(page, debugDir, '02c_otp_filled');
    await removeLightbox(page);
    await clickOkButton(page);
    await page.waitForLoadState('domcontentloaded');
    await debugScreenshot(page, debugDir, '02d_after_otp');

    const afterText = await page.locator('body').textContent();
    if (afterText.includes('正しくありません') || afterText.includes('無効')) {
      console.warn('[SmartEX] OTPが正しくありません。');
      if (attempt >= OTP_MAX_RETRIES) {
        throw new Error(`ワンタイムパスワードが${OTP_MAX_RETRIES}回失敗しました。`);
      }
      continue;
    }

    console.log('[SmartEX] ログイン成功');
    return;
  }
}

async function removeLightbox(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.LBX-curtain, .LBX-window, [class*="LBX"]').forEach((el) => el.remove());
  });
}

async function fillOtpField(page, otp) {
  // name="tx01" が既知のフィールド名。フォールバックで他のセレクタも試す
  const selectors = [
    'input[name="tx01"]',
    'input[type="tel"]',
    'input[placeholder*="6桁"]',
    'input[placeholder*="数字"]',
    'input[placeholder*="半角"]',
  ];

  for (const sel of selectors) {
    const field = page.locator(sel).first();
    if (await field.count() > 0) {
      const name = await field.getAttribute('name');
      console.log(`[SmartEX] OTP入力フィールド発見（name="${name}"）`);
      await field.fill(otp);
      return;
    }
  }

  // フォールバック: 隠しでないテキスト系inputを探す
  const fallbackName = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"]');
    for (const input of inputs) {
      if (input.name && !input.name.startsWith('_')) return input.name;
    }
    return null;
  });

  if (fallbackName) {
    console.log(`[SmartEX] OTP入力フィールド発見（name="${fallbackName}"）`);
    await page.locator(`input[name="${fallbackName}"]`).fill(otp);
  } else {
    console.warn('[SmartEX] OTP入力フィールドが見つかりません');
  }
}

async function clickOkButton(page) {
  const selectors = [
    'input[value*="OK 次へ"]',
    'input[value*="OK"]',
    'a:has-text("OK")',
  ];

  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.count() > 0) {
      await btn.click({ force: true });
      return;
    }
  }

  // フォールバック: JS経由
  await page.evaluate(() => {
    const btns = document.querySelectorAll('input[type="submit"], button[type="submit"], a');
    for (const btn of btns) {
      const text = btn.value || btn.textContent || '';
      if (text.includes('OK') || text.includes('次へ')) {
        btn.click();
        return;
      }
    }
  });
}

async function downloadReceipts(page, context, monthDir, debugDir, year, month) {
  console.log('[SmartEX] 領収書一覧を取得中...');

  await navigateToHistory(page);
  await debugScreenshot(page, debugDir, '03_history_list_before_filter');
  await debugSaveHtml(page, debugDir, '03_history_list');

  const allReceipts = [];
  let pageNum = 1;

  while (true) {
    console.log(`[SmartEX] ページ ${pageNum} を処理中...`);
    const pageReceipts = await processReceiptPage(page, context, monthDir, debugDir, year, month, allReceipts.length);
    allReceipts.push(...pageReceipts);

    // 次ページの確認
    const hasNext = await goToNextPage(page);
    if (!hasNext) break;
    pageNum++;
    await page.waitForLoadState('domcontentloaded');
    await debugScreenshot(page, debugDir, `03_history_list_page${pageNum}`);
  }

  return allReceipts;
}

async function processReceiptPage(page, context, monthDir, debugDir, year, month, startIndex) {
  const receiptBtns = page.locator('input[name="b1"][value="領収書表示"]');
  const totalOnPage = await receiptBtns.count();
  console.log(`[SmartEX] 「領収書表示」ボタン: ${totalOnPage}件`);

  if (totalOnPage === 0) return [];

  const receipts = [];

  for (let i = 0; i < totalOnPage; i++) {
    const globalIdx = startIndex + i + 1;
    console.log(`[SmartEX] 領収書 ${globalIdx} を処理中...`);

    try {
      const btn = page.locator('input[name="b1"][value="領収書表示"]').nth(i);
      const currentCount = await page.locator('input[name="b1"][value="領収書表示"]').count();
      if (i >= currentCount) {
        console.warn(`[SmartEX] 領収書 ${globalIdx}: ボタンが見つかりません（残り${currentCount}個）。終了。`);
        break;
      }

      await btn.scrollIntoViewIfNeeded();
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        btn.click({ force: true }),
      ]);
      await debugScreenshot(page, debugDir, `04_receipt_${globalIdx}_page`);
      await debugSaveHtml(page, debugDir, `04_receipt_${globalIdx}_page`);

      // 印刷ボタン確認
      const hasPrint = await page.locator('input[name="b1"][value="印刷"]').count() > 0;
      if (!hasPrint) {
        const bodySnippet = await page.locator('body').textContent().catch(() => '');
        console.warn(`[SmartEX] 領収書 ${globalIdx}: 印刷ボタンなし。内容: ${bodySnippet.substring(0, 100)}`);
        await clickBackButton(page);
        continue;
      }

      // 乗車日・区間を読み取る
      const info = await extractReceiptInfo(page);

      if (info.rideDate) {
        console.log(`[SmartEX] 領収書 ${globalIdx}: 乗車日 ${info.rideDate.year}年${info.rideDate.month}月${info.rideDate.day}日 ${info.from}→${info.to}`);
        if (info.rideDate.year !== year || info.rideDate.month !== month) {
          console.log(`[SmartEX] 領収書 ${globalIdx}: 当月(${month}月)分ではないためスキップ`);
          await clickBackButton(page);
          continue;
        }
      }

      // 宛名入力
      if (CONFIG.addressee) {
        const addressField = page.locator('input[name="i1"]');
        if (await addressField.count() > 0) {
          await addressField.fill(CONFIG.addressee);
        }
      }

      // 印刷ボタンクリック → ポップアップでPDF保存
      const [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
        page.evaluate(() => {
          const btn = document.querySelector('input[name="b1"][value="印刷"]');
          if (btn) btn.click();
        }),
      ]);

      if (popup) {
        await popup.waitForLoadState('domcontentloaded');
        await debugScreenshot(popup, debugDir, `05_receipt_${globalIdx}_print`);

        const pdfName = buildPdfName(info, globalIdx);
        const pdfPath = path.join(monthDir, pdfName);
        await popup.pdf({
          path: pdfPath,
          format: 'A4',
          printBackground: true,
          margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
        });
        receipts.push({ index: globalIdx, file: pdfName, ...info });
        console.log(`[SmartEX] 保存: ${pdfPath}`);
        await popup.close();
      } else {
        console.warn(`[SmartEX] 領収書 ${globalIdx}: 印刷ウィンドウが開きませんでした。`);
      }

      await clickBackButton(page);
      await debugScreenshot(page, debugDir, `06_back_to_list_${globalIdx}`);
    } catch (err) {
      console.warn(`[SmartEX] 領収書 ${globalIdx} でエラー: ${err.message}`);
      if (IS_DEBUG) await debugScreenshot(page, debugDir, `error_receipt_${globalIdx}`);
      await clickBackButton(page).catch(() => {});
    }
  }

  return receipts;
}

async function extractReceiptInfo(page) {
  return page.evaluate(() => {
    const body = document.body.textContent;
    const dateMatch = body.match(/乗車日\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);

    const stationTable = document.querySelector('table.station');
    let from = '';
    let to = '';
    if (stationTable) {
      const spans = stationTable.querySelectorAll('span');
      if (spans.length >= 2) {
        from = spans[0].textContent.trim();
        to = spans[1].textContent.trim();
      }
    }

    return {
      rideDate: dateMatch
        ? { year: parseInt(dateMatch[1]), month: parseInt(dateMatch[2]), day: parseInt(dateMatch[3]) }
        : null,
      from,
      to,
    };
  });
}

function buildPdfName(info, index) {
  if (info.rideDate && info.from && info.to) {
    const d = info.rideDate;
    const dateStr = `${d.year}${String(d.month).padStart(2, '0')}${String(d.day).padStart(2, '0')}`;
    return `${dateStr}_${info.from}_${info.to}.pdf`;
  }
  return `receipt_${String(index).padStart(3, '0')}.pdf`;
}

async function navigateToHistory(page) {
  const links = page.locator('a[onclick*="cfEXPY_doAction"]');
  const count = await links.count();

  for (let i = 0; i < count; i++) {
    const text = await links.nth(i).textContent().catch(() => '');
    if (text.includes('利用履歴') || text.includes('領収書') || text.includes('購入履歴')) {
      console.log(`[SmartEX] メニュー遷移: "${text.trim()}"`);
      await links.nth(i).click();
      await page.waitForLoadState('domcontentloaded');
      return;
    }
  }

  // フォールバック: 全リンクから探す
  const allLinks = page.locator('a');
  const allCount = await allLinks.count();
  for (let i = 0; i < allCount; i++) {
    const text = await allLinks.nth(i).textContent().catch(() => '');
    if (text && (text.includes('利用履歴') || text.includes('購入履歴'))) {
      console.log(`[SmartEX] リンク遷移: "${text.trim()}"`);
      await allLinks.nth(i).click();
      await page.waitForLoadState('domcontentloaded');
      return;
    }
  }

  console.warn('[SmartEX] 利用履歴リンクが見つかりません。現在のページを使用します。');
}

async function goToNextPage(page) {
  // div.pager 内の「次へ」リンクを探す
  const pager = page.locator('div.pager');
  if (await pager.count() === 0) return false;

  const nextLink = pager.locator('a:has-text("次へ"), a:has-text("次のページ"), a.next');
  if (await nextLink.count() === 0) return false;

  console.log('[SmartEX] 次のページへ遷移...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    nextLink.first().click(),
  ]);
  return true;
}

async function clickBackButton(page) {
  const backBtn = page.locator('button[name="b2"], button[name="b5"], input[value="戻る"], button:has-text("戻る")').first();
  if (await backBtn.count() > 0) {
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

async function sendLineNotification(monthStr, receipts, archivePath) {
  const fileSize = fs.statSync(archivePath).size;
  const fileSizeKB = Math.round(fileSize / 1024);

  const receiptList = receipts
    .map((r) => {
      if (r.rideDate && r.from && r.to) {
        return `  ${r.rideDate.month}/${r.rideDate.day} ${r.from}→${r.to}`;
      }
      return `  ${r.file}`;
    })
    .join('\n');

  const message = [
    `SmartEX 領収書取得完了`,
    ``,
    `期間: ${monthStr}`,
    `件数: ${receipts.length}件`,
    receiptList,
    ``,
    `ファイル: ${path.basename(archivePath)} (${fileSizeKB}KB)`,
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
