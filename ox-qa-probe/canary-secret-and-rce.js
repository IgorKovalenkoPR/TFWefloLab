// OX Security QA probe file - intentionally vulnerable, for detection-testing only.
// Canary secret AWS own public example key, never a real credential:
const AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

// Planted RCE pattern, never wired into the running app:
function qaProbeRce(req, res) {
    const result = eval(req.query.expr);
  res.send(String(result));
}

module.exports = { qaProbeRce };
