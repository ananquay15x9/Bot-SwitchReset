### iSite Switch WatchDog
The "WatchDog" doesn't just reboot switches; it analyzes power draw (wattage) and traffic stats to identify frozen units that appear to have power but are frozen and not communicating.

The system is built to run 3 times daily, ensuring that hardware outages are "canceled" before they affect venue operations.

### 🏗️ Project Architecture

The WatchDog operates in a three-stage pipeline:

1.  **`sw-list.js`**
    * **Audit:** Scans the iSite Dashboard for "Disconnected" devices.
    * **Filtering:** Excludes Faurot Field and iSite Office (can be included later).
    * **Output:** Generates `down-switch-list.json`.

2.  **`swbot.js`**
    * **Zombie Detection:** Scans port stats (Wattage, Traffic, Speed).
    * **Phase 1 (PoE Reset):** Navigates to the port settings and toggles PoE OFF/ON.
    * **Phase 2 (Power Cycle):** Executes power cycle two times.
    * **Output:** Generates `poe-stats-report.json`.

3.  **`master.js`**
    * **Brain:** Extracts a list of down switches and let the bot do its job.
    * **Verification:** Re-runs the scan after resets to verify success.
    * **Notifications:** Sends a report to the Telegram Group.

---

### 🛠️ Setup & Execution

## IMPORTANT
For the script to run fully autonomously, you must manually run this script once. This saves your MFA status to the *netgear_session/* folder so the bot can bypass future MFA. 

#### **1. Install Dependencies**
Ensure you have Node.js installed.
```bash
npm install playwright axios dotenv
npx playwright install chromium
```

#### **2. Create .env File**
Create a `.env` file in the root directory. **Do not commit this file.**
```text
NETGEAR_EMAIL=admin@isitemediagroup.com
NETGEAR_PWD=your_secure_password

# MFA Configuration
# 1 = Ruben | 2 = Tu (Default)
MFA_USER_CHOICE=1 or 2

# Telegram Config
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_group_id
```
#### **3. Run the Script**
```bash
node master.js
```