import { chromium } from 'playwright';

const REPORT = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findRendererPage(browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      try {
        const hasPrompt = await page.locator('#prompt').count();
        if (hasPrompt > 0) return page;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

async function getToolSnapshot(page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.tool-indicator[data-tool-id]'));
    const out = [];
    for (const el of rows) {
      const id = el.getAttribute('data-tool-id') || '';
      const name = (el.querySelector('.tool-name')?.textContent || '').trim();
      if (id) out.push({ id, name });
    }
    return out;
  });
}

async function getLastAssistantText(page) {
  return await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('#output .assistant-content'));
    const last = blocks[blocks.length - 1];
    if (!last) return '';
    return (last.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

async function sendPrompt(page, prompt, timeoutMs = 180000) {
  const beforeTools = await getToolSnapshot(page);
  const beforeIds = new Set(beforeTools.map((t) => t.id));

  await page.fill('#prompt', prompt);
  await page.click('#send');

  await page.waitForFunction(() => {
    const btn = document.getElementById('send');
    return !!btn && btn.disabled === true;
  }, { timeout: 5000 }).catch(() => {});

  await page.waitForFunction(() => {
    const btn = document.getElementById('send');
    return !!btn && btn.disabled === false;
  }, { timeout: timeoutMs });

  await sleep(600);

  const afterTools = await getToolSnapshot(page);
  const newTools = afterTools.filter((t) => !beforeIds.has(t.id));
  const text = await getLastAssistantText(page);
  return { text, newTools };
}

async function run() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

  const page = await findRendererPage(browser);
  if (!page) {
    throw new Error('Could not find renderer page with #prompt');
  }

  await page.bringToFront().catch(() => {});
  await page.waitForSelector('#send', { timeout: 10000 });

  REPORT.push({ step: 1, name: 'App window reachable', pass: true, detail: `Renderer URL: ${page.url()}` });
  REPORT.push({ step: 2, name: 'CDP reachable', pass: true, detail: 'Connected to Electron remote debugging endpoint on 9222.' });

  const s3 = await sendPrompt(page, 'How much does ChatGPT Pro cost?');
  REPORT.push({
    step: 3,
    name: 'Factual query efficiency',
    pass: s3.newTools.length <= 2 && s3.newTools.length >= 1,
    detail: `tools=${s3.newTools.map((t) => t.name).join(', ') || 'none'} | response=${s3.text.slice(0, 180)}`,
  });

  const s4 = await sendPrompt(page, 'Go to github.com');
  const s4Names = s4.newTools.map((t) => t.name);
  REPORT.push({
    step: 4,
    name: 'Direct URL navigation (no search)',
    pass: s4Names.includes('browser_navigate') && !s4Names.includes('browser_search'),
    detail: `tools=${s4Names.join(', ') || 'none'} | response=${s4.text.slice(0, 180)}`,
  });

  const s5 = await sendPrompt(page, "What's 15% of 340?");
  REPORT.push({
    step: 5,
    name: 'Math question with zero tools',
    pass: s5.newTools.length === 0,
    detail: `tools=${s5.newTools.map((t) => t.name).join(', ') || 'none'} | response=${s5.text.slice(0, 180)}`,
  });

  const s6 = await sendPrompt(page, 'Compare Claude vs ChatGPT pricing');
  REPORT.push({
    step: 6,
    name: 'Comparison uses moderate tools',
    pass: s6.newTools.length >= 2 && s6.newTools.length <= 5,
    detail: `tools=${s6.newTools.map((t) => t.name).join(', ') || 'none'} | response=${s6.text.slice(0, 180)}`,
  });

  const s7 = await sendPrompt(page, 'Search for OpenAI and click the official OpenAI website result, then tell me the page title.');
  REPORT.push({
    step: 7,
    name: 'Semantic click tool works',
    pass: s7.newTools.some((t) => t.name === 'browser_click'),
    detail: `tools=${s7.newTools.map((t) => t.name).join(', ') || 'none'} | response=${s7.text.slice(0, 180)}`,
  });

  const tabCountsBefore = await page.evaluate(() => document.querySelectorAll('#source-tabs .source-tab').length);
  await page.evaluate(() => window.api.browserTabNew('https://example.com'));
  await page.waitForFunction((before) => document.querySelectorAll('#source-tabs .source-tab').length > before, tabCountsBefore, { timeout: 15000 });

  const tabState = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('#source-tabs .source-tab'));
    const ids = tabs.map((el) => el.getAttribute('data-source-id') || '').filter(Boolean);
    const active = document.querySelector('#source-tabs .source-tab.active')?.getAttribute('data-source-id') || null;
    return { count: tabs.length, ids, active };
  });

  let switched = false;
  if (tabState.ids.length >= 2) {
    const target = tabState.ids[0] === tabState.active ? tabState.ids[1] : tabState.ids[0];
    await page.click(`#source-tabs .source-tab[data-source-id="${target}"]`);
    await page.waitForFunction((id) => {
      const active = document.querySelector('#source-tabs .source-tab.active');
      return !!active && active.getAttribute('data-source-id') === id;
    }, target, { timeout: 8000 });
    switched = true;
  }

  REPORT.push({
    step: 8,
    name: 'Real tab UI updates + switching',
    pass: tabState.count >= tabCountsBefore + 1 && switched,
    detail: `before=${tabCountsBefore}, after=${tabState.count}, switched=${switched}`,
  });

  REPORT.push({
    step: 9,
    name: 'No third-party console spam',
    pass: null,
    detail: 'Not directly observable from renderer automation; requires inspecting main-process BrowserView logs during live browsing.',
  });

  const s10 = await sendPrompt(page, 'Go to https://twitter.com and summarize what you see.');
  const s10Blocked = /blocked|another source|login-walled|cannot/i.test(s10.text);
  REPORT.push({
    step: 10,
    name: 'Social media blocked for tool flow',
    pass: s10Blocked,
    detail: `tools=${s10.newTools.map((t) => t.name).join(', ') || 'none'} | response=${s10.text.slice(0, 220)}`,
  });

  console.log(JSON.stringify(REPORT, null, 2));
  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
