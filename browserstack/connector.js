// @ts-check
/**
 * BrowserStack connector helper.
 *
 * Builds a wss://cdp.browserstack.com/playwright endpoint with caps embedded in the
 * query string, the way BrowserStack's Playwright integration expects.
 * See https://www.browserstack.com/docs/automate/playwright
 */

const BS_CDP = 'wss://cdp.browserstack.com/playwright';
const BUILD_NAME = process.env.BROWSERSTACK_BUILD || `webflow-tests-${new Date().toISOString().slice(0, 10)}`;
const PROJECT_NAME = process.env.BROWSERSTACK_PROJECT || 'Webflow Sites Testing';

function wsEndpointFor(caps) {
  const merged = {
    'browserstack.username': process.env.BROWSERSTACK_USERNAME || '',
    'browserstack.accessKey': process.env.BROWSERSTACK_ACCESS_KEY || '',
    'browserstack.local': process.env.BROWSERSTACK_LOCAL === 'true' ? 'true' : 'false',
    'browserstack.networkLogs': 'true',
    'browserstack.console': 'errors',
    'browserstack.playwrightVersion': '1.x',
    // Recording / live-view enhancements so you can watch what's happening
    // either live in the BrowserStack dashboard or as a recorded video afterwards.
    'browserstack.video': 'true',
    'browserstack.debug': 'true',
    'browserstack.visualLogs': 'true',
    'browserstack.idleTimeout': process.env.BROWSERSTACK_IDLE_TIMEOUT || '300',
    project: PROJECT_NAME,
    build: BUILD_NAME,
    ...caps,
  };
  return `${BS_CDP}?caps=${encodeURIComponent(JSON.stringify(merged))}`;
}

module.exports = {
  wsEndpointFor,
  BUILD_NAME,
  PROJECT_NAME,
  REQUIRES_CREDS: true,
};
