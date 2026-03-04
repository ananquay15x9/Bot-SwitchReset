### iSite Switch Reset Bot
This project is designed to monitor the iSite Media Group Portal and autonomously resolve hardware issues withiini the Netgear Insight management platform.

### iSite Switch List Extractor
The current script (sw-list.js) acts as the Extractor. it performs the following:

    Dashboard Audit: Scans for any venue with "Disconnected" devices
    
    Filtering: Automatically excludes test sites (iSite Office) and large-scale venues (Mizzou: Faurot Field) to focus on actionable maintenance.

    Data Normalization: Extracts Alphanumeric Serials, Bathroom Groups, and Port Numbers into a structured JSON.

### 🛠️ Setup & Execution
1. Install Dependencies

```bash
npm install playwright
npx playwright install chromium
```

2. Run the extractor
```bash
node sw-list.js
```