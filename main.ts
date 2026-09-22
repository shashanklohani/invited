import { chromium, Locator, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import * as inspector from "node:inspector";
import { pathToFileURL } from "node:url";
import { applyInvitesSequentially } from "./applyInvites";

const backgroundChromeArgs = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

async function openInvites(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.bringToFront();
      await page.waitForLoadState('domcontentloaded');
      const jobsMenu = page.locator('.nI-gNb-custom-Jobs');
      const trigger = jobsMenu.locator('a.nI-gNb-menuItems__anchorDropdown');
      await trigger.waitFor({ state: 'visible', timeout: 5000 });
      await trigger.scrollIntoViewIfNeeded();
      // Move away first so a fresh mouseenter fires after a page reload.
      await page.mouse.move(0, 0);
      await trigger.hover({ timeout: 5000 });
      const link = jobsMenu.locator('.nI-gNb-dropdown a[href="/mnjuser/inbox"]');
      await link.waitFor({ state: 'visible', timeout: 3000 });
      await link.click({ timeout: 5000 });
      await page.waitForURL('**/mnjuser/inbox', { timeout: 10_000 });
      return;
    } catch (error) {
      if (page.isClosed()) throw error;
      if (new URL(page.url()).pathname === '/mnjuser/inbox') return;
    }
  }
  console.log('Jobs menu did not open after retries; opening the inbox directly.');
  await page.goto('https://www.naukri.com/mnjuser/inbox', { waitUntil: 'domcontentloaded' });
}

type AnsweredQuestion = { question: string; answer: string | string[] };

async function waitForNextQuestion(
  page: Page, messages: Locator, drawer: Locator, startUrl: string,
  previous?: AnsweredQuestion,
): Promise<string | null> {
  await page.bringToFront();
  const deadline = Date.now() + 30_000;
  let candidate = '';
  let readySince = 0;
  while (!page.isClosed() && page.url() === startUrl) {
    const question = (await messages.locator('ul li').last()
      .locator('div > div > span').allTextContents()).join(' ').trim();
    const previousAnswers = Array.isArray(previous?.answer) ? previous.answer : [previous?.answer ?? ''];
    const isNew = question && question !== previous?.question &&
      !previousAnswers.includes(question) && question !== previousAnswers.join(', ') && !/^(?:\.{1,3}|…|typing\.{0,3})$/i.test(question);
    const hasControl = await drawer.locator('.singleselect-radiobutton-container:visible').isVisible() ||
      await drawer.locator('.multicheckboxes-container:visible').isVisible() ||
      await drawer.locator('.chatbot_SendMessageContainer .textArea[contenteditable="true"]:visible').isVisible();
    const saveVisible = await drawer.locator('.sendMsgbtn_container .sendMsg:visible')
      .filter({ hasText: /^Save$/ }).isVisible();
    if (isNew && hasControl && saveVisible) {
      if (candidate !== question) {
        candidate = question;
        readySince = Date.now();
      } else if (Date.now() - readySince >= 400) {
        return question;
      }
    } else {
      candidate = '';
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for a new question and its input controls after Save.');
    }
    await delay(200);
  }
  return null;
}

