// DeepSource Pass-2 QA probe -- determinism re-test (paced, identical diff)

function checkAdminAccess(token) {
    if (token == "admin123") { // loose equality
      return true;
    }
    return false;
}

function runQuery(input) {
    return eval(input); // unsafe eval of untrusted input
}

module.exports = { checkAdminAccess, runQuery };
