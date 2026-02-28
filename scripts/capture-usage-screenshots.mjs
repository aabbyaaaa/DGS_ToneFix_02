import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const APP_URL = "http://127.0.0.1:5173";
const OUTPUT_DIR = "docs/usage-images";

const mockedModelPayload = {
  variants: [
    {
      tone: "concise",
      subject: "DOV-30 真空烘箱抽除甲醇蒸氣建議",
      content: `關於 DOV-30 真空烘箱於水氣與甲醇蒸氣抽除之需求，
工程師的建議如下：

• 建議優先選用 Chemker 耐蝕型隔膜幫浦。
• 幫浦接氣部位需採 PTFE 材質，以降低甲醇腐蝕風險。
• 建議於烘箱與幫浦之間加裝冷凝阱，以保護幫浦壽命。`,
    },
    {
      tone: "standard",
      subject: "DOV-30 真空烘箱幫浦配置評估",
      content: `就 DOV-30 真空烘箱抽除水氣與甲醇蒸氣之應用，
工程師的建議如下：

• 建議採用 Chemker 系列耐蝕型隔膜幫浦，作為優先方案。
• 幫浦接氣部位請確認為 PTFE 材質，並定期檢查耗材狀態。
• 建議配置冷凝阱，減少甲醇蒸氣直接進入幫浦造成負擔。
• 初次導入可先做 30 分鐘空載測試，再投入正式製程。`,
    },
    {
      tone: "formal",
      subject: "DOV-30 真空烘箱抽除蒸氣之正式建議",
      content: `有關 DOV-30 真空烘箱搭配幫浦之製程條件評估，
工程師的建議如下：

• 建議選用 Chemker 耐蝕型隔膜幫浦，以提升有機溶劑環境之穩定性。
• 接氣部位應採 PTFE 材質，以降低甲醇蒸氣造成之腐蝕風險。
• 建議於系統前端配置冷凝阱，以保護幫浦並降低維護成本。
• 若製程需長時間連續運轉，建議建立每週巡檢與保養紀錄。`,
    },
  ],
};

function buildPolishResponse() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(mockedModelPayload),
        },
      },
    ],
  };
}

async function captureUsageScreenshots() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    channel: "msedge",
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1680, height: 980 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.route("**/api/polish", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildPolishResponse()),
      });
    });

    await page.goto(APP_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.screenshot({
      path: `${OUTPUT_DIR}/01-home.png`,
      fullPage: true,
    });

    await page.fill(
      'textarea[placeholder*="請貼上技術回覆"]',
      "DOV-30 真空烘箱要抽除水氣與甲醇蒸氣，請提供幫浦建議與維護重點。"
    );
    await page.click('button:has-text("開始轉換")');
    await page.waitForSelector("#card-concise .click-para", { timeout: 15000 });
    await page.waitForTimeout(800);

    await page.screenshot({
      path: `${OUTPUT_DIR}/02-generated-variants.png`,
      fullPage: true,
    });

    await page.locator('#card-concise .click-para:has-text("Chemker")').first().click();
    await page.waitForTimeout(500);

    await page.screenshot({
      path: `${OUTPUT_DIR}/03-clipboard-drawer.png`,
      fullPage: true,
    });

    await page.locator("aside").locator('button:has-text("Copy All")').click();
    await page.waitForTimeout(300);

    await page.screenshot({
      path: `${OUTPUT_DIR}/04-copy-all.png`,
      fullPage: true,
    });

    await context.close();
  } finally {
    await browser.close();
  }
}

captureUsageScreenshots().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
