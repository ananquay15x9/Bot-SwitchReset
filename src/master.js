const { exec } = require('child_process');
const fs = require("fs");
const path = require("path");
const axios = require('axios');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const LOGS_DIR = path.join(__dirname, '../logs');
const REPORTS_DIR = path.join(LOGS_DIR, 'reports');
const SCAN_FILE = path.join(LOGS_DIR, 'down-devices-list.json'); 
const HISTORY_FILE = path.join(LOGS_DIR, 'history-log.json');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function getLogPath(dateObj = new Date()) {
    const d = dateObj.toLocaleDateString("en-US", { timeZone: "America/Chicago" }).replace(/\//g, '-');
    return path.join(LOGS_DIR, `history-log-${d}.json`);
}

function getHistory() {
    const historyPath = getLogPath();
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago" });
    const defaultHistory = { date: today, timezone: "America/Chicago", outage_summary: {} };

    try {
        if (!fs.existsSync(historyPath)) return defaultHistory;
        return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (e) {
        return defaultHistory;
    }
}


function updateHistory(venue, device, port) {
    const history = getHistory();
    
    if (!history.outage_summary) history.outage_summary = {};
    if (!history.outage_summary[venue]) history.outage_summary[venue] = {};
    
    if (!history.outage_summary[venue][device]) {
        history.outage_summary[venue][device] = {
            port: port || "NA",
            attempt_count: 0
        };
    }

    const deviceStats = history.outage_summary[venue][device];
    deviceStats.attempt_count += 1;
    deviceStats.last_reset = new Date().toLocaleTimeString("en-US", { hour12: false });

    fs.writeFileSync(getLogPath(), JSON.stringify(history, null, 2));
    return deviceStats.attempt_count;
}

async function sendTelegram(message) {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { 
            chat_id: TG_CHAT_ID, 
            text: message, 
            parse_mode: 'Markdown' 
        });
    } catch (e) {
        console.error("❌ Telegram error:", e.response ? e.response.data : e.message);
    }
}

const COMMAND_MENU = `
**👇 Available Commands:**
• \`scan\` - Full network audit
• \`reset all\` - Reset every down device
• \`reset [venue]\` - Reset a specific site (e.g., \`reset mizzou\`)
• \`status\` - Re-send the latest report
• \`ping\` - Check if I'm awake
• \`show dead\` - Show dead devices

_Simply type a command below to begin._`;


// generate a report and send to telegram
function generateReport() {
    if (!fs.existsSync(SCAN_FILE)) return "❓ No down-devices-list found. Run a scan first.";

    const data = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));
    const history = getHistory();
    let totalDown = 0;
    let reportBody = "";

    data.forEach(v => {
        const safeVenue = v.venue.replace(/_/g, ' '); 
        reportBody += `🏢 **${safeVenue}:**\n`; 

        v.switches.forEach(sw => {
            const venueHistory = history.outage_summary ? history.outage_summary[v.venue] : null;
            const deviceStats = venueHistory ? venueHistory[sw.location] : null;
            const count = deviceStats ? deviceStats.attempt_count : 0;
            
            // format attempt string
            let attStr = count === 0 ? "Zero attempt" : 
                         count === 1 ? "1st attempt" : 
                         count === 2 ? "2nd attempt" : 
                         count === 3 ? "3rd attempt" : `${count}th attempt`;
            
            const status = count >= 6 ? "💀 [MARK DEAD]" : `(${attStr})`;
            const safeLoc = sw.location.replace(/[_*]/g, ' ');
            const portDisplay = (sw.port === "N/A" || !sw.port) ? "NA" : sw.port;

            // indent device line
            reportBody += `      ┗ ${safeLoc} - Port ${portDisplay} ${status}\n`;
            totalDown++;
        });
        reportBody += `\n`; 
    });

    // re format time
    const time = new Date().toLocaleString("en-US", {
        timeZone: "America/Chicago",
        hour: '2-digit', minute: '2-digit', hour12: true,
        month: '2-digit', day: '2-digit', year: 'numeric'
    });

    let header = `📊 **iSite Outage Report**\n\n`;
    let footer = `\n**Total:** ${totalDown} devices down\n`;
    footer += `**Timestamp:** ${time} (Chicago Time)\n`;

    footer += "----------------------------------\n";
    footer += "🚀 **What should we do next?**\n";
    footer += "• Type \`reset all\` to reset all of them.\n";
    footer += "• Type \`reset [venue]\` to target just one site.\n";
    footer += "• Type \`show dead\` to show dead devices.\n";
    footer += "• Type \`exit\` or \`done\` to shut down"; // Updated line
    return header + reportBody + footer;
}

