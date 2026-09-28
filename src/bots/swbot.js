// second, run this script to start restting switches

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// file structure
const LOGS_DIR = path.join(__dirname, '../../logs');
const REPORTS_DIR = path.join(LOGS_DIR, 'reports');
const SESSION_DIR = path.join(__dirname, '../../netgear_session');

const HISTORY_FILE = path.join(LOGS_DIR, 'history-log.json');
const SCAN_FILE = path.join(LOGS_DIR, 'down-devices-list.json');
const CSV_FILE = path.join(__dirname, '../../data/all-switch-list.csv');
const REPORT_FILE = path.join(REPORTS_DIR, 'poe-stats-report.json');

if (!fs.existsSync(path.join(LOGS_DIR, 'reports'))) {
    fs.mkdirSync(path.join(LOGS_DIR, 'reports'), { recursive: true });
}

const askTerminal = (query) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
};

function getLogPath(dateObj = new Date()) {
    const d = dateObj.toLocaleDateString("en-US", { timeZone: "America/Chicago" }).replace(/\//g, '-');
    return path.join(path.join(__dirname, '../../logs'), `history-log-${d}.json`);
}

function updateHistory(venue, device, port, statusReason = "Max Reset Attempts Exceeded") {
    const todayPath = getLogPath();
    let history = { outage_summary: {} };

    if (fs.existsSync(todayPath)) {
        history = JSON.parse(fs.readFileSync(todayPath, 'utf8'));
    }

    if (!history.outage_summary[venue]) history.outage_summary[venue] = {};

    const currentCount = history.outage_summary[venue][device]?.attempt_count || 0;
    const newCount = currentCount + 1;

    history.outage_summary[venue][device] = {
        port: port || "NA",
        attempt_count: newCount,
        last_reset: new Date().toLocaleTimeString("en-US", { hour12: false }),
        reason: statusReason //  record why it failed
    };

    // do not mark dead in the history logs file
    fs.writeFileSync(todayPath, JSON.stringify(history, null, 2));
    return newCount; 
}

//login remotely
const getMFACode = async (botToken, chatId) => {
    console.log("📡 Remote MFA Mode: Please send a 6-digit code in Telegram or Terminal:");
    
    // flush the old message and get new one
    // let the bot login via telegram or terminal, send the code to terminal worked
    let lastUpdateId = process.argv[3] ? parseInt(process.argv[3]) : 0;

    try {
        const initialRes = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
            params: { offset: -1, timeout: 0 }
        });
        const updates = initialRes.data.result;
        if (updates.length > 0) {
            lastUpdateId = updates[updates.length - 1].update_id;
        }
    } catch (e) { console.error("⚠️ Initial flush failed."); }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let terminalCode = null;
    
    rl.question("📥 Or enter code here manually: ", (ans) => {
        if (/^\d{6}$/.test(ans)) terminalCode = ans;
        rl.close();
    });

    while (true) {
        if (terminalCode) return terminalCode;

        try {
            //fetch new message only
            const response = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
                params: { offset: lastUpdateId + 1, timeout: 5 }
            });

            const updates = response.data.result;
            for (const update of updates) {
                lastUpdateId = update.update_id;
                const msg = update.message?.text;
                
                if (msg && /^\d{6}$/.test(msg.trim())) {
                    console.log(`✅ Received NEW MFA from Telegram: ${msg}`);
                    rl.close(); 
                    return msg.trim();
                }
            }
        } catch (e) {
            if (!e.message.includes('409')) {
                console.error("⚠️ Telegram polling error:", e.message);
            }
        }
        await new Promise(r => setTimeout(r, 3000));
    }
};


