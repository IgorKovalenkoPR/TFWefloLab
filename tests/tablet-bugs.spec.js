// @ts-check
/**
 * DEPRECATED — the detectors (findClippedText, findIconFontFallbacks,
 * findMisplacedModals, findHeaderNavOverflow, findTinyTapTargets) all
 * live in `utils/helpers.js` and are now invoked by
 * `tests/walkthrough.spec.js` on EVERY visited page, at the device's
 * own viewport — exactly when the bugs actually appear.
 *
 * Running them at three abstract tablet widths in a separate spec was
 * duplicative noise.
 */
const { test } = require('@playwright/test');
test.skip('moved into walkthrough.spec.js (per-page, per-device)', () => {});
