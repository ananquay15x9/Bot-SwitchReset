const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: process.env.NODE_ENV === 'production' ? true : false,
  args: ['--no-sandbox'] });
  const page = await browser.newPage();

  console.log("🚀 Logging into iSite Portal...");
  await page.goto('https://portal.isitemediagroup.com/users/sign_in');
  await page.getByRole('textbox', { name: 'Email' }).fill('tle@isitemediagroup.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('Ahihi123456?');
  await page.getByRole('button', { name: 'Sign In' }).click();
  
  await page.waitForURL('**/portal');
  console.log("✅ Logged in.");

  await page.goto('https://portal.isitemediagroup.com/venues');
  await page.waitForSelector('table');

  const venueLinks = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr')).slice(1);
    return rows.map(row => {
      const nameCell = row.querySelector('td:first-child');
      const venueLink = nameCell?.querySelector('a')?.href;
      const venueId = venueLink ? venueLink.split('/').pop() : null;
      return {
        name: nameCell?.innerText.trim(),
        manageDevicesUrl: venueId ? `https://portal.isitemediagroup.com/venues/${venueId}/devices` : null
      };
    }).filter(v => v.name && v.manageDevicesUrl);
  });

  console.log(`📊 Found ${venueLinks.length} venues to sync.`);

  const finalOutput = [];
  let csvContent = "Venue,Serial,Port,Location,Group\n";

  for (const venue of venueLinks) {
    if (venue.name === 'iSite Office' || venue.name === 'Mizzou: Faurot Field') continue;

    console.log(`📥 Syncing: ${venue.name}...`);
    let allSwitchesForVenue = [];
    
    try {
      await page.goto(venue.manageDevicesUrl);
      
      let hasNextPage = true;
      while (hasNextPage) {
        await page.waitForSelector('#sort_table tbody tr', { timeout: 10000 });

        const switchesOnPage = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('#sort_table tbody tr'));
          return rows.map(row => {
            const cells = row.querySelectorAll('td');
            const piSerial = cells[7]?.innerText.trim() || "";
            const location = cells[1]?.innerText.trim() || "";
            const portRaw = cells[3]?.innerText.trim() || "";
            const group = cells[5]?.innerText.trim() || "";
            const portMatch = portRaw.match(/\d+/);
            
            return {
              serial: piSerial,
              port: portMatch ? portMatch[0] : "N/A",
              location: location,
              group: group
            };
          }).filter(s => s.serial && s.serial.length > 5);
        });

        allSwitchesForVenue = allSwitchesForVenue.concat(switchesOnPage);


        const nextButton = page.locator('a.next_page');
        if (await nextButton.isVisible() && !(await nextButton.getAttribute('class')).includes('disabled')) {
          console.log(`➡️ Moving to next page for ${venue.name}...`);
          await nextButton.click();

          await page.waitForTimeout(2000); 
        } else {
          hasNextPage = false;
        }
      }

      finalOutput.push({
        venue: venue.name,
        switches: allSwitchesForVenue
      });

      allSwitchesForVenue.forEach(s => {
        csvContent += `"${venue.name}","${s.serial}","${s.port}","${s.location}","${s.group}"\n`;
      });

      console.log(`✅ Captured ${allSwitchesForVenue.length} total devices for ${venue.name}.`);
    } catch (err) {
      console.log(`⚠️ Error syncing ${venue.name}: ${err.message}`);
    }
  }

  // write to json and csv
  fs.writeFileSync('all-switch-list.json', JSON.stringify(finalOutput, null, 2));
  fs.writeFileSync('all-switch-list.csv', csvContent);

  console.log("\n✨ Master Sync Complete!");
  console.log("📁 Created 'all-switch-list.json'");
  console.log("📁 Created 'all-switch-list.csv'");

  await browser.close();
})();