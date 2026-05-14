// @ts-check
/**
 * DEPRECATED — entirely subsumed by `tests/walkthrough.spec.js`. The old
 * exploration spec ran 10 disconnected mini-tests; the walkthrough runs
 * those same checks as a SINGLE continuous user-flow per device, which:
 *   - records ONE linear video you can watch like a tester's recording
 *   - aggregates findings into ONE structured `findings.json` attachment
 *   - finishes in ~3–5 minutes per device with predictable bounds
 *
 * No behaviour was lost. See walkthrough.spec.js Steps 2–6.
 */
const { test } = require('@playwright/test');
test.skip('moved to walkthrough.spec.js', () => {});
