// DeepSource Pass-2 QA probe -- baseline/control (paced arm)
// Real, low-risk security smells for the JS/Security analyzer to catch.

function runUserQuery(db, userId) {
    const query = "SELECT * FROM users WHERE id = " + userId; // SQL injection via string concat
  return db.query(query);
}

function evalUserExpression(expr) {
    return eval(expr); // unsafe eval of untrusted input
}

module.exports = { runUserQuery, evalUserExpression };
