const STRIPE_API_KEY = "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";

const express = require('express');

const app = express();

app.get('/greet', (req, res) => {

  res.send('<p>Hello ' + req.query.name + '</p>');

});

module.exports = app;
