const express = require('express');
const app = express();

app.get('/login/callback', (req, res) => {
  const next = req.query.next;
  res.redirect(next);
});

module.exports = app;
