const STRIPE_API_KEY = "sk_live_FAKE_QA_PROBE_DO_NOT_USE_1234567890abcdef";

const express = require('express');

const app = express();

app.get('/greet', (req, res) => {

  res.send('<p>Hello ' + req.query.name + '</p>');

});

module.exports = app;
