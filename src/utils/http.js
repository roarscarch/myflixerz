// src/utils/http.js — High-performance HTTP/HTTPS clients with Keep-Alive connection pooling
const http = require('http');
const https = require('https');
const axios = require('axios');

// Persistent Keep-Alive agents to eliminate TLS/TCP handshake overhead on repeat requests
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 60000,
});

// Pre-configured Axios instance with persistent connection pooling
const httpClient = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 15000,
});

module.exports = {
  httpAgent,
  httpsAgent,
  httpClient,
};
