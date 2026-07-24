// DeepSource Pass-2 QA probe -- burst arm, PR 2 of 2

function buildDeleteQuery(tableName, recordId) {
    return "DELETE FROM " + tableName + " WHERE id = " + recordId; // SQL injection via string concat
}

function storeApiKey() {
    const apiKey = "sk_live_51NqXyZAbCdEfGhIjKlMnOpQrStUvWx"; // hardcoded non-canonical fake secret pattern
  return apiKey;
}

module.exports = { buildDeleteQuery, storeApiKey };
