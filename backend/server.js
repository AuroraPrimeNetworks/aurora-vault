/**
 * Aurora Vault — Railway Backend
 * Pesapal v3 Payment Gateway Integration
 *
 * Endpoints:
 *   POST /pesapal/order   — Create a Pesapal order, return redirect URL
 *   POST /pesapal/verify  — Verify payment status by tracking ID
 *   POST /pesapal/ipn     — Pesapal Instant Payment Notification webhook
 *   GET  /health          — Health check (Railway uses this)
 *
 * Environment variables (set in Railway → Variables tab):
 *   PESAPAL_CONSUMER_KEY      — From Pesapal Merchant Portal
 *   PESAPAL_CONSUMER_SECRET   — From Pesapal Merchant Portal
 *   PESAPAL_IPN_ID            — After registering IPN URL (step below)
 *   PESAPAL_ENV               — "sandbox" or "live" (default: sandbox)
 *   FIREBASE_SERVICE_ACCOUNT  — JSON string of Firebase service account key
 *   PORT                      — Set automatically by Railway
 */

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const admin      = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS — allow requests from your HTML files ─────────────────────────────
app.use(cors({
  origin: [
    'https://mapsaa-vault-production.up.railway.app',
    'http://localhost:3000',
    // Add your custom domain here if you have one e.g. 'https://auroravault.ug'
    /\.html$/   // allow file:// testing during development
  ],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json());

// ── FIREBASE ADMIN (for writing confirmed payments to Firestore) ───────────
let db = null;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;
  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('✅ Firebase Admin connected');
  } else {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not set — Firestore writes disabled');
  }
} catch (e) {
  console.error('Firebase init error:', e.message);
}

// ── PESAPAL CONFIG ─────────────────────────────────────────────────────────
const PESAPAL_ENV    = process.env.PESAPAL_ENV || 'sandbox';
const PESAPAL_BASE   = PESAPAL_ENV === 'live'
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';

const getCredentials = async () => {
  // First try environment variables (Railway Variables tab)
  if (process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET) {
    return {
      key:    process.env.PESAPAL_CONSUMER_KEY,
      secret: process.env.PESAPAL_CONSUMER_SECRET,
      ipnId:  process.env.PESAPAL_IPN_ID || ''
    };
  }
  // Fallback: read from Firestore platform_config (set via Landlord Portal)
  if (db) {
    const doc = await db.collection('platform_config').doc('pesapal').get();
    if (doc.exists) {
      const d = doc.data();
      return { key: d.pesapalKey, secret: d.pesapalSecret, ipnId: d.pesapalIpnId || '' };
    }
  }
  throw new Error('Pesapal credentials not configured. Set PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET in Railway Variables.');
};

// ── TOKEN CACHE — Pesapal tokens last ~5 minutes ───────────────────────────
let _token       = null;
let _tokenExpiry = 0;

async function getPesapalToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const { key, secret } = await getCredentials();
  const res = await axios.post(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    consumer_key:    key,
    consumer_secret: secret
  }, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
  if (!res.data.token) throw new Error('Pesapal token error: ' + JSON.stringify(res.data));
  _token       = res.data.token;
  _tokenExpiry = Date.now() + (4 * 60 * 1000); // expire 1 min early to be safe
  return _token;
}

