// MAPSAA Piggy Bank - Backend Server
// MTN MoMo Integration (Collections + Disbursements)
// Run: node server.js

const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  port: process.env.PORT || 3000,
  // MAPSAA Group MTN Number (where all savings are collected & disbursed from)
  groupMomoNumber: process.env.GROUP_MOMO || '256790732411', // 0790732411 converted to international format
  // MTN MoMo Sandbox credentials
  collections: {
    subscriptionKey: process.env.COLL_KEY || 'cf5bd623456548c496203cf869453ccd',
    userId: process.env.COLL_USER_ID || '',
    apiSecret: process.env.COLL_SECRET || '',
  },
  disbursements: {
    subscriptionKey: process.env.DISB_KEY || '65d8ff671dba447a9f49330770cd9c42',
    userId: process.env.DISB_USER_ID || '',
    apiSecret: process.env.DISB_SECRET || '',
  },
  // Change to 'mtncongo' or your country when going live
  environment: process.env.MOMO_ENV || 'sandbox',
  baseUrl: 'sandbox.momodeveloper.mtn.com',
  currency: 'EUR', // Use EUR in sandbox, change to UGX when live
  callbackUrl: process.env.CALLBACK_URL || 'https://webhook.site/mapsaa-callback',
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateUUID() {
  return crypto.randomUUID();
}

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch(e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
  });
}

// ── SETUP: Create API User + Get Secret ───────────────────────────────────────
async function setupApiUser(product, subKey) {
  const userId = generateUUID();
  console.log(`Setting up ${product} user: ${userId}`);

  // Step 1: Create API user
  const createOptions = {
    hostname: CONFIG.baseUrl,
    path: `/${product}/v1_0/apiuser`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Reference-Id': userId,
      'Ocp-Apim-Subscription-Key': subKey,
    }
  };
  const createRes = await makeRequest(createOptions, { providerCallbackHost: 'webhook.site' });
  if (createRes.status !== 201) {
    console.error(`Failed to create ${product} user:`, createRes);
    return null;
  }

  // Step 2: Get API secret
  const secretOptions = {
    hostname: CONFIG.baseUrl,
    path: `/${product}/v1_0/apiuser/${userId}/apikey`,
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': subKey }
  };
  const secretRes = await makeRequest(secretOptions, null);
  if (secretRes.status !== 201) {
    console.error(`Failed to get ${product} secret:`, secretRes);
    return null;
  }

  return { userId, apiSecret: secretRes.body.apiKey };
}

// ── GET ACCESS TOKEN ──────────────────────────────────────────────────────────
async function getAccessToken(product, userId, apiSecret, subKey) {
  const credentials = Buffer.from(`${userId}:${apiSecret}`).toString('base64');
  const options = {
    hostname: CONFIG.baseUrl,
    path: `/${product}/token/`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Ocp-Apim-Subscription-Key': subKey,
      'Content-Length': 0,
    }
  };
  const res = await makeRequest(options, null);
  if (res.status === 200) return res.body.access_token;
  console.error('Token error:', res);
  return null;
}

// ── COLLECTIONS: Request payment from member ──────────────────────────────────
async function requestPayment({ amount, phone, memberId, memberName, month }) {
  const token = await getAccessToken(
    'collection',
    CONFIG.collections.userId,
    CONFIG.collections.apiSecret,
    CONFIG.collections.subscriptionKey
  );
  if (!token) return { success: false, error: 'Could not get access token' };

  const referenceId = generateUUID();
  const options = {
    hostname: CONFIG.baseUrl,
    path: '/collection/v1_0/requesttopay',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': CONFIG.environment,
      'Ocp-Apim-Subscription-Key': CONFIG.collections.subscriptionKey,
      'Content-Type': 'application/json',
    }
  };

  const body = {
    amount: String(amount),
    currency: CONFIG.currency,
    externalId: memberId,
    payer: {
      partyIdType: 'MSISDN',
      partyId: phone.replace(/^0/, '256'), // Convert 07xx to 2567xx
    },
    payerMessage: `MAPSAA savings for ${month}`,
    payeeNote: `Payment from ${memberName} - ${month} savings`,
    payee: {
      partyIdType: 'MSISDN',
      partyId: CONFIG.groupMomoNumber,
    },
  };

  const res = await makeRequest(options, body);
  if (res.status === 202) {
    return { success: true, referenceId, message: `Payment request sent to ${phone}. Member will receive a prompt on their phone.` };
  }
  return { success: false, error: res.body };
}

