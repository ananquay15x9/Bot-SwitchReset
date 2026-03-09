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

/**
 * Fallback normalization if no mapping is found in CSV
 */
function normalizeGroupName(name) {
    if (!name) return "";
    let clean = name.trim();
    clean = clean.replace(/\s*Mens?$/i, 'M');
    clean = clean.replace(/\s*Womens?$/i, 'W');
    clean = clean.replace(/\s+/g, '');
    return clean.toUpperCase();
}

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
    //csv mapping
    const serialToNetgear = {};
    const venueGroupToNetgear = {};
    try {
        if (fs.existsSync('all-switch-list.csv')) {
            const csvContent = fs.readFileSync('all-switch-list.csv', 'utf8');
            const lines = csvContent.split('\n');
            lines.slice(1).forEach(line => {
                if (!line.trim()) return;
                const parts = line.split(',');
                if (parts.length >= 6) {
                    const venue = parts[0].trim();
                    const serial = parts[1].trim();
                    // Netgear name is last in the CSV
                    const group = parts[parts.length - 2].trim();
                    const netgearName = parts[parts.length - 1].trim();

                    if (serial && serial !== '0' && serial !== 'N/A') {
                        serialToNetgear[serial] = netgearName;
                    }
                    venueGroupToNetgear[`${venue}|${group}`] = netgearName;
                }
            });
            console.log("📊 CSV Mapping loaded successfully.");
        }
    } catch (e) {
        console.log("⚠️ Could not load all-switch-list.csv mapping. Using fallbacks.");
    }

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

    // login and mfa
    try {
        const authState = await Promise.race([
            page.waitForFunction(() => window.location.href.includes('dashboard') || window.location.href.includes('code='), { timeout: 15000 }).then(() => 'LOGGED_IN'),
            page.waitForSelector('input[formcontrolname="email"]', { timeout: 10000 }).then(() => 'NEEDS_LOGIN'),
            page.waitForSelector('#try3', { timeout: 10000 }).then(() => 'NEEDS_MFA')
        ]);

        if (authState !== 'LOGGED_IN') {
            console.log("\n👤 MFA Required:");
            const userChoice = await askTerminal("Who are you? (1: Ruben, 2: Tu): ");
            if (authState === 'NEEDS_LOGIN') {
                await page.locator('input[formcontrolname="email"]').fill(process.env.NETGEAR_EMAIL);
                await page.locator('input[formcontrolname="password"]').click();
                await page.keyboard.type(process.env.NETGEAR_PWD, { delay: 50 });
                await page.keyboard.press('Enter');
            }
            await page.waitForSelector('#try3', { timeout: 15000 });
            await page.click('#try3');
            await page.click(userChoice === '1' ? 'text=7166' : 'text=6646');
            await page.click('button:has-text("Continue")');
            await askTerminal("Enter code in browser, then press [ENTER] here...");
            await page.click('button:has-text("Continue")');
            try {
                await page.click('button:has-text("Trust")', { timeout: 5000 });
                await page.click('button.btn-primary:has-text("Continue")', { timeout: 5000 });
            } catch (e) {}
        }
        await page.waitForFunction(() => window.location.href.includes('dashboard'), { timeout: 30000 });
        console.log("✅ Inside the Portal.");
    } catch (e) { console.log("⚠️ Auth bypass."); }

    // start the loop
    for (const venueData of swList) {
        const netgearVenueName = venueMap[venueData.venue] || venueData.venue;
        console.log(`\n🏢 Venue: ${netgearVenueName}`);

        try {
            await page.click('#headerLocName');
            await page.waitForSelector('.search-location-list', { timeout: 5000 });
            await page.locator('.location-title', { hasText: new RegExp(`^${netgearVenueName}$`, 'i') }).click();

            await page.waitForLoadState('networkidle');
            await page.waitForSelector('a[href*="/devices/dash"]', { timeout: 15000 });
            await page.locator('a[href*="/devices/dash"]').click();

            for (const sw of venueData.switches) {

                const targetGroup = serialToNetgear[sw.serial] ||
                                    venueGroupToNetgear[`${venueData.venue}|${sw.group}`] ||
                                    normalizeGroupName(sw.group);

                console.log(`🔍 DEBUGGING SWITCH: ${sw.location} -> ${targetGroup} (Serial: ${sw.serial})`);

                // navigate to devices tab
                if (!page.url().includes('/devices/dash')) {
                    console.log("⬅️ Returning to Dashboard...");
                    await page.goto('https://insight.netgear.com/#/devices/dash');
                    await page.waitForSelector('.ag-root-wrapper', { timeout: 15000 });
                    await page.waitForTimeout(2000); 
                }

                // search for the location
                const searchBar = page.locator('div.m-b-10 input.agGridSearch').first();
                await searchBar.waitFor({ state: 'visible', timeout: 10000 });
                await searchBar.click({ clickCount: 3 });
                await page.keyboard.press('Control+a');
                await page.keyboard.press('Backspace');
                await searchBar.fill(targetGroup);
                await page.waitForTimeout(2000); 

                // clicking
                const escapedName = targetGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const nameCell = page.locator(
                    '.ag-pinned-left-cols-container .ag-cell[col-id="name"] p.breakWord'
                ).filter({ hasText: new RegExp(`^${escapedName}$`) }).first();
                await nameCell.waitFor({ state: 'visible', timeout: 10000 });
                await nameCell.dblclick();

                // go to detail page
                await page.waitForURL('**devices/switch/summary**', { timeout: 15000 });
                console.log(`✅ On switch page for: ${targetGroup}`);

            }
        } catch (e) {
            console.log(`❌ Error: ${e.message}`);
        }
    }
})();