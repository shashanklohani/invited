const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { lastQuestion } = require('./dist/applyInvites');

test('reads last question while ignoring answer echoes and typing indicators', () => {
  assert.equal(lastQuestion(['Notice period?', '30 days', '...'], ['30 days']).text, 'Notice period?');
  assert.equal(lastQuestion(['Notice period?', '30 days', 'Current location?'], ['30 days']).text, 'Current location?');
  assert.equal(lastQuestion(['...', ''], []), null);
});

test('asks sequential questions, records answers, refreshes and skips claimed invites', async () => {
  // Load the compiled module in an isolated directory so no real application
  // history or browser is touched by this test.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naukri-flow-test-'));
  try {
    await fs.mkdir(path.join(root, 'dist'));
    await fs.copyFile(path.join(__dirname, 'dist/applyInvites.js'), path.join(root, 'dist/applyInvites.js'));
    const { applyInvitesSequentially } = require(path.join(root, 'dist/applyInvites.js'));
    const stateDirectory = path.join(root, 'playwright/.auth');
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.writeFile(path.join(stateDirectory, 'invite-ledger.json'), JSON.stringify({ version: 1, invitations: { 'invite:old': { status: 'uncertain' } } }));

    let chat = false;
    let completed = false;
    let filled = '';
    let refreshes = 0;
    const sent = [];
    const clicked = [];
    const messages = ['Notice period?'];
    const chain = { first() { return this; }, waitFor: async () => {} };
    const editor = { count: async () => 1, isEditable: async () => true, fill: async value => { filled = value; } };
    const send = { count: async () => 1, click: async () => {
      sent.push(filled);
      messages.push(filled);
      if (sent.length === 1) messages.push('Current location?');
      else { chat = false; completed = true; }
    } };
    const drawer = {
      filter() { return this; }, first() { return this; }, isVisible: async () => chat,
      locator: selector => selector.includes('ul li') ? { allTextContents: async () => [...messages] } : editor,
      getByRole: () => send,
    };
    const details = {
      getByText: text => typeof text === 'string' ? chain : { first: () => ({ isVisible: async () => completed }) },
      locator: () => ({ waitFor: async () => {}, click: async options => {
        if (options?.trial) return;
        clicked.push('apply'); chat = true;
      } }),
    };
    const page = Object.assign(new EventEmitter(), {
      isClosed: () => false,
      mainFrame: () => page,
      locator: selector => selector.includes('chatbot_') ? drawer : details,
    });
    const card = id => ({
      locator: selector => selector === '[data-mailid]' ? { getAttribute: async () => id } : { innerText: async () => 'Test role' },
      click: async () => { clicked.push(id); },
    });
    const responses = ['30 days', 'Pune'];
    await applyInvitesSequentially(page, async () => { refreshes++; return [card('old'), card('new')]; }, async () => responses.shift());
    assert.deepEqual(clicked, ['new', 'apply']);
    assert.deepEqual(sent, ['30 days', 'Pune']);
    assert.equal(refreshes, 2);
    const records = (await fs.readFile(path.join(stateDirectory, 'chatbot-answers.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(r => [r.question, r.answer]), [['Notice period?', '30 days'], ['Current location?', 'Pune']]);
    const ledger = JSON.parse(await fs.readFile(path.join(stateDirectory, 'invite-ledger.json'), 'utf8'));
    assert.equal(ledger.invitations['invite:new'].status, 'submitted');
    assert.equal(ledger.invitations['invite:old'].status, 'uncertain');
    await assert.rejects(fs.access(path.join(stateDirectory, 'invite-ledger.lock')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
