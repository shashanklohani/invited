import type { Frame, Locator, Page } from 'playwright';
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type Prompt = (question: string) => Promise<string>;
type Ledger = { version: 1; invitations: Record<string, { status: string; updatedAt: string; error?: string }> };
const drawerSelector = '.chatbot_DrawerContentWrapper, [class*="chatbot_DrawerContentWrapper"]';
const messagesSelector = '.chatbot_MessageContainer ul li, [class*="chatbot_MessageContainer"] ul li';

export function lastQuestion(messages: string[], answers: string[]) {
  // Ignore an echoed user answer and transient typing indicators.
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = messages[index].trim();
    if (text && !/^(?:\.{1,3}|…|typing\.{0,3})$/i.test(text) && !answers.includes(text)) {
      return { text, key: `${index}:${text}` };
    }
  }
  return null;
}

export async function applyInvitesSequentially(
  page: Page,
  refreshInvites: (page: Page) => Promise<Locator[]>,
  ask: Prompt,
) {
  const directory = path.join(__dirname, '..', 'playwright', '.auth');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ledgerPath = path.join(directory, 'invite-ledger.json');
  const answersPath = path.join(directory, 'chatbot-answers.jsonl');
  const lockPath = path.join(directory, 'invite-ledger.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Invitation ledger is locked. Stop the previous run before removing a stale invite-ledger.lock; keep the ledger and answers files.');
    throw error;
  });
  let navigation = 0;
  const onNavigation = (frame: Frame) => { if (frame === page.mainFrame()) navigation++; };
  page.on('framenavigated', onNavigation);
  try {
    let ledger: Ledger;
    try {
      ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
      if (ledger.version !== 1 || !ledger.invitations || typeof ledger.invitations !== 'object' || Array.isArray(ledger.invitations)) {
        throw new Error('Invalid invitation ledger. Refusing to overwrite it.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ledger = { version: 1, invitations: {} };
    }
    const mark = async (id: string, status: string, error?: string) => {
      ledger.invitations[`invite:${id}`] = { status, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) };
      await writeFile(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600 });
      await rename(`${ledgerPath}.tmp`, ledgerPath);
    };

    while (!page.isClosed()) {
      // Always fetch fresh locators after the previous application changes the UI.
      const invites = await refreshInvites(page);
      console.log(`Found ${invites.length} unread invitation cards. Checking previous attempts...`);
      let selected: { card: Locator; id: string; index: number } | undefined;
      for (let index = 0; index < invites.length; index++) {
        const id = await invites[index].locator('[data-mailid]').getAttribute('data-mailid');
        if (!id) throw new Error('An invitation has no data-mailid; stopping to avoid duplicate clicks.');
        if (!Object.hasOwn(ledger.invitations, `invite:${id}`)) {
          selected = { card: invites[index], id, index };
          break;
        }
        console.log(`Skipping invitation ${index}: already recorded as ${ledger.invitations[`invite:${id}`].status}.`);
      }
      if (!selected) {
        console.log('No new unprocessed invitations in the loaded unread list. Previous attempts are skipped.');
        return;
      }
      const { card, id, index } = selected;
      await mark(id, 'in_progress'); // Claim before clicking, including across restarts.
      let applied = false;
      try {
        const title = (await card.locator('.title').innerText()).trim();
        console.log(`Opening invitation ${index}: ${title}`);
        await card.click();
        const details = page.locator('.card-details-container');
        await details.getByText(title, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
        const apply = details.locator('.apply-btn');
        debugger
        console.log('Waiting for the selected invitation\'s .apply-btn...');
        await apply.waitFor({ state: 'visible', timeout: 15_000 });
        // Check actionability before recording a possible submission attempt.
        await apply.click({ trial: true, timeout: 15_000 });
        let baseline = navigation;
        await mark(id, 'applying');
        applied = true;
        console.log(`Clicking Apply for invitation ${index}...`);
        await apply.click({ timeout: 15_000 });
        console.log('Apply click completed. Waiting for chatbot, navigation, or confirmation.');

        const answered = new Set<string>();
        const answers: string[] = [];
        let deadline = Date.now() + 60_000;
        let movedAt: number | undefined;
        let finished = false;
        while (Date.now() < deadline && !page.isClosed()) {
          const drawer = page.locator(drawerSelector).filter({ visible: true }).first();
          if (await drawer.isVisible()) {
            // A redirect can lead into the chatbot: finish its questions first.
            baseline = navigation;
            movedAt = undefined;
            const messages = await drawer.locator(messagesSelector).allTextContents();
            const question = lastQuestion(messages, answers);
            if (question && !answered.has(question.key)) {
              console.log(`\nChatbot question: ${question.text}`);
              const answer = await ask('Your answer (or /stop to stop): ');
              if (answer.trim() === '/stop') throw new Error('Stopped at your request; application not retried.');
              if (!answer.trim()) { deadline = Date.now() + 60_000; continue; }
              // The browser may change while the user is typing. Never send an
              // answer to a different question after a redirect or rerender.
              const current = lastQuestion(await drawer.locator(messagesSelector).allTextContents(), answers);
              if (current?.key !== question.key) throw new Error('Question changed while awaiting your answer; nothing was sent.');
              await appendFile(answersPath, JSON.stringify({ inviteId: id, question: question.text, answer, recordedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });

              const editor = drawer.locator('textarea:visible, input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]):visible, [contenteditable="true"]:visible');
              if (await editor.count() === 1 && await editor.isEditable()) {
                await editor.fill(answer);
                const send = drawer.getByRole('button', { name: /^(?:send|submit|next|continue)(?: answer| message)?$/i });
                if (await send.count() === 1) {
                  await send.click();
                } else {
                  // Do not guess whether Enter submits or inserts a newline.
                  if ((await ask('Answer filled. Click Send in the browser, then press Enter here (or /stop): ')).trim() === '/stop') throw new Error('Stopped at your request.');
                }
              } else {
                // Choice/date/custom widgets need the user to select the exact answer.
                if ((await ask('Answer recorded. Select/type and submit that answer in the browser, then press Enter here (or /stop): ')).trim() === '/stop') throw new Error('Stopped at your request.');
              }
              answers.push(answer.trim());
              answered.add(question.key);
              deadline = Date.now() + 60_000;
            }
          } else if (navigation !== baseline) {
            // Allow a newly navigated page to show a chatbot before going back.
            movedAt ??= Date.now();
            if (Date.now() - movedAt >= 1_500) {
              await mark(id, 'redirected'); // Navigation is not proof of submission.
              console.log('Page navigated/reloaded. Returning to unread invitations.');
              finished = true;
              break;
            }
          } else {
            const success = details.getByText(/^(?:Applied|Successfully applied|Application (?:sent|submitted)(?: successfully)?)[.!]?$/i).first();
            if (await success.isVisible()) {
              await mark(id, 'submitted');
              finished = true;
              break;
            }
          }
          await delay(300);
        }
        if (!finished) throw new Error('No next question, redirect, reload, or submission confirmation detected. Stopping for inspection.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await mark(id, applied ? 'uncertain' : 'failed', message);
        throw error;
      }
    }
  } finally {
    page.off('framenavigated', onNavigation);
    await lock.close();
    await unlink(lockPath);
  }
}
