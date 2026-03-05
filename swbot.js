const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline');
require('dotenv').config();


const askTerminal = (query) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
};

// Reformat the group bathroom
function normalizeGroupName(name) {
    if (!name) return "";
    let clean = name.trim();
    clean = clean.replace(/\s*Mens?$/i, 'M');
    clean = clean.replace(/\s*Womens?$/i, 'W');
    //remove extra space too
    clean = clean.replace(/\s+/g, '');
    return clean.toUpperCase();
}

//1. venue name mapping
const venueMap = {
    "Auburn - Neville Arena": "Auburn",
    "Baylor - Foster Pavilion": "Baylor",
    "Butler - Hinkle Fieldhouse": "Butler - Hinkle FH",
    "Canada Life Centre": "Canada Life Centre - WPG",
    "Capital One Arena": "Capital One",
    "Dicks Sporting Goods Park": "Dicks Sporting Goods",
    "iSite Office": "Office",
    "Louisville - KFC Yum! Center": "KFC Yum Center",
    "Maryland - Xfinity Center": "UMD - Xfinity Center",
    "Mizzou: Faurot Field": "Mizzou Faurot Field",
    "Old Dominion - Chartway Arena": "ODU - Chartway Arena",
    "Penn State: Bryce Jordan Center": "Penn State - BJC",
    "ScottsMiracle-Gro Field": "ScottsMiracleGro Field",
    "UNC - Dean Smith Center": "Dean Smith",
    "Villanova - Finneran Pavilion": "Villanova",
    "Virginia - John Paul Jones": "U of Virginia - JPJ",
    "Virginia Tech - Cassel Coliseum": "Virginia Tech"
};

