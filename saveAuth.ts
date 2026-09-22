import { chromium } from 'playwright';
import * as path from 'path';
import * as os from 'os';

async function saveSession() {
  // 1. Dynamically resolve your system's native Chrome User Data Path
  let userDataDir = '';
  const platform = os.platform();

  if (platform === 'win32') {
    userDataDir = path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data/Default');
  } else if (platform === 'darwin') {
    userDataDir = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default');
  } else {
    userDataDir = path.join(os.homedir(), '.config/google-chrome/Default');
  }

  console.log(`Using Chrome Profile Path: ${userDataDir}`);
  console.log('⚠️ CRITICAL: Make sure ALL regular Chrome windows are completely closed before continuing!');

  // 2. Launch your actual Chrome binary with strict anti-bot masking flags
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null, // Open in full screen sizing
    args: [
      '--disable-blink-features=AutomationControlled', // Hides the navigator.webdriver property
      '--start-maximized',
      '--no-sandbox'
    ]
  });

  const page = await context.newPage();
  
  // 3. Navigate to Naukri
  console.log('Navigating to Naukri Inbox...');
  await page.goto('https://naukri.com', { waitUntil: 'load' });

  // 4. Pause execution to let you complete any actions / verification
  console.log('\n✏️ INSTRUCTIONS:');
  console.log('1. Look at the opened browser window.');
  console.log('2. If you are not logged in, manually log in right now.');
  console.log('3. Once you are looking at your active Naukri Inbox page, go back to your terminal/terminal popup and click "Resume" (or close the page manually).');
  
  await page.pause(); 

  // 5. Extract and dump cookies, local storage, and session tokens safely into a file
  const authStatePath = path.join(__dirname, 'naukri-auth.json');
  await context.storageState({ path: authStatePath });
  
  console.log(`\n✅ Success! Session states and cookies saved securely to: ${authStatePath}`);
  
  await context.close();
}

saveSession().catch((err) => {
  console.error('❌ An error occurred:', err);
});
