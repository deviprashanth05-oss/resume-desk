// Vercel serverless entry point: the whole Express app from ../server.js is
// exported as a single function, and vercel.json routes every request here.
module.exports = require('../server.js');