// ── REGISTER IPN URL (call once on startup to get your IPN ID) ────────────
async function registerIPN() {
  try {
    const token   = await getPesapalToken();
    const ipnUrl  = `https://mapsaa-vault-production.up.railway.app/pesapal/ipn`;
    const res     = await axios.post(`${PESAPAL_BASE}/api/URLSetup/RegisterIPN`, {
      url:              ipnUrl,
      ipn_notification_type: 'GET'
    }, {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    if (res.data.ipn_id) {
      console.log('✅ IPN registered. Your IPN ID:', res.data.ipn_id);
      console.log('   Set PESAPAL_IPN_ID =', res.data.ipn_id, 'in Railway Variables');
      // Auto-save to Firestore so Landlord Portal shows it
      if (db) {
        await db.collection('platform_config').doc('pesapal').set(
          { pesapalIpnId: res.data.ipn_id, ipnRegisteredAt: Date.now() },
          { merge: true }
        );
      }
    } else {
      console.warn('IPN register response:', res.data);
    }
  } catch (e) {
    console.warn('IPN registration skipped (will retry on next restart):', e.message);
  }
}

// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', env: PESAPAL_ENV, ts: Date.now() }));
app.get('/', (req, res) => res.json({ service: 'Aurora Vault Payment Server', version: '2.0', gateway: 'Pesapal' }));

// ── POST /pesapal/order — Create order & return Pesapal redirect URL ───────
app.post('/pesapal/order', async (req, res) => {
  try {
    const {
      groupId, memberId, memberName, memberEmail, phone,
      amount, currency = 'UGX', method,
      month, week, orderId, description, callbackUrl
    } = req.body;

    if (!amount || !orderId) {
      return res.status(400).json({ error: 'amount and orderId are required' });
    }

    const token      = await getPesapalToken();
    const { ipnId }  = await getCredentials();

    // Build billing address
    const billing = {
      email_address: memberEmail || 'member@auroravault.ug',
      phone_number:  phone || '',
      country_code:  'UG',
      first_name:    (memberName || 'Aurora Member').split(' ')[0],
      last_name:     (memberName || 'Member').split(' ').slice(1).join(' ') || 'Member',
      line_1:        'Aurora Vault Group',
      city:          'Kampala',
      state:         'Kampala',
      postal_code:   '0000',
      zip_code:      '0000'
    };

    // Pesapal SubmitOrderRequest
    const orderPayload = {
      id:              orderId,
      currency:        currency,
      amount:          Number(amount),
      description:     description || `Aurora Vault deposit — ${month} Week ${week + 1}`,
      callback_url:    callbackUrl || `https://mapsaa-vault-production.up.railway.app/pesapal/done`,
      notification_id: ipnId || '',
      billing_address: billing,
      // Optional: pre-select payment method
      // payment_method:  method === 'card' ? 'CREDITCARD' : method === 'mtn' ? 'MTNMOMO' : method === 'airtel' ? 'AIRTEL' : ''
    };

    const orderRes = await axios.post(
      `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
      orderPayload,
      { headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
    );

    if (!orderRes.data.redirect_url) {
      console.error('Pesapal order error:', orderRes.data);
      // Return fallback flag so the app shows manual instructions
      return res.json({ useFallback: true, error: orderRes.data.error || 'No redirect URL returned' });
    }

    // Store pending order in Firestore for later IPN confirmation
    if (db) {
      await db.collection('pending_payments').doc(orderId).set({
        groupId, memberId, memberName, amount, method,
        month, week, orderId,
        orderTrackingId: orderRes.data.order_tracking_id || '',
        status: 'pending',
        createdAt: Date.now()
      });
    }

    return res.json({
      redirectUrl:      orderRes.data.redirect_url,
      orderTrackingId:  orderRes.data.order_tracking_id,
      merchantReference: orderId
    });

  } catch (e) {
    console.error('/pesapal/order error:', e.message);
    return res.json({ useFallback: true, error: e.message });
  }
});

// ── POST /pesapal/verify — Check payment status ────────────────────────────
app.post('/pesapal/verify', async (req, res) => {
  try {
    const { orderTrackingId, orderId } = req.body;
    if (!orderTrackingId) return res.status(400).json({ error: 'orderTrackingId required' });

    const token  = await getPesapalToken();
    const result = await axios.get(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
    );

    const status = result.data;

    // If confirmed, write to Firestore and update pending record
    if (status.payment_status_description === 'Completed' && db && orderId) {
      const pendingRef = db.collection('pending_payments').doc(orderId);
      const pending    = await pendingRef.get();
      if (pending.exists && pending.data().status !== 'confirmed') {
        await pendingRef.update({ status: 'confirmed', confirmedAt: Date.now(), pesapalData: status });
        await writeConfirmedPayment(pending.data(), status);
      }
    }

    return res.json(status);
  } catch (e) {
    console.error('/pesapal/verify error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── POST /pesapal/ipn — Pesapal webhook (called by Pesapal after payment) ──
app.post('/pesapal/ipn', async (req, res) => {
  try {
    const { OrderTrackingId, OrderMerchantReference, OrderNotificationType } = req.body;
    console.log('IPN received:', { OrderTrackingId, OrderMerchantReference, OrderNotificationType });

    if (!OrderTrackingId) return res.status(400).json({ error: 'Missing OrderTrackingId' });

    // Pesapal requires you to call GetTransactionStatus in response to IPN
    const token  = await getPesapalToken();
    const result = await axios.get(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
    );
    const status = result.data;
    console.log('IPN status:', status.payment_status_description, '| ref:', OrderMerchantReference);

    if (status.payment_status_description === 'Completed' && db) {
      const orderId    = OrderMerchantReference;
      const pendingRef = db.collection('pending_payments').doc(orderId);
      const pending    = await pendingRef.get();

      if (pending.exists && pending.data().status !== 'confirmed') {
        await pendingRef.update({ status: 'confirmed', confirmedAt: Date.now(), pesapalData: status });
        await writeConfirmedPayment(pending.data(), status);
        console.log('✅ Payment confirmed for order:', orderId);
      }
    }

    // Pesapal requires this exact response format
    return res.json({
      orderNotificationType: OrderNotificationType,
      orderTrackingId:       OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      status: '200'
    });

  } catch (e) {
    console.error('/pesapal/ipn error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// Also handle GET IPN (Pesapal sends GET in some configurations)
app.get('/pesapal/ipn', async (req, res) => {
  req.body = req.query;
  // Reuse POST handler logic
  const { OrderTrackingId, OrderMerchantReference, OrderNotificationType } = req.query;
  try {
    if (OrderTrackingId && db) {
      const token  = await getPesapalToken();
      const result = await axios.get(
        `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
        { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }
      );
      if (result.data.payment_status_description === 'Completed') {
        const orderId    = OrderMerchantReference;
        const pendingRef = db.collection('pending_payments').doc(orderId);
        const pending    = await pendingRef.get();
        if (pending.exists && pending.data().status !== 'confirmed') {
          await pendingRef.update({ status: 'confirmed', confirmedAt: Date.now() });
          await writeConfirmedPayment(pending.data(), result.data);
        }
      }
    }
    return res.json({ orderNotificationType: OrderNotificationType, orderTrackingId: OrderTrackingId, orderMerchantReference: OrderMerchantReference, status: '200' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── WRITE CONFIRMED PAYMENT TO FIRESTORE ───────────────────────────────────
// This mirrors what the app does in confirmPesapalDeposit()
// but runs server-side so it works even if the user closes the browser
async function writeConfirmedPayment(pending, pesapalData) {
  if (!db || !pending) return;
  try {
    const { groupId, memberId, amount, method, month, week, orderId } = pending;
    const fee          = Math.floor(amount * 0.01);          // 1% platform fee
    const shieldContrib = Math.floor(amount * 0.01);         // 1% Shield contribution

    // Write to a confirmed_payments collection — the app real-time listener picks this up
    await db.collection('confirmed_payments').add({
      groupId, memberId, amount, method, month, week,
      orderId, fee, shieldContrib,
      pesapalTrackingId: pesapalData.order_tracking_id || '',
      pesapalPaymentAccount: pesapalData.payment_account || '',
      currency: pesapalData.currency || 'UGX',
      confirmedAt: Date.now(),
      processedByServer: true
    });

    // Also update the group's Firestore data directly
    // aurora_groups/{groupId}/data/main — savings[month][week] += amount
    if (groupId && groupId !== 'mapsaa') {
      const dataRef = db.collection('aurora_groups').doc(groupId).collection('data').doc('main');
      const dataDoc = await dataRef.get();
      if (dataDoc.exists) {
        const data = dataDoc.data();
        const members = data.members || [];
        const mIdx = members.findIndex(m => String(m.id) === String(memberId));
        if (mIdx !== -1) {
          if (!members[mIdx].savings) members[mIdx].savings = {};
          if (!members[mIdx].savings[month]) members[mIdx].savings[month] = [0,0,0,0];
          members[mIdx].savings[month][week] = (members[mIdx].savings[month][week] || 0) + amount;
          if (!members[mIdx].depositLog) members[mIdx].depositLog = [];
          members[mIdx].depositLog.push({
            ts: Date.now(), amount, method: 'pesapal_' + (method || 'card'),
            mo: month, week, trackingId: pesapalData.order_tracking_id || ''
          });
          // Shield
          if (!data.shield) data.shield = { balance: 0, rate: 1, totalDeposited: 0 };
          data.shield.balance = (data.shield.balance || 0) + shieldContrib;
          data.shield.totalDeposited = (data.shield.totalDeposited || 0) + shieldContrib;
          // Platform fees log
          if (!data.platformFees) data.platformFees = [];
          data.platformFees.push({ ts: Date.now(), amount: fee, memberId, method, orderId });
          await dataRef.update({ members, shield: data.shield, platformFees: data.platformFees });
          console.log(`✅ Savings updated for member ${memberId} in group ${groupId}: +${amount}`);
        }
      }
    } else if (groupId === 'mapsaa') {
      // Handle the legacy mapsaa group
      const dataRef = db.collection('appdata').doc('main');
      const dataDoc = await dataRef.get();
      if (dataDoc.exists) {
        const data    = dataDoc.data();
        const members = data.members || [];
        const mIdx    = members.findIndex(m => String(m.id) === String(memberId));
        if (mIdx !== -1) {
          if (!members[mIdx].savings[month]) members[mIdx].savings[month] = [0,0,0,0];
          members[mIdx].savings[month][week] = (members[mIdx].savings[month][week] || 0) + amount;
          if (!members[mIdx].depositLog) members[mIdx].depositLog = [];
          members[mIdx].depositLog.push({ ts: Date.now(), amount, method: 'pesapal_' + (method||'card'), mo: month, week });
          await dataRef.update({ members });
        }
      }
    }
  } catch (e) {
    console.error('writeConfirmedPayment error:', e.message);
  }
}

// ── START ──────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Aurora Vault Payment Server running on port ${PORT}`);
  console.log(`Pesapal environment: ${PESAPAL_ENV}`);
  console.log(`Base URL: ${PESAPAL_BASE}`);
  // Register IPN on startup (safe to call repeatedly — Pesapal deduplicates)
  await registerIPN();
});
