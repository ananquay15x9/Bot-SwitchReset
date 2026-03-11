// second, run this script to start restting switches

const { chromium } = require('playwright');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
require('dotenv').config();

const askTerminal = (query) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
};

//login remotely
const getMFACode = async (botToken, chatId) => {
    console.log("📡 Remote MFA Mode: Please send a 6-digit code in Telegram or Terminal:");
    
    // flush the old message and get new one
    // we can now let the bot login via telegram or terminal, send the code to terminal worked
    let lastUpdateId = 0;
    try {
        const initialRes = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`);
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
            console.error("⚠️ Telegram polling error:", e.message);
        }
        await new Promise(r => setTimeout(r, 3000));
    }
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
    // mapping
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
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await context.newPage();
    const swList = JSON.parse(fs.readFileSync('down-switch-list.json', 'utf8'));

    await page.goto('https://insight.netgear.com/#/landingPage');
    if (await page.isVisible('#loginNow')) await page.click('#loginNow');

    // AUTH LOGIN
    let authState = 'UNKNOWN';
    try {
        authState = await Promise.race([
            page.waitForFunction(() => window.location.href.includes('dashboard') || window.location.href.includes('code='), { timeout: 15000 }).then(() => 'LOGGED_IN'),
            page.waitForSelector('input[formcontrolname="email"]', { timeout: 10000 }).then(() => 'NEEDS_LOGIN'),
            page.waitForSelector('#try3', { timeout: 10000 }).then(() => 'NEEDS_MFA')
        ]);
    } catch (e) { console.log("ℹ️ Checking session..."); }

    if (authState !== 'LOGGED_IN') {
        console.log("\n👤 MFA Required:");
        const userChoice = process.env.MFA_USER_CHOICE || '2';
        console.log(`Hello, ${userChoice === '1' ? 'Ruben' : 'Tu'}`);
        
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

        // Send Telegram Prompt
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `🚨 *iSite WatchDog:* MFA Code required for Netgear! \n\nPlease reply with the 6-digit code.`,
            parse_mode: 'Markdown'
        });

        const mfaCode = await getMFACode(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);
        const otpInput = page.locator('input.otp-input').first();
        await otpInput.waitFor({ state: 'visible', timeout: 15000 });

        // clear the field first
        await otpInput.click({ clickCount: 3 });
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Backspace');

        await otpInput.fill(mfaCode);
        await page.waitForTimeout(1000);
        await page.click('button:has-text("Continue")');
        
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

    // start the loop
    for (const venueData of swList) {
        if (targetArg && !venueData.venue.toLowerCase().includes(targetArg)) {
            console.log(`Skipping ${venueData.venue} (Not requested)`);
            continue;
        }
        
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

                console.log(`🔍 Switch: ${sw.location} -> ${targetGroup} (Serial: ${sw.serial})`);

                if (!page.url().includes('/devices/dash')) {
                    console.log("⬅️ Returning to Dashboard...");
                    await page.goto('https://insight.netgear.com/#/devices/dash');
                    await page.waitForSelector('.ag-root-wrapper', { timeout: 15000 });
                    await page.waitForTimeout(2000); 
                }

                // searching for the bathroom
                const searchBar = page.locator('div.m-b-10 input.agGridSearch').first();
                await searchBar.waitFor({ state: 'visible', timeout: 10000 });
                await searchBar.click({ clickCount: 3 });
                await page.keyboard.press('Control+a');
                await page.keyboard.press('Backspace');
                await searchBar.fill(targetGroup);
                await page.waitForTimeout(2000); 

                // double click 
                const escapedName = targetGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const nameCell = page.locator(
                    '.ag-pinned-left-cols-container .ag-cell[col-id="name"] p.breakWord'
                ).filter({ hasText: new RegExp(`^${escapedName}$`) }).first();
                
                await nameCell.waitFor({ state: 'visible', timeout: 10000 });
                await nameCell.dblclick();

                // reached the summary page
                await page.waitForURL('**/devices/switch/summary**', { timeout: 15000 });

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
                            const hasTraffic = parseInt(p1.traffic) > 0 || parseInt(p2.traffic) > 0;
                            const hasLink = p1.speed.toLowerCase().includes('full') || p2.speed.toLowerCase().includes('full');

                            // check if it is healthy
                            if (hasTraffic || hasLink) {
                                console.log(`✅ Unit ${unitNumber} appears healthy (Traffic/Link detected). Skipping.`);
                            } else {
                                // so reset one or both ports?
                                const p1IsPi = power1 > 2.0;
                                const p2IsPi = power2 > 2.0;

                                if (p1IsPi && !p2IsPi) {
                                    console.log(`🥧 Port ${portTop} is the clear Pi. Resetting only ${portTop}.`);
                                    targetsToReset.push(p1.port);
                                } else if (!p1IsPi && p2IsPi) {
                                    console.log(`🥧 Port ${portBottom} is the clear Pi. Resetting only ${portBottom}.`);
                                    targetsToReset.push(p2.port);
                                } else {
                                    console.log(`❓ Ambiguous pair (Both ${power1}W/${power2}W). Resetting BOTH ${portTop} & ${portBottom}.`);
                                    targetsToReset.push(p1.port, p2.port);
                                }
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

                // starting PoE reset
                if (targetsToReset.length > 0) {
                    try {
                        console.log(`🔌 PHASE 1: Enable PoE Toggle`);
                        

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

                    } catch (err) {
                        console.log(`❌ Resetting interrupted: ${err.message}`);
                    }
                }

                // power cycle
                 try {
                    const closeBatch = page.locator('button.close[data-dismiss="modal"]').first();
                    if (await closeBatch.isVisible()) await closeBatch.click();
                } catch (e) {}

                // redirect to summary page to power cycle
                await page.goto('https://insight.netgear.com/#/devices/switch/summary');
                await page.reload({ waitUntil: 'networkidle' });
                await page.waitForSelector('a:has-text("PoE Management")');
                await page.click('a:has-text("PoE Management")');
                await page.waitForURL('**/devices/switch/PoE', { timeout: 10000 });
                console.log("⚡ PHASE 2: Power Cycle")
                
                let attempts = 0;

                while (attempts < 2) {
                    attempts++;
                    try {
                        // refresh page after first attempt
                        if (attempts > 1) {
                            await page.reload({ waitUntil: 'networkidle' });

                            await page.waitForSelector('a:has-text("PoE Management")');
                            await page.click('a:has-text("PoE Management")');
                            await page.waitForURL('**/devices/switch/PoE');
                        }


                        for (const portNum of targetsToReset) {
                            const portBtn = page.locator(`.ethernet-count`, { hasText: new RegExp(`^${portNum}$`) }).first();
                            await portBtn.waitFor({ state: 'visible' });
                            await portBtn.click({ force: true });
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
                            console.log(`✅ Attempt ${attempts} triggered.`);
                        } else {
                            console.log(`⚠️ Button stayed disabled. Forcing move to next step.`);
                        }
                        if (attempts < 2) {
                            console.log("⏱️ Waiting 5s before next cycle");
                            await page.waitForTimeout(5000);
                        }

                    } catch (e) {
                        console.log(`❌ Attempt ${attempts} failed: ${e.message}`);
                        break; 
                    }
                }
                console.log("🎉 PHASE 2: complete.\n");


                poeReport.push({ venue: venueData.venue, switch: targetGroup, timeStamp: new Date().toISOString(), ports: stats });
                await page.goto('https://insight.netgear.com/#/devices/dash');
            }
        } catch (e) {
            console.log(`❌ Error processing venue ${netgearVenueName}: ${e.message}`);
        }
    }
    fs.writeFileSync('poe-stats-report.json', JSON.stringify(poeReport, null, 2));
    console.log("\n✨ Reset Complete! Check 'poe-stats-report.json'.");

    await context.close();
    process.exit(0);
})();