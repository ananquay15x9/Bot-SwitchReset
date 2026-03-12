// first run this script to get all the down switches in the list

const { chromium } = require('playwright');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const fs = require('fs');

const LOGS_DIR = path.join(__dirname, '../../logs');
const SCAN_FILE = path.join(LOGS_DIR, 'down-devices-list.json');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

(async () => {
  // headless-friendly
  const browser = await chromium.launch({
  headless: process.env.NODE_ENV === 'production' ? true : false,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
  const context = await browser.newContext();
  const page = await browser.newPage();

  // let the bot login
  await page.goto('https://portal.isitemediagroup.com/users/sign_in');
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.PORTAL_EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PORTAL_PWD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL('**/portal');

  await page.waitForLoadState('networkidle');

  // venues with down devices
  const venues = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#dashboard-admin-issues-content table tr')).slice(1);
    return rows.map(row => {
      const cells = row.querySelectorAll('td');
      return {
        name: cells[0]?.innerText.trim(),
        url: cells[0]?.querySelector('a')?.href,
        disconnected: parseInt(cells[2]?.innerText) || 0
      };
    }).filter(v =>
        v.disconnected > 0 &&
        v.name !== 'iSite Office' &&
        v.name !== 'Mizzou: Faurot Field'
    ); // skip iSite Office and Mizzou Faurot Field
  });

  const finalOutput = [];

  // pulling all devices data
  for (const venue of venues) {
    console.log(`Pulling ${venue.name}...`);
    const cacheBuster = `${venue.url}${venue.url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    await page.goto(cacheBuster, { waitUntil: 'networkidle' });

    await page.waitForSelector('#sort_table tbody tr', { timeout: 15000 });

    const switches = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#sort_table tbody tr'));
      
      return rows.map(row => {
        const cells = row.querySelectorAll('td');

        
        const piSerial = cells[7]?.innerText.trim() || "";
        const location = cells[1]?.innerText.trim() || "";
        const portRaw = cells[3]?.innerText.trim() || "";
        const group = cells[5]?.innerText.trim() || "";

        const portMatch = portRaw.match(/Port\s+(\d+)/i);
        
        return {
          serial: piSerial,
          port: portMatch ? portMatch[1] : "N/A",
          location: location,
          group: group
        };
      }).filter(s => s.serial && s.serial.length > 5); 
    });

    finalOutput.push({
      venue: venue.name,
      switches: switches
    });
  }

  // write to json
  fs.writeFileSync(SCAN_FILE, JSON.stringify(finalOutput, null, 2));
  console.log("DOWN DEVICES in logs/down-devices-list.json 🥲" );

  await browser.close();
})();