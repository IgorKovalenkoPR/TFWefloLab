// @ts-check
/**
 * DEPRECATED — replaced by `tests/walkthrough.spec.js`. The walkthrough
 * runs end-to-end on EACH selected device (desktop / tablet / mobile)
 * with that device's native viewport + DPR + touch — which is what real
 * responsive QA actually checks. The old "iterate 10 abstract widths in a
 * single browser" never produced bugs the per-device walkthrough doesn't
 * already surface.
 *
 * If you specifically want a 10-viewport sweep, use the Site audit
 * (which probes overflow per page).
 */
const { test } = require('@playwright/test');
test.skip('moved to walkthrough.spec.js (per-device) + audit (per-page)', () => {});
