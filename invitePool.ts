import type { Page } from 'playwright';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

type Status = 'in_progress' | 'applying' | 'submitted' | 'failed' | 'uncertain';
type Entry = { status: Status; updatedAt: string; error?: string };
type Ledger = { version: 1; invitations: Record<string, Entry> };

// Each worker takes its next job as soon as its previous job finishes.
export async function rollingPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency.');
  let next = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const item = items[next++]; // Claim synchronously, before any await.
      try { await work(item); }
      catch (error) { stopped = true; throw error; }
    }
  });
  // Let active workers finish before releasing the ledger lock, even on failure.
  const results = await Promise.allSettled(workers);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function processUnreadInvites(page: Page) {
  const idAttribute = process.env.NAUKRI_INVITE_ID_ATTRIBUTE ?? 'data-mailid';
  const cardSelector = `.inbox-card-wrapper [${idAttribute}], inbox-card-wrapper [${idAttribute}]`;
  const successSelector = process.env.NAUKRI_APPLY_SUCCESS_SELECTOR;
  if (!/^[a-zA-Z_][\w:-]*$/.test(idAttribute)) throw new Error('Invalid invitation ID attribute name.');

  const directory = path.join(__dirname, '..', 'playwright', '.auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ledgerPath = path.join(directory, 'invite-ledger.json');
  const lockPath = path.join(directory, 'invite-ledger.lock');
  // Exclusive creation prevents two script instances from applying simultaneously.
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error(`Another run owns ${lockPath}. If a previous run crashed, verify it has stopped before removing only this lock file. Keep invite-ledger.json.`);
    throw error;
  });
  let writes: Promise<void> = Promise.resolve();
  try {
    let ledger: Ledger;
    try {
      ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      if (ledger.version !== 1 || !ledger.invitations || typeof ledger.invitations !== 'object' || Array.isArray(ledger.invitations)) {
        throw new Error('Invalid ledger; refusing to overwrite application history.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ledger = { version: 1, invitations: {} };
    }

    async function mark(id: string, status: Status, error?: string) {
      // Prefix prevents IDs such as __proto__ from becoming special object keys.
      ledger.invitations[`invite:${id}`] = { status, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) };
      const snapshot = JSON.stringify(ledger, null, 2);
      writes = writes.then(async () => {
        await writeFile(`${ledgerPath}.tmp`, snapshot, { mode: 0o600 });
        await rename(`${ledgerPath}.tmp`, ledgerPath);
      });
      await writes; // Never click until the claim is durably written to the ledger file.
    }

    async function showUnread(target: Page) {
      await target.goto('https://www.naukri.com/mnjuser/inbox', { waitUntil: 'domcontentloaded' });
      const unread = target.getByText(/^Unread\s*\(\d+\)$/);
      await unread.click();
      return Number((await unread.innerText()).match(/\((\d+)\)/)?.[1]);
    }

    console.log('Opening NVites and loading unread invitations...');
    page.setDefaultTimeout(15_000);
    const expected = await showUnread(page);
    if (!Number.isInteger(expected)) throw new Error('Could not read the unread invitation count.');
    if (!expected) { console.log('No unread invitations.'); return; }
    const cards = page.locator(cardSelector);
    await cards.first().waitFor({ state: 'visible', timeout: 15_000 });
    // Support lazy loading by scrolling the final loaded card. Do not silently
    // process a partial list if the site instead requires pagination controls.
    let previousCount = -1;
    for (let attempts = 0; attempts < 100; attempts++) {
      const count = await cards.count();
      if (count >= expected) break;
      if (count === previousCount) break;
      previousCount = count;
      await cards.last().scrollIntoViewIfNeeded();
      await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length > count,
        { selector: cardSelector, count }, { timeout: 5_000 }).catch(() => {});
    }
    const ids = await cards.evaluateAll((elements, attribute) => elements.map(element => element.getAttribute(attribute)), idAttribute);
    // Opening the inbox automatically selects/marks one item read, so its
    // displayed count can fall while that card remains in the rendered list.
    if (ids.length < expected || ids.some(id => !id) || new Set(ids).size !== ids.length) {
      throw new Error(`Need ${expected} fully loaded, uniquely identified invitations; found ${ids.length} cards. Verify NAUKRI_INVITE_ID_ATTRIBUTE (currently ${idAttribute}) and pagination. No invitations clicked.`);
    }
    const queue = (ids as string[]).filter(id => !Object.hasOwn(ledger.invitations, `invite:${id}`));
    console.log(`Queued ${queue.length} invitations; skipped ${ids.length - queue.length} previously claimed invitations.`);
    if (!queue.length) {
      console.log(`No unclaimed invitations remain. Previous failures and interrupted attempts are preserved in ${ledgerPath}; they will not be clicked again automatically.`);
      return;
    }

    await rollingPool(queue, 4, async id => {
      await mark(id, 'in_progress');
      let tab: Page | undefined;
      let applying = false;
      let submitted = false;
      try {
        tab = await page.context().newPage();
        console.log(`Opened worker tab for invitation ${id}.`);
        tab.setDefaultTimeout(15_000);
        await tab.goto('https://www.naukri.com/mnjuser/inbox', { waitUntil: 'domcontentloaded' });
        // Search All: opening the inbox can mark an item read automatically,
        // and unread membership changes while other workers are running.
        const allFilter = tab.locator('#all');
        await allFilter.waitFor({ state: 'visible' });
        if (!(await allFilter.evaluate(element => element.classList.contains('active')))) {
          await allFilter.click();
        }
        const workerCards = tab.locator(cardSelector);
        await workerCards.first().waitFor({ state: 'visible' });
        const escapedId = await tab.evaluate(value => CSS.escape(value), id);
        const target = tab.locator(`:is(${cardSelector})[${idAttribute}="${escapedId}"]`);
        // Search by ID, never by mutable position in the unread list.
        for (let attempts = 0; !(await target.count()) && attempts < 100; attempts++) {
          const count = await workerCards.count();
          if (!count) break;
          await workerCards.last().scrollIntoViewIfNeeded();
          const grew = await tab.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length > count,
            { selector: cardSelector, count }, { timeout: 5_000 }).then(() => true, () => false);
          if (!grew) break;
        }
        if (await target.count() !== 1) throw new Error('Invitation is missing or its ID is not unique.');
        const title = (await target.locator('.title').innerText()).trim();
        const company = (await target.locator('.comp-name').innerText()).trim();
        await target.click();
        // The old detail panel can remain visible while the new one renders.
        const details = tab.locator('.card-details-container');
        await details.getByText(title, { exact: true }).first().waitFor({ state: 'visible' });
        await details.getByText(company, { exact: true }).first().waitFor({ state: 'visible' });
        const apply = details.locator('.apply-btn, apply-btn');
        await apply.waitFor({ state: 'visible' });
        const success = successSelector ? details.locator(successSelector) : details.getByText(
          /^(?:Applied|Already applied|Successfully applied|Application (?:sent|submitted)(?: successfully)?|You have successfully applied(?: to this job)?)[.!]?$/i,
        ).first();
        if (await success.isVisible()) throw new Error('Success element was already visible before Apply; check its selector.');
        await mark(id, 'applying');
        applying = true;
        await apply.click();
        await success.waitFor({ state: 'visible', timeout: 30_000 });
        await mark(id, 'submitted');
        submitted = true;
        console.log(`Submitted invitation ${id}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await mark(id, applying ? 'uncertain' : 'failed', message);
        console.error(`Invitation ${id}: ${applying ? 'uncertain' : 'failed'}; no automatic retry. ${message}`);
        throw new Error(`Worker stopped; its tab stays open for inspection. ${message}`);
      } finally {
        if (submitted) await tab?.close().catch(() => {});
      }
    });
    console.log(`Invitation processing finished. Review outcomes in ${ledgerPath}`);
  } finally {
    await writes.catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
