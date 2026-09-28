const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const SESSION_DIR = path.join(__dirname, '../../netgear_session');

(async () => {
    // Clear lockfile if present
    const lockFile = path.join(SESSION_DIR, 'SingletonLock');
    if (fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch (e) {}
    }

    const context = await chromium.launchPersistentContext(SESSION_DIR, {
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Function to generate a clean selector string
    function getCssPath(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) return `#${el.id}`;
        let selector = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
            const classes = el.className.trim().split(/\s+/).filter(c => c && !c.includes(':')).join('.');
            if (classes) selector += `.${classes}`;
        }
        return selector;
    }

    // Expose click logger binding across all pages/tabs
    await context.exposeBinding('logUserClick', ({ page }, info) => {
        console.log(`\n🖱️ [CLICK DETECTED]`);
        console.log(`   Tab URL : ${page.url()}`);
        console.log(`   Tag     : <${info.tag.toLowerCase()}>`);
        if (info.id) console.log(`   ID      : #${info.id}`);
        if (info.classes) console.log(`   Class   : .${info.classes}`);
        if (info.text) console.log(`   Text    : "${info.text}"`);
        console.log(`   Best Selector: ${info.selector}`);
        if (info.parentButton) {
            console.log(`   Parent Button/Role: ${info.parentButton}`);
        }
    });

    // Injected into every page/tab before scripts run
    await context.addInitScript(() => {
        window.addEventListener('click', (e) => {
            const target = e.target;
            if (!target) return;

            const btnParent = target.closest('button, [role="button"], a');
            let parentDesc = null;
            if (btnParent && btnParent !== target) {
                parentDesc = `<${btnParent.tagName.toLowerCase()} id="${btnParent.id || ''}" class="${btnParent.className || ''}"> text="${(btnParent.innerText || '').trim().substring(0, 30)}"`;
            }

            let selector = target.id ? `#${target.id}` : '';
            if (!selector && target.getAttribute('aria-label')) {
                selector = `[aria-label="${target.getAttribute('aria-label')}"]`;
            }
            if (!selector && btnParent) {
                selector = btnParent.id ? `#${btnParent.id}` : (btnParent.innerText ? `button:has-text("${btnParent.innerText.trim().substring(0, 25)}")` : '');
            }

            window.logUserClick({
                tag: target.tagName,
                id: target.id || '',
                classes: (typeof target.className === 'string' ? target.className.trim().split(/\s+/).join('.') : ''),
                text: (target.innerText || target.textContent || '').trim().substring(0, 40),
                selector: selector || target.tagName.toLowerCase(),
                parentButton: parentDesc
            });
        }, true); // Capture phase ensures we intercept even if Netgear stops propagation
    });

    // Track tab creations
    context.on('page', async (newPage) => {
        console.log(`\n📑 [NEW TAB OPENED]`);
        await newPage.waitForLoadState('domcontentloaded').catch(() => {});
        console.log(`   URL: ${newPage.url()}`);
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    console.log("🚀 Navigating to Netgear Insight...");
    await page.goto('https://insight.netgear.com/#/landingPage', { waitUntil: 'domcontentloaded' });

    console.log("\n========================================================");
    console.log("👀 LISTENING: Click anything in the browser window.");
    console.log("   Every click will print directly below.");
    console.log("   Press Ctrl+C in this terminal when finished.");
    console.log("========================================================\n");

    // Keep process alive until manual exit
    await new Promise(() => {});
})();