(async () => {
    const userDataDir = './netgear_session';
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    const swList = JSON.parse(fs.readFileSync('switch-list.json', 'utf8'));

    console.log("🚀 Navigating to Netgear...");
    await page.goto('https://insight.netgear.com/#/landingPage');


    if (await page.isVisible('#loginNow')) await page.click('#loginNow');

    // 2. login field
    try {
        // check if we land on the Dashboard
        const authState = await Promise.race([
            page.waitForFunction(() =>
                window.location.href.includes('dashboard') ||
                window.location.href.includes('code='),
                { timeout: 120000 }
            ).then(() => 'LOGGED_IN'),

            //needs login
            page.waitForSelector('input[formcontrolname="email"]', { timeout: 10000 }).then(() => 'NEEDS_LOGIN'),

            // needs phone selection
            page.waitForSelector('#try3', { timeout: 10000 }).then(() => 'NEEDS_MFA')
        ]);

        if (authState === 'LOGGED_IN') {
            console.log('✅ Session active. Skipping Login and MFA.')
        } else {
            // who are you
            console.log("\n👤 MFA Setup Required:");
            console.log("1) Ruben (SMS to *7166)");
            console.log("2) Tu (SMS to *6646)");
            const userChoice = await askTerminal("Who are you? (Type 1 or 2): ");

            if (authState === 'NEEDS_LOGIN') {
                 await page.waitForSelector('input[formcontrolname="email"]', { timeout: 10000 });
                await page.locator('input[formcontrolname="email"]').fill(process.env.NETGEAR_EMAIL);
                await page.locator('input[formcontrolname="password"]').click();
                await page.keyboard.type(process.env.NETGEAR_PWD, { delay: 50 });
                await page.keyboard.press('Enter');
            }

            //mfa
            await page.waitForSelector('#try3', { timeout: 15000 });
            await page.click('#try3');
            await page.click(userChoice === '1' ? 'text=7166' : 'text=6646');
            await page.click('button:has-text("Continue")');

            console.log("\n👉 ACTION REQUIRED: Enter the 6-digit code in the browser.");
            await askTerminal("Once typed, press [ENTER] here to proceed...");
            await page.click('button:has-text("Continue")');

            // trust screen
            try {
                const trustBtn = page.getByRole('button', { name: 'Trust' });
                await trustBtn.waitFor({ state: 'visible', timeout: 5000 });
                await trustBtn.click();
            } catch (e) {}
        }

        //stable URL now
        await page.waitForFunction(() => 
            window.location.href.includes('dashboard') &&
            !window.location.href.includes('code='),
            { timeout: 30000 }
        );
        console.log("Inside the Portal.");
    } catch (e) {
            console.log("❌ Failed to reach dashboard. Manual intervention may be needed.");
        }
//============================================================================================================================
    // 5. reset loop
    for (const venueData of swList) {
        const netgearVenueName = venueMap[venueData.venue] || venueData.venue;
        console.log(`\n🏢 Searching for Venue: ${venueData.venue}`);

        //locate and click the venu
        try {
    
            await page.click('#headerLocName');
            await page.waitForSelector('.search-location-list', { timeout: 5000 });
            const venueItem = page.locator('.location-title', { hasText: new RegExp(`^${netgearVenueName}$`, 'i') });
            await venueItem.scrollIntoViewIfNeeded();
            await venueItem.click();
            console.log(`✅ Entered Venue: ${netgearVenueName}`);

            //Devices tab
            await page.waitForSelector('a[href*="/devices/dash"]', { timeout: 10000 });
            await page.locator('a[href*="/devices/dash"]').click();
            await page.waitForLoadState('networkidle');

            // switches details
            for (const sw of venueData.switches) {
                const targetGroup = normalizeGroupName(sw.group);
                console.log(`🔍 Search: ${sw.group} -> ${targetGroup}`);

                const searchInput = page.locator('input[placeholder*="Search"]');
                await searchInput.clear();
                await searchInput.fill(targetGroup);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(2000);

                try {
                    const switchTarget = page.locator('.ag-cell[col-id="name"]', { hasText: new RegExp(`^${targetGroup}$`, 'i') }).first();

                    await switchTarget.waitFor({ state: 'visible', timeout: 5000 });
                    await switchTarget.scrollIntoViewIfNeeded();
                    console.log(`🖱️ CLICK CLICK: ${targetGroup}`);
                    await switchTarget.click();
                    await page.waitForTimeout(500);
                    await switchTarget.dblclick({ force: true });

                    await page.waitForTimeout(2000);
                    if (page.url().includes('dash')) {
                        console.log("🔄 Entry failed, trying Role-based link...");
                        const linkTarget = page.getByRole('link', { name: targetGroup, exact: true }).first();
                        if (await linkTarget.isVisible()) {
                            await linkTarget.click();
                            await linkTarget.dblclick({ force: true });
                        }
                    }

                    await page.waitForTimeout(2000);
                    if (page.url().includes('dash')) {
                        console.log("🔄 Still on dash, attempting 'Enter' key focus...");
                        await switchTarget.click();
                        await page.keyboard.press('Enter');
                    }

                    await page.waitForURL('**/devices/switch/summary', { timeout: 10000 });
                    console.log(`✅ Successfully entered: ${targetGroup}`);

                    console.log("\n🛑 Bot paused inside switch. Check if URL is /switch/summary.");
                    process.exit(0);

                } catch (err) {
                    console.log(`⚠️ Switch "${targetGroup}" not found in this venue.`);

                    try {
                        await page.locator('.ag-cell', { hasText: targetGroup }).dblclick({ force: true });
                        await page.waitForURL('**/devices/switch/summary', { timeout: 10000 });
                        console.log(`✅ Fallback dblclick worked for: ${targetGroup}`);
                        process.exit(0);
                    } catch (innerErr) {
                        console.log(`❌ All entry methods failed for ${targetGroup}.`);
                    }
                }
                // return to devices list for next bathroom
                await page.goto('https://insight.netgear.com/#/devices/dash');
            }
        } catch (e) { console.log(`❌ Failed venue ${netgearVenueName}.`); }

        // Return to main list
        await page.goto('https://insight.netgear.com/#/dashboard/account');
    }
    console.log("\n🚀 All venues processed.");
})();