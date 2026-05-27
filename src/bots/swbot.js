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
    // we can now let the bot login via telegram or terminal, send the code to terminal worked
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
    const exactRegex = buildFlexibleNameRegex(targetGroup);

    const exactCell = rows.filter({ hasText: exactRegex }).first();
    if (await exactCell.count() > 0) return exactCell;

    const substringRegex = new RegExp(targetGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const substringCell = rows.filter({ hasText: substringRegex }).first();
    if (await substringCell.count() > 0) return substringCell;

    const totalRows = await rows.count();
    if (totalRows === 1) return rows.first();

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
    "Virginia Tech - Cassell Coliseum": "Virginia Tech"
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

    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ]
    });

    const page = await context.newPage();
    const swList = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));

    await page.goto('https://insight.netgear.com/#/landingPage');
    
    //allow script to handle landing page redirection
    await page.waitForTimeout(3000);

    // AUTH LOGIN
    let authState = 'UNKNOWN';
    try {
        authState = await Promise.race([
            page.waitForFunction(() => window.location.href.includes('dashboard') || window.location.href.includes('account'), { timeout: 15000 }).then(() => 'LOGGED_IN'),
            page.waitForSelector('#email', { timeout: 10000 }).then(() => 'NEEDS_LOGIN'),
            page.waitForSelector('button:has-text("Try Another Verification Method")', { timeout: 10000 }).then(() => 'NEEDS_MFA')
        ]);
    } catch (e) { console.log("ℹ️ Checking session..."); }

    if (authState !== 'LOGGED_IN') {
        if (authState === 'NEEDS_LOGIN' || await page.isVisible('#email')) {
            console.log("👤 Entering credentials into updated Netgear Auth layout...");
            await page.locator('#email').fill(process.env.NETGEAR_EMAIL);
            await page.locator('#password').fill(process.env.NETGEAR_PWD);
            await page.click('button[type="submit"]:has-text("Sign In")');
        }

        // wait for authentication screens
        try {
            await page.waitForURL('**/verify-challenge', { timeout: 15000 });
        } catch(e) {}

        // route to alternate method profile (email code)
        const altBtn = page.locator('button:has-text("Try Another Verification Method")');
        if (await altBtn.isVisible()) {
            await altBtn.click();
            //select email verification if prompted
            const emailOption = page.locator('text=Email');
            if (await emailOption.isVisible()) {
                await emailOption.click();
                await page.click('button:has-text("Continue")').catch(() => {});
            }
        }

        // send telegram prompt for the 6-digit code
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `🚨 **MFA Code required for Netgear!** \n\nPlease reply with the 6-digit code:`,
            parse_mode: 'Markdown'
        });

        const mfaCode = await getMFACode(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);

        // target individual segmented input boxes
        const digitInputs = page.locator('.otp-digit-input');
        await digitInputs.first().waitFor({ state: 'visible', timeout: 15000 });

        console.log("🔐 Entering MFA code...");
        for (let i = 0; i < 6; i++) {
            await digitInputs.nth(i).click();
            await digitInputs.nth(i).fill(mfaCode[i]);
            await page.keyboard.press(mfaCode[i]);
        }

        await page.waitForTimeout(1000);
        await page.click('button[type="submit"]:has-text("Verify Code")');

        
        try {
            await page.click('button:has-text("Trust")', { timeout: 5000 }); 
            await page.click('button.btn-primary:has-text("Continue")', { timeout: 5000 });
        } catch (e) {}
    }

    await page.waitForFunction(() => window.location.href.includes('dashboard'), { timeout: 30000 });
    console.log("✅ Inside the Portal.");



    // POE stats

    console.log("==================================================================================");
    const poeReport = [];

    // or just target certain place and reset
    const targetArg = process.argv[2] ? process.argv[2].toLowerCase() : null;
    
    for (const venueData of swList) {
        if (targetArg && !venueData.venue.toLowerCase().includes(targetArg)) {
            console.log(`Skipping ${venueData.venue} (Not requested)`);
            continue;
        }
        
        const netgearVenueName = findVenueMapping(venueData.venue) || venueMap[venueData.venue] || venueData.venue;
        console.log(`\n🏢 Venue: ${netgearVenueName}`);

        try {
            await page.click('#headerLocName');
            await page.waitForSelector('.search-location-list', { timeout: 5000 });
            // Strict matching: prefer exact text match, then contains; fail loudly if not found
            const locationTitles = page.locator('.location-title');
            const totalLocations = await locationTitles.count();
            let clickedVenue = false;

            for (let i = 0; i < totalLocations; i++) {
                const el = locationTitles.nth(i);
                const text = (await el.innerText()).trim();
                if (text.toLowerCase() === netgearVenueName.toLowerCase()) {
                    await el.click();
                    clickedVenue = true;
                    break;
                }
            }

            if (!clickedVenue) {
                for (let i = 0; i < totalLocations; i++) {
                    const el = locationTitles.nth(i);
                    const text = (await el.innerText()).trim().toLowerCase();
                    if (text.includes(netgearVenueName.toLowerCase())) {
                        await el.click();
                        clickedVenue = true;
                        break;
                    }
                }
            }

            if (!clickedVenue) {
                // gather available titles for debugging
                const seen = [];
                for (let i = 0; i < totalLocations; i++) seen.push((await locationTitles.nth(i).innerText()).trim());
                throw new Error(`Could not find Netgear location matching "${netgearVenueName}". Available: ${seen.join(' | ')}`);
            }

            await page.waitForLoadState('networkidle');
            await page.waitForSelector('a[href*="/devices/dash"]', { timeout: 15000 });
            await page.locator('a[href*="/devices/dash"]').click();

            for (const sw of venueData.switches) {
                const targetGroup = serialToNetgear[sw.serial] || 
                                    venueGroupToNetgear[`${venueData.venue}|${sw.group}`] || 
                                    normalizeGroupName(sw.group);

                console.log(`🔍 Device: ${sw.location} -> ${targetGroup} (Serial: ${sw.serial})`);

                if (!page.url().includes('/devices/dash')) {
                    console.log("⬅️ Returning to Dashboard...");
                    await page.goto('https://insight.netgear.com/#/devices/dash');
                    await page.waitForSelector('.ag-root-wrapper', { timeout: 15000 });
                    await page.waitForTimeout(2000); 
                }

                // searching for the bathroom
                const searchBar = page.locator('div.m-b-10 input.agGridSearch').first();
                await searchBar.waitFor({ state: 'visible', timeout: 10000 });
                await searchBar.fill('');
                await page.keyboard.press('Control+A');
                await page.keyboard.press('Backspace');
                await searchBar.fill(targetGroup);
                await page.waitForTimeout(2000); 

                // 🎯 Step 1: Find the target row name cell inside the left pinned panel
                const nameCell = await getNameCell(page, targetGroup);
                if (!nameCell) {
                    throw new Error(`Could not find target group row for ${targetGroup}`);
                }

                // 🎯 Step 2: Extract the row-index cleanly using browser-side DOM traversal
                const rowIndex = await nameCell.evaluate(el => {
                    const row = el.closest('.ag-row');
                    return row ? row.getAttribute('row-index') : null;
                });

                if (rowIndex !== null) {
                    console.log(`🎯 Identified AG-Grid Row Index: ${rowIndex}`);
                    
                    // 🎯 Step 3: Match that exact row-index inside the main body pane to check the side-by-side status tag
                    const statusCell = page.locator(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"] .ag-cell[col-id="deviceStatus"]`).first();
                    
                    if (await statusCell.isVisible()) {
                        const statusText = await statusCell.innerText();
                        
                        // 🛑 DISCONNECTED STATUS ESCALATION LOOP
                        if (statusText.includes('Device is disconnected') || await statusCell.locator('p.deviceStatus.colorRed').isVisible()) {
                            console.log(`❌ SKIPPING: Switch "${targetGroup}" is [OFFLINE / DISCONNECTED] at ${venueData.venue}. Escalating to dead queue.`);
                            
                           // max out history log counters instantly and log the specific hardware block reason
                            for (let forceCount = 0; forceCount < 7; forceCount++) {
                                updateHistory(venueData.venue, sw.location, sw.port, "Switch Disconnected");
                            }
                            
                            // jump to the next switch without attempting reset
                            continue; 
                        }
                        console.log(`🟢 Switch "${targetGroup}" is Connected. Proceeding...`);
                    }
                } else {
                    console.log(`⚠️ Warning: Could not resolve AG-Grid row element context for ${targetGroup}. Defaulting to drilldown.`);
                }

                // Double click the pinned cell to safely step inside the switch view
                await nameCell.dblclick();

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
                    console.log("🚨 Session expired mid-transit! Re-triggering Netgear authentication flow...");
                    
                    await page.locator('#email').fill(process.env.NETGEAR_EMAIL);
                    await page.locator('#password').fill(process.env.NETGEAR_PWD);
                    await page.click('button[type="submit"]:has-text("Sign In")');
                    
                    // call Telegram/Terminal MFA listener to pull a fresh 6-digit challenge key safely
                    const freshCode = await getMFACode(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);
                    const digitInputs = page.locator('.otp-digit-input');
                    await digitInputs.first().waitFor({ state: 'visible', timeout: 15000 });
                    
                    for (let i = 0; i < 6; i++) {
                        await digitInputs.nth(i).click();
                        await digitInputs.nth(i).fill(freshCode[i]);
                        await page.keyboard.press(freshCode[i]);
                    }
                    await page.waitForTimeout(1000);
                    await page.click('button[type="submit"]:has-text("Verify Code")');
                    
                    // bounce right back to the target switch view layout link context
                    await page.goto(`https://insight.netgear.com/#/devices/switch/summary`, { waitUntil: 'networkidle' });
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
                const currentHour = new Date().getHours();
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
                                await page.goto('https://insight.netgear.com/#/devices/switch/summary');
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
                await page.goto('https://insight.netgear.com/#/devices/dash');
            }
        } catch (e) {
            console.log(`❌ Error processing venue ${netgearVenueName}: ${e.message}`);
        }
    }
    fs.writeFileSync(REPORT_FILE, JSON.stringify(poeReport, null, 2));
    console.log("\n✨ Reset Complete! Check logs/reports/.");

    await context.close();
    process.exit(0);
})();