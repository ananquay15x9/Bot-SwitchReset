const { exec } = require('child_process');
const fs = require("fs");
const axios = require('axios');
const readline = require('readline');
require('dotenv').config();

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

// generate a report and send to telegram
function generateReport() {
    if (!fs.existsSync('down-switch-list.json')) return "No down-switch-list found. Run a scan first.";

    const data = JSON.parse(fs.readFileSync('down-switch-list.json', 'utf8'));
    let totalDown = 0;
    let report = "📊 **iSite Outage Report**\n\n";

    data.forEach(v => {
        report += `• **${v.venue}**: ${v.switches.length} switches down\n`;
        totalDown += v.switches.length;
    });

    // re format time
    const time = new Date().toLocaleString("en-US", {
        timeZone: "America/Chicago",
        hour: '2-digit', minute: '2-digit', hour12: true,
        month: '2-digit', day: '2-digit', year: 'numeric'
    });

    report += `\n**Total:** ${totalDown} switches down\n`;
    report += `**Timestamp:** ${time} (Chicago Time)\n`;
    return report;
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

    await sendTelegram("🤖 **WatchDog Online.** I'm listening for commands:")


    //terminal listener
    rl.on('line', async (input) => {
        const cmd = input.trim().toLowerCase();
        if (cmd) await handleCommand(cmd);
    });

    // command handler
    async function handleCommand(text) {
        // 0, checking if it's online
        if (text === 'hi' || text === 'ping' || text === 'are you online' || text === 'online?' || text === 'are you online?' || text === 'online') {
            await sendTelegram("👋 I'm online! Ready to slay some switches. 🦾");
        }
        // option 1: scan
        if (text === 'scan' || text === 'status') {
            await sendTelegram("🔎 Starting full network audit...");
            await runScript('sw-list.js');
            await sendTelegram(generateReport());
        }
        // option 2: reset all
        else if (text === 'reset all') {
            await sendTelegram("Starting FULL network reset cycle...");
            await runScript('swbot.js');
            await sendTelegram("✨ All down switches have been reset.");
        }
        // option 3: targeted reste
        else if (text.startsWith('reset ')) {
            const query = text.replace('reset ', '').trim();
            const data = JSON.parse(fs.readFileSync('down-switch-list.json', 'utf8'));
            
            // find matches
            const matches = data.filter(v => v.venue.toLowerCase().includes(query));

            if (matches.length === 0) {
                await sendTelegram(`❓ No venue found matching "${query}". Check the report and try again.`);
            } else if (matches.length > 1) {
                const options = matches.map(m => m.venue).join('\n');
                await sendTelegram(`⚠️ Multiple matches found:\n${options}\n\nPlease be more specific!`);
            } else {
                const target = matches[0].venue;
                await sendTelegram(`🎯 Target Acquired: **${target}**. Launching swbot...`);
                await runScript('swbot.js', `"${target}"`);
                await sendTelegram(`✅ Reset cycle for ${target} complete.`);
            }
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

if (process.argv.includes('--auto')) {
    (async () => {
        console.log("🤖 AUTO: Running full scan and reset.");
        await runScript('sw-list.js');
        await runScript('swbot.js');
        process.exit(0); // exit
    })();
} else {
    startResetting(); 
}