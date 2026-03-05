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

    for (const venueData of swList) {
        const netgearVenueName = venueMap[venueData.venue] || venueData.venue;
        console.log(`\n🏢 Testing Venue: ${netgearVenueName}`);

        try {
            // 1. Navigation
            await page.click('#headerLocName');
            await page.waitForSelector('.search-location-list', { timeout: 5000 });
            await page.locator('.location-title', { hasText: new RegExp(`^${netgearVenueName}$`, 'i') }).click();

            // 2. CRITICAL WAIT: Wait for the Device Grid container to exist before clicking 'Devices'
            console.log("⏳ Waiting for page to stabilize...");
            await page.waitForLoadState('networkidle');
            
            await page.waitForSelector('a[href*="/devices/dash"]', { timeout: 15000 });
            await page.locator('a[href*="/devices/dash"]').click();
            

            for (const sw of venueData.switches) {
                const targetGroup = normalizeGroupName(sw.group);
                console.log(`🔍 DEBUGGING SWITCH: ${targetGroup}`);

                // --- STEP A: THE RESET ---
                // If the URL shows we are in a summary, go back to the dash first
                if (page.url().includes('/switch/summary')) {
                    console.log("⬅️ Returning to Dashboard to find the next bathroom...");
                    await page.goto('https://insight.netgear.com/#/devices/dash');
                    // Wait for the grid to reload so the search bar is actually there
                    await page.waitForSelector('.ag-root-wrapper', { timeout: 15000 });
                    await page.waitForTimeout(1000); // Small buffer for AG Grid stability
                }

                // --- STEP B: THE SEARCH ---
                const searchBar = page.locator('div.m-b-10 input.agGridSearch').first();
                await searchBar.waitFor({ state: 'visible', timeout: 10000 });
                
                // Clear the search bar (very important for multiple switches in one venue)
                await searchBar.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                
                // Type the new bathroom location
                await searchBar.fill(targetGroup);
                await page.keyboard.press('Enter');
                
                // Wait for the grid to filter down to our target
                await page.waitForTimeout(2000);

                // --- STEP C: THE CLICK (Your verified code) ---
                await page.evaluate((targetSwitchName) => {
                    const gridEl = document.querySelector('.ag-root-wrapper');
                    if (!gridEl) throw new Error("AG Grid not found");

                    const gridApi = gridEl.__agComponent?.gridOptions?.api;

                    if (gridApi) {
                        gridApi.forEachNode((node) => {
                            if (node.data && node.data.deviceName === targetSwitchName) {
                                gridApi.ensureNodeVisible(node);
                                node.setSelected(true);
                                const cell = document.querySelector(`[row-id="${node.id}"] [col-id="deviceName"]`);
                                cell?.click();
                            }
                        });
                    } else {
                        const cells = Array.from(document.querySelectorAll('.ag-cell'));
                        const targetCell = cells.find(c => c.innerText.trim() === targetSwitchName);
                        if (targetCell) {
                            targetCell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                        }
                    }
                }, targetGroup);

                // After this, it will loop back to STEP A for the next bathroom!
            }
        } catch (e) {
            console.log(`❌ Error: ${e.message}`);
        }
    }
})();