async function reAuthenticate(page, label = "") {
    console.log(`🔐 [${label}] Starting re-auth sequence...`);

    await page.goto('https://insight.netgear.com/#/landingPage');
    await page.waitForTimeout(3000);

    // Step 1: Credentials (if login screen appeared)
    if (await page.locator('#email').isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`👤 [${label}] Entering credentials...`);
        await page.locator('#email').fill(process.env.NETGEAR_EMAIL);
        await page.locator('#password').fill(process.env.NETGEAR_PWD);
        await page.click('button[type="submit"]:has-text("Sign In")');
        await page.waitForTimeout(3000);
    }

    // Step 2: Check if already landed on dashboard (session still valid, no MFA needed)
    const alreadyIn = await page.locator('#headerLocName').isVisible({ timeout: 5000 }).catch(() => false);
    if (alreadyIn) {
        console.log(`✅ [${label}] Session still valid, skipping MFA.`);
        return;
    }

     // Step 3: Pick verification method if prompted
    const altBtn = page.locator('button:has-text("Try Another Verification Method")');
    if (await altBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
        await altBtn.click();
        const emailOption = page.locator('text=Email');
        if (await emailOption.isVisible({ timeout: 3000 }).catch(() => false)) {
            await emailOption.click();
            await page.click('button:has-text("Continue")').catch(() => {});
        }
    }

    // Step 4: Wait for one of three possible outcomes after credentials/method select:
    //   A) OTP screen appeared  → need to enter code
    //   B) Dashboard appeared   → session was still valid, done
    //   C) Neither after 25s    → something went wrong, throw so caller can retry
    console.log(`⏳ [${label}] Waiting for OTP screen or dashboard...`);
    let outcome = null;
    try {
        outcome = await Promise.race([
            page.waitForSelector('.otp-digit-input', { timeout: 25000 }).then(() => 'OTP'),
            page.waitForSelector('#headerLocName',   { timeout: 25000 }).then(() => 'DASHBOARD'),
        ]);
    } catch (e) {
        throw new Error(`[${label}] Neither OTP screen nor dashboard appeared after 25s. Netgear may be showing an unexpected page.`);
    }

    if (outcome === 'DASHBOARD') {
        console.log(`✅ [${label}] Session still valid, no MFA needed.`);
        return;
    }

    console.log(`🔢 [${label}] OTP screen detected.`);

    // Step 5: Notify Telegram and get code
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TEST_TOKEN}/sendMessage`, {
        chat_id: process.env.TELEGRAM_TEST_ID,
        text: `🚨 *Netgear MFA Required* [${label}]\n\nPlease reply with the 6-digit email code:`,
        parse_mode: 'Markdown'
    });

    const mfaCode = await getMFACode(process.env.TELEGRAM_TEST_TOKEN, process.env.TELEGRAM_TEST_ID);
    const digitInputs = page.locator('.otp-digit-input');
    console.log(`🔐 [${label}] Injecting MFA code: ${mfaCode}`);

    // click the first box to focus the OTP field
    await digitInputs.first().waitFor({ state: 'visible' });
    await digitInputs.first().click();
    await page.waitForTimeout(300);

    // type all 6 digits
    await digitInputs.first().pressSequentially(mfaCode, { delay: 150 });
    await page.waitForTimeout(800);

    // verify all 6 boxes got filled before submitting
    const filledCount = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.otp-digit-input'))
            .filter(el => el.value !== '').length;
    });
    console.log(`🔢 [${label}] Filled ${filledCount}/6 digit boxes.`);

    //  fall back to clicking each individually
    if (filledCount < 6) {
        console.log(`⚠️ [${label}] Falling back to per-box input...`);
        for (let i = 0; i < 6; i++) {
            await digitInputs.nth(i).click();
            await page.waitForTimeout(100);
            await digitInputs.nth(i).pressSequentially(mfaCode[i], { delay: 100 });
            await page.waitForTimeout(100);
        }
        await page.waitForTimeout(500);
    }

    // submit
    await page.locator('button[type="submit"]:has-text("Verify Code")').click();
    await page.waitForTimeout(4000);

    // Step 6: Trust / Continue prompts
    await page.click('button:has-text("Trust")', { timeout: 5000 }).catch(() => {});
    await page.click('button.btn-primary:has-text("Continue")', { timeout: 5000 }).catch(() => {});

    await page.goto('https://insight.netgear.com/#/devices/dash', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#headerLocName', { timeout: 20000 });
    console.log(`✅ [${label}] Re-auth successful.`);
}

function normalizeGroupName(name) {
    if (!name) return "";
    let clean = name.trim();
    clean = clean.replace(/\s*Mens?$/i, 'M');
    clean = clean.replace(/\s*Womens?$/i, 'W');
    clean = clean.replace(/\s+/g, '_');
    clean = clean.replace(/[_-]{2,}/g, '_');
    return clean.toUpperCase();
}

function buildFlexibleNameRegex(name) {
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexible = safe.replace(/[_\s-]+/g, '[_\\s-]*');
    return new RegExp(`^${flexible}$`, 'i');
}

async function getNameCell(page, targetGroup) {
    const rows = page.locator('.ag-pinned-left-cols-container .ag-cell[col-id="name"] p.breakWord');
    const totalRows = await rows.count();
    
    const cleanTarget = targetGroup.trim().toLowerCase();

    // matching check pass
    for (let i = 0; i < totalRows; i++) {
         const cell = rows.nth(i);
         const text = (await cell.innerText()).trim().toLowerCase();
         
         if (text === cleanTarget) {
             return cell;
         }
     }

     // substring normalized 
     for (let i = 0; i < totalRows; i++) {
         const cell = rows.nth(i);
         const text = (await cell.innerText()).trim().toLowerCase();
         
         if (text.includes(cleanTarget) || cleanTarget.includes(text)) {
             return cell;
         }
     }

     if (totalRows === 1) {
         return rows.first();
     }
 
     return null;
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
    "Virginia Tech - Cassell Coliseum": "Virginia Tech",
    "LSU - PMAC": "LSU - PMAC"
};

function normalizeVenueKey(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findVenueMapping(venue) {
    if (!venue) return null;
    if (venueMap[venue]) return venueMap[venue];
    const norm = normalizeVenueKey(venue);
    // exact normalized match
    for (const k of Object.keys(venueMap)) {
        if (normalizeVenueKey(k) === norm) return venueMap[k];
    }
    // substring normalized match (either direction)
    for (const k of Object.keys(venueMap)) {
        const nk = normalizeVenueKey(k);
        if (norm.includes(nk)) {
            return venueMap[k]; // Returns the intended Netgear target short name!
        }
    }
    return null;
}

(async () => {
    // mapping
    const serialToNetgear = {};
    const venueGroupToNetgear = {};
    try {
        if (fs.existsSync(CSV_FILE)) {
            const csvContent = fs.readFileSync(CSV_FILE, 'utf8');
            const lines = csvContent.split('\n');
            lines.slice(1).forEach(line => {
                if (!line.trim()) return;
                const parts = line.split(',');
                if (parts.length >= 6) {
                    const venue = parts[0].trim();
                    const serial = parts[1].trim();
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

    const lockFile = path.join(SESSION_DIR, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
    	fs.unlinkSync(lockFile);
    	console.log('Cleared Chromium SingletonLock');
    }
    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ]
    });

    let page = await context.newPage();
    const swList = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));

    await page.goto('https://insight.netgear.com/#/landingPage');
    
    //allow script to handle landing page redirection
    await page.waitForTimeout(3000);

    // AUTH LOGIN
    let alreadyLoggedIn = false;
    try {
        alreadyLoggedIn = await Promise.race([
            page.waitForFunction(() => window.location.href.includes('dashboard') || window.location.href.includes('account'), { timeout: 12000 }).then(() => true),
            page.waitForSelector('#email', { timeout: 12000 }).then(() => false),
            page.waitForSelector('.otp-digit-input', { timeout: 12000 }).then(() => false),
            page.waitForSelector('button:has-text("Try Another Verification Method")', { timeout: 12000 }).then(() => false)
        ]);
    } catch (e) { console.log("ℹ️ Could not detect session state, assuming login needed..."); }

    if (!alreadyLoggedIn) {
        await reAuthenticate(page, "Initial Login");
    }

    // NEW UI DETECTION -> SWITCH TO CLASSIC DASHBOARD
    console.log("⏳ Waiting for portal to land on dashboard...");
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    // Check if in the new UI (/organization/...)
    if (!page.url().includes('/classic/')) {
        console.log("🆕 New UI active. Executing recorded profile switch...");

        // 1. Click parent avatar button (captured from log)
        const avatarBtn = page.locator('#profile-section-avatar-button, #profile-section-avatar-image').first();
        await avatarBtn.waitFor({ state: 'visible', timeout: 15000 });
        await avatarBtn.click();
        console.log("👤 Clicked #profile-section-avatar-button");

        // 2. Click "Switch to Classic" and capture the new tab (starts at about:blank)
        const switchToClassicBtn = page.locator('#profile-section-menu-item-switch-to-classic');
        await switchToClassicBtn.waitFor({ state: 'visible', timeout: 10000 });

        console.log("🖱️ Clicking #profile-section-menu-item-switch-to-classic and awaiting tab...");
        const [classicPage] = await Promise.all([
            context.waitForEvent('page', { timeout: 15000 }),
            switchToClassicBtn.click()
        ]);

        // Close the old dashboard tab
        await page.close().catch(() => {});
        page = classicPage;

        console.log("⏳ Waiting for classic dashboard tab to load...");
        await page.waitForURL(url => url.href.includes('/classic/'), { timeout: 25000 });
        await page.bringToFront();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);
    }

    // 3. Step captured from your log: Select "Org_support" on the classic organization grid
    console.log(`📍 Landed on: ${page.url()}`);
    if (page.url().includes('/organization/dashboard')) {
        console.log("🏢 Double-clicking 'Org_support' organization tile...");

        const orgSelector = page.locator('span.scanQRCodeDrop', { hasText: 'Org_support' }).first();
        await orgSelector.waitFor({ state: 'visible', timeout: 15000 });
        await orgSelector.dblclick();

        // Wait for loader to clear and route to settle into Org_support details
        console.log("⏳ Waiting for organization details view...");
        await page.waitForURL(url => url.href.includes('/organization/details/Org_support'), { timeout: 20000 }).catch(() => {});
        await page.locator('.loaderTextContainer').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
    }

    console.log("⏱️ Waiting for classic location header (#headerLocName)...");
    let isHeaderVisible = false;
    for (let check = 0; check < 6; check++) {
        if (await page.locator('#headerLocName').isVisible({ timeout: 2000 }).catch(() => false)) {
            isHeaderVisible = true;
            break;
        }
        console.log("ℹ️ Header menu loading... waiting 3s.");
        await page.waitForTimeout(3000);
    }

    if (!isHeaderVisible) {
        console.log("⚠️ Routing directly to classic devices dash...");
        await page.goto('https://insight.netgear.com/classic/#/devices/dash', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#headerLocName', { timeout: 15000 }).catch(() => {});
    }

    await page.waitForTimeout(1500);
    console.log("✅ Inside Classic Portal and ready for switch reset loop.");

    // POE stats

    console.log("==================================================================================");
    const poeReport = [];

    async function killModal() {
        try {
       
            await page.waitForTimeout(1500);
    
       
            const modalSelectors = '#myModal.internetError, .modal.internetError.in, .modal.insightNotReachable.in, #myModal.insightNotReachable, .modal.in:has-text("Error")';
            const modal = page.locator(modalSelectors);
            
            if (await modal.isVisible()) {
                console.log("🚨 Netgear blocking network overlay detected. Executing eviction sequence...");
                
               
                const btn = modal.locator('button:has-text("OK"), button:has-text("Close"), button.close, button').first();
                if (await btn.isVisible()) {
                    await btn.click({ force: true });
                    await page.waitForTimeout(1500);
                }
    
                // Fallback: If the UI thread is frozen and button clicks fail, hard-evict the nodes from the browser DOM
                if (await modal.isVisible()) {
                    console.log("⚠️verlay button non-responsive. ");
                    await modal.evaluate(el => el.remove());
                    await page.locator('.modal-backdrop').evaluate(el => el.remove()).catch(() => {});
                }
                
                await page.waitForTimeout(2000);
                console.log(" Viewport unblocked successfully.");
            }
        } catch (e) {
           
        }
    }

    // or just target certain place and reset
    const targetArg = process.argv[2] ? process.argv[2].toLowerCase() : null;
    
    for (const venueData of swList) {
        if (targetArg && !venueData.venue.toLowerCase().includes(targetArg)) {
            console.log(`Skipping ${venueData.venue} (Not requested)`);
            continue;
        }

        // mid-loop session loss recovery
        const currentUrl = page.url();
        const loginVisible = await page.locator('#email').isVisible().catch(() => false);
        if (currentUrl.includes('login') || currentUrl.includes('logout') || loginVisible) {
            console.log("⚠️ Mid-run session invalidation detected! Initiating recovery...");
            await reAuthenticate(page, "Mid-Loop Recovery");
            console.log("✅ Session recovery successful. Re-entering infrastructure loop.");
        }
        
        const netgearVenueName = findVenueMapping(venueData.venue) || venueMap[venueData.venue] || venueData.venue;
        console.log(`\n🏢 Venue: ${netgearVenueName}`);

        try {	
            await killModal();
            const ORG_URL = 'https://insight.netgear.com/classic/#/organization/details/Org_support';
            if (!page.url().includes('/organization/details/Org_support')) {
                console.log("↩️ Returning to Org_support venue list...");
                await page.goto(ORG_URL, { waitUntil: 'domcontentloaded' });
            }
            await page.locator('.loaderTextContainer').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
            await killModal();

            // 2. Type the venue name into the search bar
            const venueSearch = page.locator('input.agGridSearch').first();
            await venueSearch.waitFor({ state: 'visible', timeout: 15000 });
            await venueSearch.fill('');
            await venueSearch.fill(netgearVenueName);
            await page.waitForTimeout(2000);

            // 3. DOUBLE-click the matching venue row (exact name first, then contains)
            const escaped = netgearVenueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            let venueCell = page.locator('p.no-margin.breakWord').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }).first();
            if (!(await venueCell.isVisible().catch(() => false))) {
                venueCell = page.locator('p.no-margin.breakWord', { hasText: netgearVenueName }).first();
            }
            if (!(await venueCell.isVisible().catch(() => false))) {
                const seen = await page.locator('p.no-margin.breakWord').allInnerTexts().catch(() => []);
                throw new Error(`Could not find Netgear location matching "${netgearVenueName}". Visible: ${seen.map(t => t.trim()).join(' | ')}`);
            }
            await killModal();
            await venueCell.dblclick();
            console.log(`🏟️ Opened venue: ${netgearVenueName}`);
            await page.locator('.loaderTextContainer').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(2000);

            // 4. Click the "Devices" tab to see all switches
            const devicesTab = page.locator('a[href*="/devices/dash"]').first();
            if (await devicesTab.isVisible({ timeout: 10000 }).catch(() => false)) {
                await devicesTab.click();
            } else {
                await page.getByText('Devices', { exact: true }).first().click({ timeout: 10000 });
            }
            await page.waitForURL(url => url.href.includes('/devices/dash'), { timeout: 20000 });
            await page.waitForSelector('div.m-b-10 input.agGridSearch', { timeout: 15000 });
            console.log("📋 Devices tab loaded.");

            for (const sw of venueData.switches) {
                const targetGroup = serialToNetgear[sw.serial] || 
                                    venueGroupToNetgear[`${venueData.venue}|${sw.group}`] || 
                                    normalizeGroupName(sw.group);

                console.log(`🔍 Device: ${sw.location} -> ${targetGroup} (Serial: ${sw.serial})`);

                if (!page.url().includes('/devices/dash')) {
                    console.log("⬅️ Returning to Dashboard...");
                    await page.goto('https://insight.netgear.com/classic/#/devices/dash');
                    await page.waitForSelector('.ag-root-wrapper', { timeout: 15000 });
                    await page.waitForTimeout(2000); 
                }
         

                // searching for the bathroom
                await killModal();
                const searchBar = page.locator('div.m-b-10 input.agGridSearch').first();
                await searchBar.waitFor({ state: 'visible', timeout: 10000 });

                console.log("🧹 Clearing search bar...");
                await searchBar.click({ clickCount: 3 });
                await page.keyboard.press('Control+A');
                await page.keyboard.press('Backspace');
                
                await searchBar.fill('');
                await page.keyboard.press('Enter');
                await page.waitForTimeout(2000); 

               	await killModal();

                // now fill the new target
                console.log(`Filtering for  switch: ${targetGroup}`);
                await searchBar.fill(targetGroup);
                await page.waitForTimeout(2000);

                // 🎯 Step 1: Find the target row name cell inside the left pinned panel
                const nameCell = await getNameCell(page, targetGroup);
                if (!nameCell) {
                    throw new Error(`Could not find target group row for ${targetGroup}`);
                }

                // 🎯 Step 2: Extract the row-index cleanly using browser-side DOM traversal
                // read the row-index from the cell's parent .ag-row using a Playwright locator
                // (no custom JS runs in Netgear's page, so their scripts can't interfere)
                const rowIndex = await nameCell
                    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ag-row ")][1]')
                    .getAttribute('row-index', { timeout: 5000 })
                    .catch(() => null);
	                                                                                                                            
	            if (rowIndex === null) {                                                                                        
	                console.log(`⚠ Warning: Could not resolve AG-Grid row element context for ${targetGroup}. Defaulting loop...`);
	                continue; // Safely moves to the next switch in the Node.js loop context
	            }                                                                                                               
	                                                                                                                            
	            console.log(`🎯 Identified AG-Grid Row Index: ${rowIndex}`);                                                   
	                                                                                                                            
	            // Step 3: Match that exact row-index inside the main body pane to check the side-by-side status tag          
	            const statusCell = page.locator(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"] .ag-cell[col-id="status"]`);
	            let isDisconnected = false;                                                                                     
	                                                                                                                            
	            if (await statusCell.isVisible()) {                                                                             
	                const statusText = await statusCell.innerText();                                                            
	                if (statusText.includes('Device is disconnected') || await statusCell.locator('p.deviceStatus.colorRed').count() > 0) {
	                    isDisconnected = true;                                                                                  
	                }
	            }                                                                                                               
	                                                                                                                            
	            // 🛑 DISCONNECTED STATUS ESCALATION LOOP                                                                       
	            if (isDisconnected) {                                                                                           
	                console.log(`❌ SKIPPING: Switch "${targetGroup}" is [OFFLINE / DISCONNECTED] at ${venueData.venue}. Escalating to dead queue.`);
	                                                                                                                            
	                                
	                for (let forceCount = 0; forceCount < 7; forceCount++) {                                                    
	                    updateHistory(venueData.venue, sw.location, sw.port, "Switch Disconnected");                            
	                }                                                                                                           
	                continue;                               
	            }
	            console.log(`🟢 Switch "${targetGroup}" is Connected. Proceeding...`);

                await killModal();

                // Double click the pinned cell to safely step inside the switch view
                await nameCell.dblclick({ timeout: 10000 });
                
                // check session and slow page guard
                console.log("⏱️ Waiting for switch summary view to load safely...");
                let viewState = "UNKNOWN";
                try {
                    viewState = await Promise.race([
                        // page loaded successfully 
                        page.waitForSelector('.box-scroller', { timeout: 20000 }).then(() => 'READY'),
                        // negear silently dropped the session
                        page.waitForSelector('#email', { timeout: 20000 }).then(() => 'RE_AUTH_REQUIRED'),
                        // page is being sluggish 
                        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).then(() => 'SLOW_LOAD')
                    ]);
                } catch (e) {
                    console.log("ℹ️ Summary page load is lagging...");
                }

                // Re-Authentication check if portal bounced the bot out
                if (viewState === 'RE_AUTH_REQUIRED' || await page.isVisible('#email')) {
	                 console.log("Session expired mid-transit! Re-triggering auth...");
	                 await reAuthenticate(page, "Switch View Re-Auth");
	                 // Bounce back to the devices dash so the outer venue loop can re-select correctly
	                 await page.goto('https://insight.netgear.com/classic/#/devices/dash', { waitUntil: 'domcontentloaded' });
	             }

                // final safety verification check to make sure the target DOM available
                try {
                    await page.waitForSelector('.box-scroller', { timeout: 15000 });
                } catch (err) {
                    throw new Error(`Summary layout failed to settle: .box-scroller not found. Portal might be down or sluggish.`);
                }


                // PoE stats
                await page.waitForSelector('.box-scroller', { timeout: 15000 });

                const stats = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('.box-scroller li')).map(port => {
                        const count = port.querySelector('.ethernet-count')?.innerText.trim();
                        const tooltip = port.querySelector('.tooltipblock');
                        if (!tooltip || !count) return null;
                        const lines = Array.from(tooltip.querySelectorAll('p'));
                        return {
                            port: count,
                            traffic: lines.find(p => p.innerText.includes('Traffic'))?.innerText.split(':').pop().trim() || "0",
                            power: lines.find(p => p.innerText.includes('Power'))?.innerText.split(':').pop().trim() || "0 W",
                            speed: lines.find(p => p.innerText.includes('Speed'))?.innerText.split(':').pop().trim() || "Unknown"
                        };
                    }).filter(p => p !== null);
                });
                
                // in order 1,2,3,4,..
                stats.sort((a,b) => parseInt(a.port) - parseInt(b.port));


                // sort stats 
                const targetsToReset = [];
                const iSitePort = parseInt(sw.port);

                // if it has a specific port, then just reset this port
                if (!isNaN(iSitePort)) {
                    console.log(`📊 Crawling Port ${iSitePort}.`);
                    targetsToReset.push(iSitePort.toString());
                } 
                // pair analysis
                else {
                    const locationMatch = sw.location.match(/(\d+)$/);
                    const unitNumber = locationMatch ? parseInt(locationMatch[1]) : null;

                    if (unitNumber) {
                        const portBottom = unitNumber * 2;
                        const portTop = portBottom - 1;
                        const p1 = stats.find(p => parseInt(p.port) === portTop);
                        const p2 = stats.find(p => parseInt(p.port) === portBottom);

                        if (p1 && p2) {
                            const power1 = parseFloat(p1.power);
                            const power2 = parseFloat(p2.power);
                            const traffic1 = parseInt(p1.traffic) || 0;
                            const traffic2 = parseInt(p2.traffic) || 0;

                            console.log(`📊 Pair Stats [${portTop}/${portBottom}]: ${power1}W | ${power2}W (Traffic: ${traffic1}/${traffic2})`);

                            // check if it is healthy
                            // identify the "Pi-like" power range (2.9W to 5.5W)
                            const p1InPiRange = (power1 >= 2.5 && power1 <= 5.8);
                            const p2InPiRange = (power2 >= 2.5 && power2 <= 5.8);
                            const p1IsScreen = (power1 > 10);
                            const p2IsScreen = (power2 > 10);

                            if (p1InPiRange && !p2InPiRange) {
                                console.log(`🥧 Port ${portTop} matches Pi wattage profile. Targeting ${portTop}.`);
                                targetsToReset.push(p1.port);
                            }
                            else if (!p1InPiRange && p2InPiRange) {
                                console.log(`🥧 Port ${portBottom} matches Pi wattage profile. Targeting ${portBottom}.`);
                                targetsToReset.push(p2.port);
                            }
                            else if (p1IsScreen && p2IsScreen) {
                                // both 16W/13W" scenario: Reset both but ONLY Power Cycle
                                console.log(`📺 Dual high-wattage detected (${power1}W/${power2}W). Resetting BOTH.`);
                                targetsToReset.push(p1.port, p2.port);
                            }
                            else if (p1IsScreen || p2IsScreen) {
                                // if high-draw like crazy number
                                const target = p1IsScreen ? p2.port : p1.port;
                                console.log(`📺 Detected Screen at ${p1IsScreen ? power1 : power2}W. Targeting the OTHER port (${target}).`);
                                targetsToReset.push(target);
                            } else {
                                // too healthy to distinguish?
                                console.log(`❓ Ambiguous pair (Both ${power1}W/${power2}W). Resetting BOTH ${portTop} & ${portBottom}.`);
                                targetsToReset.push(p1.port, p2.port);
                            }
                        }
                    }
                }
            

                // FUNCTION TOGGLE
                async function togglePoE(page, targets, targetState) {
                    const slider = page.locator('#spnOnOfSliderSetng');
                    const saveBtn = page.locator('#btnModSaveSettng');
                    const vlanConfirmYes = page.locator('.modal-content').filter({ 
                        hasText: 'The VLAN settings will be applied' 
                    }).getByRole('button', { name: 'Yes' });

                    // toggle
                    await slider.click();

                    // hit save
                    await saveBtn.click();

                    // vlan popup
                    try {

                        await vlanConfirmYes.waitFor({ state: 'visible', timeout: 8000 });
                        await vlanConfirmYes.click({ force: true });

                        await vlanConfirmYes.waitFor({ state: 'hidden', timeout: 5000 });
                    } catch (e) {
                        console.log("❌ Failed to click VLAN 'Yes' button. Trying backup selector...");

                        await page.locator('button.btn-danger:has-text("Yes")').click().catch(() => {});
                    }
                }

                // MAIN LOOP PHASE 1 and 2
                const currentHour = parseInt(new Date().toLocaleString("en-US", {
                	timeZone: "America/Chicago", hour: 'numeric', hour12: false
                }));
                const isMorningShift = (currentHour >= 7 && currentHour <= 10);

                const attemptNum = updateHistory(venueData.venue, sw.location, sw.port);


                if (attemptNum > 6) {
                    console.log(`💀 Max attempts (6) reached for ${sw.location}. Skipping to save hardware.`)
                } else {
                    // PHASE 1: RUN PoE Reset at 8AM
                    if (isMorningShift && targetsToReset.length > 0) {
                        try {
                            console.log(`🔌 MORNING SHIFT: Running PoE Reset for targets (Attempt ${attemptNum})`);

                            const firstPort = targetsToReset[0];
                            await page.locator('.ethernet-count', { hasText: new RegExp(`^${firstPort}$`) }).first().click();
                            await page.waitForURL('**/portConfiq/summary');

                            // setting -> batch config
                            await page.click('a[href*="/portConfiq/settings"]');
                            await page.click('#btnModlSettng'); // "Batch port configuration"

                            // click modal
                            const batchWarningYes = page.locator('#btnBatchOfSett'); // "Yes, open batch config."
                            await batchWarningYes.waitFor({ state: 'visible', timeout: 5000 });
                            await batchWarningYes.click();

                            // select ports
                            for (const portNum of targetsToReset) {
                                await page.locator(`#port_${portNum}`).click();
                            }

                            await page.click('#hNsaAccordHeadSettng');

                            // toggle off
                            await togglePoE(page, targetsToReset, false);           
                            console.log("⏱️ Waiting 20s");
                            await page.waitForTimeout(20000);

                            // toggle on
                            await togglePoE(page, targetsToReset, true);
                            console.log("🎉 PHASE 1 complete.\n");
                            await page.waitForTimeout(5000);

                        }   catch (err) {
                            console.log(`❌ Phase 1 failed: ${err.message}`);
                    }
                }

                    // PHASE 2: Power Cycle (Run 1x for 8am, 2pm, 7pm)
                    try{
                        try {
                            const closeBatch = page.locator('button.close[data-dismiss="modal"]').first();
                            if (await closeBatch.isVisible()) await closeBatch.click();
                        } catch (e) {}

                        // redirect to summary page to power cycle
                        console.log("🔄 Navigating to PoE Management tab...");
                        const poeTabBtn = page.locator('a:has-text("PoE Management")').first();

                        if (await poeTabBtn.isVisible()) {
                            await poeTabBtn.click();
                        } else {
                            // fall back
                            const currentUrl = page.url();
                            if (currentUrl.includes('/devices/switch/')) {
                                // Dynamically morph the current specific switch URL into its relative PoE management counterpart
                                const poeUrl = currentUrl.split('?')[0].replace(/\/summary|\/portConfiq.*/, '/PoE');
                                await page.goto(poeUrl, { waitUntil: 'networkidle' });
                            } else {
                                // Ultimate fallback if completely thrown out of the switch view
                                await page.goto('https://insight.netgear.com/classic/#/devices/switch/summary');
                                await page.waitForSelector('a:has-text("PoE Management")', { timeout: 10000 });
                                await page.click('a:has-text("PoE Management")');
                            }
                        }

                        await page.waitForURL('**/devices/switch/PoE', { timeout: 15000 });
                        await page.waitForSelector('#btnSavePowerCyclePrts', { timeout: 15000 });
                        await page.waitForTimeout(1000);

                        console.log(`⚡ PHASE 2: Power Cycle (Attempt ${attemptNum})`);

                        for (const portNum of targetsToReset) {
                            const portBtn = page.locator(`.ethernet-count`, { hasText: new RegExp(`^${portNum}$`) }).first();
                            await portBtn.waitFor({ state: 'visible' });
                            await portBtn.click({ force: true });
                            await page.waitForTimeout(500);
                        }

                        const cycleBtn = page.locator('#btnSavePowerCyclePrts');

                        //check if port disabled
                        let isEnabled = false;
                        for (let i = 0; i < 10; i++) { 
                            const isDisabled = await cycleBtn.getAttribute('disabled');
                            if (isDisabled === null) { isEnabled = true; break; }
                            await page.waitForTimeout(500); 
                        }

                        if (isEnabled) {
                            await cycleBtn.click();
                            console.log(`✅ Power Cycle Triggered.`);
                            await page.waitForTimeout(3000);
                        } else {
                            console.log(`⚠️ Button stayed disabled. Port may be unresponsive.`);
                        }
                    } catch (e) {
                        console.log(`❌ Phase 2 failed: ${e.message}`); 
                    }
                    console.log("🎉 PHASE 2: complete.\n");
                }
                
                poeReport.push({ venue: venueData.venue, device: targetGroup, timeStamp: new Date().toISOString(), ports: stats });
                console.log("⬅️ Exiting switch context via native portal navigation...");
                            
                try {
                    const devicesBreadcrumb = page.locator('a[href*="/devices/dash"], .nav-item:has-text("Devices")').first();
                    
                    if (await devicesBreadcrumb.isVisible()) {
                        await devicesBreadcrumb.click();
                    } else {
                        await page.goto('https://insight.netgear.com/classic/#/devices/dash', { waitUntil: 'domcontentloaded' });
                    }
                    
                    await page.waitForSelector('div.m-b-10 input.agGridSearch', { timeout: 15000 });
                    await page.waitForTimeout(1500); 
                    
                } catch (gridErr) {
                    console.log("⚠️ Core grid container is slow to remount, forcing a clean slate refresh...");
                    await page.goto('https://insight.netgear.com/classic/#/devices/dash', { waitUntil: 'networkidle', timeout: 25000 });
                    await page.waitForSelector('div.m-b-10 input.agGridSearch', { timeout: 15000 });
                }
            }
        } catch (e) {
            console.log(`❌ Error processing venue ${netgearVenueName}: ${e.message}`);

            try {
            	console.log("🔄 Lost stable layout context. Executing hardware loop state reclamation...");

            	await killModal();

            	await page.goto('https://insight.netgear.com/classic/#/devices/dash', { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 20000 
                });

                //rebuild the layout
                await page.waitForSelector('div.m-b-10 input.agGridSearch', { timeout: 15000 }).catch(() => {});
                await page.waitForTimeout(3000);
                console.log("Reset successfully.");
            } catch (recoveryErr) {
            	console.log(`⚠️ Canvas scrub failed: ${recoveryErr.message}. Forcing raw dashboard refresh fallback...`);
                await page.goto('https://insight.netgear.com/classic/#/devices/dash', { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
            }

        }
    }
    fs.writeFileSync(REPORT_FILE, JSON.stringify(poeReport, null, 2));
    console.log("\n✨ Reset Complete! Check logs/reports/.");

    await context.close();
    process.exit(0);
})();