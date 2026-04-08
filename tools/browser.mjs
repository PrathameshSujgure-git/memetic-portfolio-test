let puppeteer;
let browserAvailable = false;

export async function initBrowser() {
  try {
    puppeteer = (await import("puppeteer")).default;
    browserAvailable = true;
    console.log("[browser] puppeteer available — screenshots enabled");
  } catch {
    console.log("[browser] puppeteer not installed — screenshots will post raw URLs");
  }
}

export const browserTools = [
  {
    name: "take_screenshot",
    description:
      "Take a screenshot of a URL. Returns an image URL if puppeteer is available, otherwise returns the raw URL as fallback.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to screenshot" },
        wait_seconds: {
          type: "number",
          description: "Seconds to wait after load (default 5)",
        },
        selector: {
          type: "string",
          description: "CSS selector to screenshot (omit for full page)",
        },
      },
      required: ["url"],
    },
    requires_confirmation: false,
    timeout_ms: 60000,
  },
];

export async function executeTool(name, input) {
  if (name !== "take_screenshot") {
    return JSON.stringify({ error: `Unknown browser tool: ${name}` });
  }

  if (!browserAvailable) {
    return JSON.stringify({
      fallback: true,
      url: input.url,
      message: "Puppeteer not available. Posting URL directly.",
    });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(input.url, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait extra if requested
    const wait = (input.wait_seconds || 5) * 1000;
    await new Promise((r) => setTimeout(r, wait));

    // Dismiss modals/popups
    try {
      await page.evaluate(() => {
        document.querySelectorAll('[role="dialog"], .modal, .popup, .overlay').forEach((el) => {
          el.style.display = "none";
        });
      });
    } catch {}

    // Take screenshot
    let screenshot;
    if (input.selector) {
      const el = await page.$(input.selector);
      if (el) screenshot = await el.screenshot({ encoding: "base64" });
      else screenshot = await page.screenshot({ fullPage: true, encoding: "base64" });
    } else {
      screenshot = await page.screenshot({ fullPage: true, encoding: "base64" });
    }

    await browser.close();

    // For now, return base64 — in production, upload to Slack files API
    return JSON.stringify({
      ok: true,
      base64: screenshot.slice(0, 100) + "...[truncated for context]",
      url: input.url,
      message: "Screenshot taken. Use Slack files.upload to share inline.",
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return JSON.stringify({
      fallback: true,
      url: input.url,
      error: err.message,
    });
  }
}
