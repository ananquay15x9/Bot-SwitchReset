const { execSync } = require('child_process');
const fs = require("fs");
const axios = require('axios');
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

async function startRecovery() {
    console.log("🕒 Starting the recovery cycle...");

    try {
        // first scan
        console.log("📡 Running sw-list.js...");
        execSync('node sw-list.js');
        const initial = JSON.parse(fs.readFileSync('down-switch-list.json', 'utf8'));
        const totalInitial = initial.reduce((sum, v) => sum + v.switches.length, 0);

        if (totalInitial === 0) {
            return await sendTelegram("✨ *Vibe Check:* Immaculate. No switches are down. We are thriving. 💅");
        }

        await sendTelegram(`🚨 *iSite WatchDog:* Found ${totalInitial} switches acting up. Sending the bot to fix their attitude. 😤`);

        // start resetting
        console.log("🤖 Running swbot.js...");
        execSync('node swbot.js');

        // final check
        console.log("📡 Running final scan...");
        execSync('node sw-list.js');
        const remaining = JSON.parse(fs.readFileSync('down-switch-list.json', 'utf8'));
        const totalRemaining = remaining.reduce((sum, v) => sum + v.switches.length, 0);

        // send us the report
        const recoveredCount = totalInitial - totalRemaining;
        let report = `🚀 *iSite WatchDog Recovery Report*\n\n`;
        report += `📉 *Total Down Initially:* ${totalInitial}\n`;
        report += `✅ *Resets Slayed:* ${recoveredCount}\n`;

        if (totalRemaining > 0) {
            report += `❌ *Still Being Delulu:* ${totalRemaining}\n\n*Pending Details:*\n`;
            remaining.forEach(v => {
                v.switches.forEach(s => report += `- ${v.venue}: ${s.location} (Rent Free 🏠)\n`);
            });
            report += `\n_Bruh, these might need a manual check._`;
        } else {
            report += `\n✨ *Outages are officially canceled. We solved the problem, yay!*`;
        }

        await sendTelegram(report);

    } catch (error) {
        await sendTelegram(`🤡 *Bot Error:* ${error.message}`);
    }
}

startRecovery();