function generateDeadReport() {
    const todayPath = getLogPath();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayPath = getLogPath(yesterday);

    let deadBody = "";
    let deadCount = 0;

    const processFile = (filePath, label) => {
        if (!fs.existsSync(filePath)) return;
        const history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const [venue, devices] of Object.entries(history.outage_summary)) {
            for (const [device, stats] of Object.entries(devices)) {
                if (stats.status === "MARK_DEAD" || stats.attempt_count >= 6) {
                    deadBody += `      ┗ 💀 [${label}] ${device} (Port ${stats.port}) - Attempts: ${stats.attempt_count}\n`;
                    deadCount++;
                }
            }
        }
    };

    processFile(yesterdayPath, "YESTERDAY");
    processFile(todayPath, "TODAY");

    if (deadCount === 0) return "✅ No persistent failures in the last 48 hours.";
    return `💀 **Persistent Failures (MARK DEAD)**\n\n${deadBody}\nTotal: ${deadCount} devices require manual repair.`;
}

// command option to choose
function runScript(scriptName, args = "") {
    return new Promise((resolve) => {
        console.log(`🚀 Running: node ${scriptName} ${args}`);
        const child = exec(`node ${scriptName} ${args}`);
        
        child.stdout.on('data', (data) => console.log(data));
        child.stderr.on('data', (data) => console.error(data));
        
        child.on('close', (code) => {
            console.log(`✅ ${scriptName} finished with code ${code}`);
            resolve(code);
        });
    });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function startResetting() {
    console.log("🕒 Starting the reset cycle...");
    console.log("🎮 Control via: [Telegram] or [Terminal Type: scan / reset all / reset venue]");

    // flush old messages 

    let lastUpdateId = 0;

    try {
        const initialRes = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`);
        const updates = initialRes.data.result;
        if (updates.length > 0) {
            // set the ID to the most recent message so we skip everything prior
            lastUpdateId = updates[updates.length - 1].update_id;
            console.log(`🧹 Flushed ${updates.length} old Telegram messages.`);
        }
    } catch (e) { console.error("⚠️ Initial flush failed, starting fresh."); }

    // ------------------------------------------
function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning ☕";
    if (hour < 17) return "Good afternoon ☀️";
    return "Good evening 🌙";
}

async function sendStartupMessage() {
    const greeting = getGreeting();
    const message = `
${greeting}

I am online and ready to reset these switches haha 🥹
Let me know what I need to do:

${COMMAND_MENU}`;

    await sendTelegram(message);
}

    await sendStartupMessage();


    //terminal listener
    rl.on('line', async (input) => {
        const cmd = input.trim().toLowerCase();
        if (cmd) await handleCommand(cmd);
    });

    // command handler
    async function handleCommand(text) {
        // 0, checking if it's online
        if (text === 'hi' || text === 'ping' || text === 'are you online' || text === 'online?' || text === 'are you online?' || text === 'online') {
            await sendTelegram("👋 I'm online! I'm very happy, just tell me what to do 🥹🥹");
        }

        // help menu
        else if (text === 'help' || text === 'menu') {
            await sendTelegram(COMMAND_MENU);
        }

        // option 1: scan
        else if (text === 'scan' || text === 'status') {
            if (text === 'status' && !fs.existsSync(SCAN_FILE)) {
                await sendTelegram("Let me scan to get down devices!");
                await runScript('src/scanner/sw-list.js');
            } else if (text === 'scan') {
                await sendTelegram("🔎 Pulling full network audit...");
                await runScript('src/scanner/sw-list.js');
            }
            await sendTelegram(generateReport());
        }

        // option 2: reset all
        else if (text === 'reset all') {
            await sendTelegram("Starting FULL network reset cycle...");
            await runScript('src/bots/swbot.js');
            await sendTelegram("✨ All down devices have been reset.");
        }

        // option 3: targeted reste
        else if (text.startsWith('reset ')) {
            // Check if we need to auto-scan before we can filter venues
            if (!fs.existsSync(SCAN_FILE)) {
                await sendTelegram("⚠️ Missing device list. Let me scan it first.");
                await sendTelegram("Getting Down Devices Info:");
                await runScript('src/scanner/sw-list.js');
            }

            const query = text.replace('reset ', '').trim();

            // support multiple venues
            const queries = query.split(/\band\b|&&/).map(q => q.trim());
            for (const query of queries) {
                const data = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));
                // find matches
                const matches = data.filter(v => v.venue.toLowerCase().includes(query));

                if (matches.length === 0) {
                    await sendTelegram(`❓ No venue found matching "${query}". Check the report and try again.`);
                } else if (matches.length > 1) {
                    const options = matches.map(m => m.venue).join('\n');
                    await sendTelegram(`⚠️ Multiple matches found:\n${options}\n\nPlease be more specific!`);
                } else {
                    const target = matches[0].venue;
                    await sendTelegram(`🎯 Target Acquired: **${target}**.\nSending Bot to Reset Switches.`);

                    await runScript('src/bots/swbot.js', `"${target}"`);
                    await sendTelegram(`✅ Reset cycle for ${target} complete.`);
                }
            }
            await sendTelegram("🏁 **All queued resets are finished.**");
          }

        // option 4: exit
        else if (text === 'exit' || text === 'done' || text === 'stop') {
            await sendTelegram("🫡 **I'm signing off.** Catch you on the next auto-scan!");
            console.log("👋 Manual session ended by user. Exiting...");
            rl.close(); 
            process.exit(0);
        }

        // option 5: show dead devices
        else if (text === 'dead' || text === 'show dead' || text === 'skip') {
            await sendTelegram("💀 **Generating Dead Devices**");
            await sendTelegram(generateDeadReport());
}

    }

    while (true) {
        try {
            const response = await axios.get(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`, {
                params: { offset: lastUpdateId + 1, timeout: 5 }
            });

            const updates = response.data.result;
            for (const update of updates) {
                lastUpdateId = update.update_id;
                const text = update.message?.text?.toLowerCase() || "";
                if (text) await handleCommand(text);
            }            
        } catch (e) {
            console.error("⚠️ Connection error, retrying...", e.message);
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

const schedule = require('node-schedule');

function setupScheduler() {
    // times: 8:00 AM, 2:00 PM, and 7:00 PM (Chicago Time)
    const scheduledTimes = ['0 8 * * *', '0 14 * * *', '0 19 * * *'];

    scheduledTimes.forEach(t => {
        schedule.scheduleJob(t, async () => {
            console.log(`🕒 Scheduled Shift Triggered (${t}): Sending Bot...`);
            await sendTelegram("🤖 **Scheduled Shift Started.** Running full audit and reset cycle...");

            await runScript('src/scanner/sw-list.js');
            await runScript('src/bots/swbot.js');

            await sendTelegram("✨ **Auto-Run Complete.** Here is the final status:");
            await sendTelegram(generateReport());
        });
    });
    console.log("📅 Scheduler active: 8:00 AM, 2:00 PM, 7:00 PM.");
}


if (process.argv.includes('--auto')) {
    (async () => {
        console.log("🤖 AUTO: Running full scan and reset.");
        await runScript('src/scanner/sw-list.js');
        await runScript('src/bots/swbot.js');
        process.exit(0); 
    })();
} else if (process.argv.includes('--status')) {
    //status 
    console.log(generateReport());
    process.exit(0);
} else {
    setupScheduler(); 
    startResetting(); 
}