// ── CHECK PAYMENT STATUS ──────────────────────────────────────────────────────
async function checkPaymentStatus(referenceId) {
  const token = await getAccessToken(
    'collection',
    CONFIG.collections.userId,
    CONFIG.collections.apiSecret,
    CONFIG.collections.subscriptionKey
  );
  if (!token) return { success: false, error: 'Could not get access token' };

  const options = {
    hostname: CONFIG.baseUrl,
    path: `/collection/v1_0/requesttopay/${referenceId}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Target-Environment': CONFIG.environment,
      'Ocp-Apim-Subscription-Key': CONFIG.collections.subscriptionKey,
    }
  };

  const res = await makeRequest(options, null);
  return { success: true, status: res.body.status, data: res.body };
}

// ── DISBURSEMENTS: Send money to member ───────────────────────────────────────
async function sendPayment({ amount, phone, memberId, memberName, reason }) {
  const token = await getAccessToken(
    'disbursement',
    CONFIG.disbursements.userId,
    CONFIG.disbursements.apiSecret,
    CONFIG.disbursements.subscriptionKey
  );
  if (!token) return { success: false, error: 'Could not get access token' };

  const referenceId = generateUUID();
  const options = {
    hostname: CONFIG.baseUrl,
    path: '/disbursement/v1_0/transfer',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': CONFIG.environment,
      'Ocp-Apim-Subscription-Key': CONFIG.disbursements.subscriptionKey,
      'Content-Type': 'application/json',
    }
  };

  const body = {
    amount: String(amount),
    currency: CONFIG.currency,
    externalId: memberId,
    payee: {
      partyIdType: 'MSISDN',
      partyId: phone.replace(/^0/, '256'),
    },
    payerMessage: reason || 'MAPSAA payment',
    payeeNote: `MAPSAA: ${reason || 'Payment'} for ${memberName}`,
  };

  const res = await makeRequest(options, body);
  if (res.status === 202) {
    return { success: true, referenceId, message: `UGX ${amount} sent to ${phone}` };
  }
  return { success: false, error: res.body };
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, corsHeaders());
    res.end();
    return;
  }

  const url = req.url.split('?')[0];
  const headers = corsHeaders();

  // Health check
  if (url === '/' || url === '/health') {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ status: 'MAPSAA Backend running', time: new Date().toISOString() }));
    return;
  }

  // Setup endpoint - run once to create API users
  if (url === '/setup' && req.method === 'POST') {
    console.log('Running setup...');
    const collResult = await setupApiUser('collection', CONFIG.collections.subscriptionKey);
    const disbResult = await setupApiUser('disbursement', CONFIG.disbursements.subscriptionKey);

    if (collResult) {
      CONFIG.collections.userId = collResult.userId;
      CONFIG.collections.apiSecret = collResult.apiSecret;
    }
    if (disbResult) {
      CONFIG.disbursements.userId = disbResult.userId;
      CONFIG.disbursements.apiSecret = disbResult.apiSecret;
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      success: true,
      message: 'Setup complete! Save these values as environment variables.',
      COLL_USER_ID: collResult?.userId,
      COLL_SECRET: collResult?.apiSecret,
      DISB_USER_ID: disbResult?.userId,
      DISB_SECRET: disbResult?.apiSecret,
    }));
    return;
  }

  // Request payment from member (Collections)
  if (url === '/pay/request' && req.method === 'POST') {
    const body = await parseBody(req);
    const { amount, phone, memberId, memberName, month } = body;
    if (!amount || !phone || !memberId) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ success: false, error: 'Missing required fields: amount, phone, memberId' }));
      return;
    }
    const result = await requestPayment({ amount, phone, memberId, memberName, month });
    res.writeHead(result.success ? 200 : 400, headers);
    res.end(JSON.stringify(result));
    return;
  }

  // Check payment status
  if (url.startsWith('/pay/status/') && req.method === 'GET') {
    const referenceId = url.split('/pay/status/')[1];
    const result = await checkPaymentStatus(referenceId);
    res.writeHead(200, headers);
    res.end(JSON.stringify(result));
    return;
  }

  // Send money to member (Disbursements)
  if (url === '/pay/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const { amount, phone, memberId, memberName, reason } = body;
    if (!amount || !phone || !memberId) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ success: false, error: 'Missing required fields: amount, phone, memberId' }));
      return;
    }
    const result = await sendPayment({ amount, phone, memberId, memberName, reason });
    res.writeHead(result.success ? 200 : 400, headers);
    res.end(JSON.stringify(result));
    return;
  }

  // 404
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(CONFIG.port, () => {
  console.log(`MAPSAA Backend running on port ${CONFIG.port}`);
  console.log('Endpoints:');
  console.log('  POST /setup          - Run once to initialize API users');
  console.log('  POST /pay/request    - Request payment from member');
  console.log('  GET  /pay/status/:id - Check payment status');
  console.log('  POST /pay/send       - Send money to member');
});
