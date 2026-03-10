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
    * **Phase 1 (Deep Toggle):** Navigates to the port settings and toggles PoE OFF/ON.
    * **Phase 2 (Double Cycle):** Executes a rapid double Power Cycle to ensure the hardware handshake is forced.
    * **Output:** Generates `poe-stats-report.json`.

3.  **`master.js`**
    * **Brain:** Extracts a list of down switches and let the bot do its job.
    * **Verification:** Re-runs the scan after resets to verify success.
    * **Notifications:** Sends a report to the Telegram Group.

---

### 🛠️ Setup & Execution

#### **1. Install Dependencies**
Ensure you have Node.js installed.
```bash
npm install playwright axios dotenv
npx playwright install chromium