async function answer(page: Page, messages: Locator, drawer: Locator, question: string): Promise<AnsweredQuestion> {
    const singleSelect = drawer.locator('.singleselect-radiobutton-container:visible');
    const isSingleSelect = await singleSelect.isVisible();
    const multiSelect = drawer.locator('.multicheckboxes-container:visible');
    const isMultiSelect = await multiSelect.isVisible();
    if (isSingleSelect && isMultiSelect) throw new Error('Multiple answer controls are visible.');
    let options: string[] = [];
    if (isSingleSelect || isMultiSelect) {
      const labels = isMultiSelect ? multiSelect.locator('.mcc__label') : singleSelect.locator('.ssrc__label');
      await labels.first().waitFor({ state: 'visible', timeout: 5000 });
      options = (await labels.allTextContents()).map((text) => text.trim());
    }
    if ((isSingleSelect || isMultiSelect) && options.length === 0) {
      throw new Error('No selection options found.');
    }
    // npm run login executes this file from invited/dist; the utility is ESM.
    const moduleUrl = pathToFileURL(
      path.resolve(__dirname, '../../invited-main/dist/getAnswer.js'),
    ).href;
    const { getAnswer } = await import(moduleUrl);
    const answer: string | string[] = isMultiSelect
      ? await getAnswer(question, { type: 'multi-select', options })
      : isSingleSelect
        ? await getAnswer(question, { type: 'single-select', options })
        : await getAnswer(question);
    const currentQuestion = (await messages.locator('ul li').last()
      .locator('div > div > span').allTextContents()).join(' ').trim();
    if (currentQuestion !== question) {
      throw new Error('Question changed while awaiting the answer; nothing was submitted.');
    }
    await page.bringToFront();
    console.log('Answer:', answer);
    if (isMultiSelect) {
      if (!Array.isArray(answer) || answer.length === 0 || answer.some((value) => !options.includes(value))) {
        throw new Error('Invalid checkbox selections returned.');
      }
      const checkboxes = multiSelect.locator('input[type="checkbox"]');
      if (await checkboxes.count() !== options.length) {
        throw new Error('Checkbox inputs do not match the displayed options.');
      }
      for (const [index, option] of options.entries()) {
        const checkbox = checkboxes.nth(index);
        const shouldBeChecked = answer.includes(option);
        await checkbox.evaluate((element, checked) => {
          const input = element as HTMLInputElement;
          if (input.disabled) throw new Error('Checkbox is disabled.');
          if (input.checked !== checked) input.click();
        }, shouldBeChecked);
        const deadline = Date.now() + 5000;
        while (await checkbox.isChecked() !== shouldBeChecked) {
          if (Date.now() >= deadline) throw new Error(`Checkbox "${option}" did not update.`);
          await delay(100);
        }
      }
    } else if (typeof answer !== 'string') {
      throw new Error('Expected a text or single-select answer.');
    } else if (isSingleSelect) {
      const radio = singleSelect.getByRole('radio', { name: answer, exact: true });
      if (!(await radio.isChecked())) {
        await singleSelect.getByText(answer, { exact: true }).click();
      }
      if (!(await radio.isChecked())) {
        throw new Error(`Radio option "${answer}" was not selected after clicking its label.`);
      }
    } else {
      await drawer.locator('.chatbot_SendMessageContainer .textArea[contenteditable="true"]:visible')
        .fill(answer);
    }
    await drawer.locator('.sendMsgbtn_container .sendMsg:visible')
      .filter({ hasText: /^\s*Save\s*$/ }).click();
    return { question, answer };
}

async function hoverJobs(page: Page) {
  const focusSession = await page.context().newCDPSession(page);
  try {
    await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const completed = new Set<string>();
    if (page.url() !== 'https://www.naukri.com/mnjuser/homepage') {
      await page.goto('https://www.naukri.com/mnjuser/homepage', {
        waitUntil: 'domcontentloaded',
      });
    }
  
    while (!page.isClosed()) {
      await openInvites(page);
  
      const all = page.getByText(/^All\s*\(\d+\)$/);
      await all.waitFor({ state: 'visible', timeout: 15_000 });
      if (/\(0\)$/.test(await all.innerText())) {
        console.log('No invitations remaining.');
        return;
      }
      await all.click();
      const cards = page.locator('.inbox-card-wrapper');
      await cards.first().waitFor({ state: 'visible', timeout: 15_000 });
  
      let selected: Locator | undefined;
      let selectedId = '';
      while (!selected) {
        const eligibleCards = cards.filter({ hasNot: page.locator('.apply.tag') });
        for (let index = 0; index < await eligibleCards.count(); index++) {
          const card = eligibleCards.nth(index);
          const id = await card.getAttribute('data-mailid') ||
            await card.locator('[data-mailid]').first().getAttribute('data-mailid');
          if (!id) throw new Error('Invitation has no data-mailid; cannot safely track completed jobs.');
          if (!completed.has(id)) {
            selected = card;
            selectedId = id;
            break;
          }
        }
        if (selected) break;
        // Check for more cards before treating the loaded list as exhausted.
        const count = await cards.count();
        await cards.last().scrollIntoViewIfNeeded();
        const grew = await page.waitForFunction(
          (count) => document.querySelectorAll('.inbox-card-wrapper').length > count,
          count, { timeout: 5000 },
        ).then(() => true).catch(() => false);
        if (!grew) {
          console.log('No eligible invitations remaining.');
          return;
        }
      }
  
      await selected.click();
      const startUrl = page.url();
      await page.locator('.apply-btn').click();
      const drawer = page.locator('.chatbot_DrawerContentWrapper, [class*="chatbot_DrawerContentWrapper"]');
      const messages = drawer.locator('.chatbot_MessageContainer, [class*="chatbot_MessageContainer"]');
      let previous: AnsweredQuestion | undefined;
      while (!page.isClosed() && page.url() === startUrl) {
        try {
          const question = await waitForNextQuestion(page, messages, drawer, startUrl, previous);
          if (question === null) break;
          previous = await answer(page, messages, drawer, question);
        } catch (error) {
          if (page.isClosed() || page.url() !== startUrl) break;
          // Navigation can destroy the context before page.url() changes.
          // The saveApply wait below confirms completion before the next job.
          if (error instanceof Error && error.message.includes('Execution context was destroyed')) {
            break;
          }
          throw error;
        }
      }
      if (page.isClosed()) return;
      await page.waitForURL(
        (url) => url.origin === 'https://www.naukri.com' && url.pathname === '/myapply/saveApply',
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );
      completed.add(selectedId);
      console.log('Reached saveApply. Opening Jobs → NVites for the next job.');
    }
  } finally {
    await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    await focusSession.detach().catch(() => {});
  }
}

