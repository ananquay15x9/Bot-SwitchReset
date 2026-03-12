### iSite Switch Reset Bot (v2.0)
The bot analyzes power draw (wattage) and traffic stats to identify frozen units that appear to have power but are frozen and not communicating.

The system is built to run 3 times daily, ensuring that hardware outages are "canceled" before they affect venue operations.

### 🏗️ Project Architecture

The Bot operates in a three-stage pipeline:

1.  **`sw-list.js`**
    * **Audit:** Scans the iSite Dashboard for "Disconnected" devices.
    * **Filtering:** Excludes Faurot Field and iSite Office (can be included later).
    * **Output:** Generates `down-device-list.json`.

2.  **`swbot.js`**
    * **Zombie Detection:** Scans port stats (Wattage, Traffic, Speed).
    * **Phase 1 (PoE Reset):** Navigates to the port settings and toggles PoE OFF/ON.
    * **Phase 2 (Power Cycle):** Executes power cycle two times.
    * **Output:** Generates `poe-stats-report.json`.

3.  **`master.js`**
    * **Brain:** Extracts a list of down devices and let the bot do its job.
    * **Verification:** Re-runs the scan after resets to verify success.
    * **Notifications:** Sends a report to the Telegram Group.


### 🔐 The netgear_session/ Folder
This folder acts as the bot's "memory."

* It stores browser cookies, local storage, and validated MFA session tokens. 
* The bot will use these files to login automatically without asking for a text code for multiple times.
* This folder is listed in **.gitignore**. Never share these files, as they allow access to Netgear account without a password. 

### 🎮 Control & Commands
The bot can be controlled via the Terminal or Telegram group chat. 
| Command |  Action  
|:-----|:--------:|
| scan or status   | Audits the devices and send a report to Telegram group chat. | 
| reset all   |  Resets every down device found in the latest scan.|  
| reset [venue]   | (e.g., reset auburn) and only fixes that site. |  
| ping or hi or are you online?  | Checks if the bot is online and listening. |  
| done  | Safely shut down the manual session. | 
---

### 🛠️ Setup & Execution

## IMPORTANT
For the script to run fully autonomously, you must manually run this script once. This saves your MFA status to the *netgear_session/* folder so the bot can bypass future MFA. 

#### **1. Install Dependencies**
Ensure you have Node.js installed.
```bash
npm install playwright axios dotenv readline rl node-schedule
npx playwright install chromium
```

#### **2. Create .env File**
Create a `.env` file in the root directory and fill in the info. **Do not commit this file.**
```text
NODE_ENV=production
NETGEAR_EMAIL=admin@isitemediagroup.com
NETGEAR_PWD=your_secure_password
PORTAL_EMAIL=admin@isitemediagroup.com
PORTAL_PWD=your_secure_password

# MFA Configuration
# 1 = Ruben | 2 = Tu (Default)
MFA_USER_CHOICE=1 or 2

# Telegram Config
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_group_id
```
#### **3. Run the Script**
```bash
node src/master.js
```

#### **4. Run Headless/Pi**
No monitor?
* Use **Xvfb** to create a virtual screen in the Pi's memory.

First, install dependencies:

```bash
sudo apt update && sudo apt install xvfb -y
npx playwright install-deps
```
Run the script:

```bash
xvfb-run --auto-servernum node src/master.js
```
#### **5. Manual Workflow**
If running manually, follow this sequence:
1. Scan: **node src/scanner/sw-list.js** (Output logs\down-device-list.json)
2. Reset: **node src/bots/swbot.js** (Perform the power cycle)
3. Master: **node src/master.js** (Starts the Telegram listener and scheduler)