async function recordAfterLogin(
  page: Page,
  enabled = process.argv.includes("--codegen"),
) {
  if (!enabled) return;
  // Playwright intentionally skips page.pause() while Node's debugger is active.
  // VS Code Auto Attach can enable it even when this script runs in a terminal.
  if (inspector.url()) {
    console.log(
      "Detaching the Node/IDE debugger so Playwright Inspector can open.",
    );
    inspector.close();
  }
  console.log(
    "Opening Playwright Inspector. Click Record, then perform actions in the logged-in browser.",
  );
  console.log("Copy the generated code before clicking Resume.");
  await page.bringToFront();
  await page.pause();
}

async function loginWithNativeChrome() {
  if (!process.stdin.isTTY)
    throw new Error("Run native login from an interactive terminal.");
  const executable =
    process.env.CHROME_PATH ??
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined);
  if (!executable)
    throw new Error("Set CHROME_PATH to your Chrome executable.");

  // Reserve an available loopback port before launching our own dedicated browser.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a debugging port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  const authDirectory = path.join(__dirname, "..", "playwright", ".auth");
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  const chrome = spawn(
    executable,
    [
      `--user-data-dir=${path.join(authDirectory, "native-chrome-profile")}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...backgroundChromeArgs,
      "https://www.naukri.com/nlogin/login",
    ],
    { stdio: "ignore" },
  );
  let launchError: Error | undefined;
  chrome.on("error", (error) => {
    launchError = error;
  });
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let ready = false;
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (launchError) throw launchError;
      if (chrome.exitCode !== null)
        throw new Error(
          "Chrome exited. Close any previous native-login window and try again.",
        );
      try {
        const response = await fetch(`${endpoint}/json/version`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Chrome may still be starting. */
      }
      await delay(500);
    }
    if (!ready)
      throw new Error(
        "Chrome debugging endpoint did not start. Close any previous native-login window and try again.",
      );
    console.log("Chrome is open. Playwright has NOT attached yet.");
    console.log(
      "Log in with email + password, then enter the verification code sent to your email.",
    );
    const answer = await terminal.question(
      "Once your logged-in homepage is visible, press Enter here (or type cancel): ",
    );
    if (answer.trim().toLowerCase() === "cancel") return;
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome did not expose a browser context.");
    const page = context.pages().find((candidate) => {
      const hostname = new URL(candidate.url()).hostname;
      return hostname === "naukri.com" || hostname.endsWith(".naukri.com");
    });
    if (!page) throw new Error("No Naukri tab found.");
    const confirmed = await page
      .getByRole("link", { name: /^(view|complete|update) profile$/i })
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    if (confirmed) {
      const authPath = path.join(authDirectory, "naukri.json");
      await writeFile(
        authPath,
        JSON.stringify(await context.storageState(), null, 2),
        { mode: 0o600 },
      );
      console.log(`Login confirmed. Session saved to ${authPath}`);
      console.log(
        "Recorder mode (--codegen): automatic Apply clicks are disabled. Run without --codegen to apply.",
      );
      debugger
      await hoverJobs(page);
      // await applyInvitesSequentially(page, hoverJobs, (question) =>
      //   terminal.question(question),
      // );
    } else {
      console.log(
        "Profile link not found. Login is unverified; opening the recorder on the current page without overwriting saved session data.",
      );
    }
    await recordAfterLogin(
      page,
      process.argv.includes("--codegen") || !confirmed,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Native login/recorder failed.",
    );
    process.exitCode = 1;
  } finally {
    // Neither a missing selector nor returning from the Inspector should close Chrome.
    if (ready && chrome.exitCode === null && chrome.signalCode === null) {
      let answer = "";
      while (answer.trim().toLowerCase() !== "close") {
        answer = await terminal.question(
          "Chrome stays open. Type close and press Enter when you are finished: ",
        );
      }
    }
    terminal.close();
    if (browser) await browser.close().catch(() => {});
    chrome.kill("SIGTERM");
  }
}

async function loginToNaukri() {
  const email = process.env.NAUKRI_EMAIL;
  const password = process.env.NAUKRI_PASSWORD;
  const manual = process.argv.includes("--manual");
  if (process.argv.includes("--otp")) {
    throw new Error(
      "Use npm run login for email/password followed by email verification, or --manual to enter both yourself.",
    );
  }
  if (!manual && (!email || !password)) {
    throw new Error(
      "Set NAUKRI_EMAIL and NAUKRI_PASSWORD before running npm run login.",
    );
  }

  const authDirectory = path.join(__dirname, "..", "playwright", ".auth");
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  // A dedicated profile preserves site state across runs without touching personal Chrome.
  const context = await chromium.launchPersistentContext(
    path.join(authDirectory, "chrome-profile"),
    {
      channel: "chrome",
      headless: false,
      args: backgroundChromeArgs,
    },
  );
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // Log metadata only: never log request bodies, headers, cookies, or URL queries.
    page.on("response", (response) => {
      const request = response.request();
      if (
        ["xhr", "fetch"].includes(request.resourceType()) ||
        response.status() >= 400
      ) {
        console.log(
          `[HTTP] ${request.method()} ${new URL(response.url()).origin} ${request.resourceType()} -> ${response.status()}`,
        );
      }
    });
    page.on("requestfailed", (request) => {
      console.error(
        `[NETWORK] ${request.method()} ${new URL(request.url()).origin} ${request.resourceType()} ${request.failure()?.errorText}`,
      );
    });
    page.on("pageerror", (error) => {
      console.error(`[PAGE] Uncaught ${error.name}; a site script failed.`);
    });
    page.setDefaultTimeout(30_000);
    await page.goto("https://www.naukri.com/nlogin/login", {
      waitUntil: "load",
    });
    const profile = page
      .getByRole("link", { name: /^(view|complete|update) profile$/i })
      .first();
    if (!manual && !(await profile.isVisible())) {
      await page
        .locator(
          '#usernameField, input[placeholder="Enter your active Email ID / Username"]',
        )
        .first()
        .fill(email!);
      await page
        .locator('#passwordField, input[placeholder="Enter your password"]')
        .first()
        .fill(password!);
      await page.getByRole("button", { name: /^login$/i }).click();
    }

    console.log(
      "Complete login (including OTP or CAPTCHA) in the browser. Waiting up to 5 minutes for your profile link...",
    );
    // Confirm account UI before saving cookies; a redirect alone may not mean success.
    try {
      const loggedIn = page
        .getByRole("link", { name: /^(view|complete|update) profile$/i })
        .first()
        .waitFor({ state: "visible", timeout: 300_000 });
      const loginError = page.getByText(
        "Something went wrong. Please try again.",
        { exact: true },
      );
      const result = await Promise.race([
        loggedIn.then(() => "success"),
        loginError
          .waitFor({ state: "visible", timeout: 300_000 })
          .then(() => "error"),
      ]);
      if (result === "error") {
        console.error(
          "Naukri says: Something went wrong. Please try again. The cause is unknown.",
        );
        console.log(
          "Inspect the [HTTP], [NETWORK], and [PAGE] lines above. You can retry email/password manually in this window and enter the emailed verification code. No automatic retries will be sent.",
        );
        await loggedIn;
      }
    } catch {
      throw new Error(
        "Login was not confirmed. Check credentials, complete verification, or update the profile-link selector if Naukri changed its UI.",
      );
    }

    const authPath = path.join(authDirectory, "naukri.json");
    const state = await context.storageState();
    await writeFile(authPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    console.log(`Login successful. Session saved to ${authPath}`);
    if (process.argv.includes("--codegen")) {
      console.log(
        "Recorder mode (--codegen): automatic Apply clicks are disabled. Run without --codegen to apply.",
      );
      await hoverJobs(page);
      await recordAfterLogin(page, true);
    } else {
      if (!process.stdin.isTTY)
        throw new Error(
          "Run in an interactive terminal to answer chatbot questions.",
        );
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        // await applyInvitesSequentially(page, hoverJobs, (question) =>
        //   terminal.question(question),
        // );
      } finally {
        terminal.close();
      }
    }
  } finally {
    await context.close();
  }
}

const login = process.argv.includes("--native")
  ? loginWithNativeChrome
  : loginToNaukri;
login().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Naukri login failed.",
  );
  process.exitCode = 1;
});
