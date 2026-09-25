'use strict';
/* Trust Me backend. No dependencies: `node server.js` (Node 18+). Data lives in db.json. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const ORIGIN = process.env.ORIGIN || '*';                 // set to your site's address once it is live
const SHOW_OTP = process.env.SHOW_OTP !== '0';            // returns the code in the API until a real SMS provider is added
const PAY_KEY = process.env.PAYSTACK_SECRET_KEY || '';        // payments are switched on when this is set
const PAY_BASE = process.env.PAYSTACK_BASE || 'https://api.paystack.co';
const MIN_WITHDRAW = Math.max(1, Math.floor(+process.env.MIN_WITHDRAW || 1000));   // smallest withdrawal, in naira
const paystack = async (method, p, body) => {
  const r = await fetch(PAY_BASE + p, { method, headers: { Authorization: 'Bearer ' + PAY_KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.status) { const e = new Error(j.message || 'Payment provider error'); e.api = true; e.code = r.status; throw e; }   // e.api: Paystack answered and said no
  return j.data;                                                                                                      // no e.api (timeout, network): we do not know if it went through
};
const FRONTEND = path.join(__dirname, process.env.FRONTEND || 'TrustMe_1_1_5.html');

let db = { users: {}, sessions: {}, otps: {}, bookings: {}, messages: [], ledger: [], payouts: {}, notifs: [], push: {}, disputes: {}, seq: 0 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let timer;
const flush = () => { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); };
const cancelLocks = new Set();   // bookings with a cancel/refund in flight (memory only, so a crash can never leave one stuck)
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 150); };
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { try { flush(); } catch (e) {} process.exit(0); }));

const rid = () => crypto.randomBytes(6).toString('hex');
const fail = (c, m, extra) => { throw Object.assign({ c, m }, extra); };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const phoneOf = p => {
  let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('234')) d = '0' + d.slice(3);
  if (!/^0\d{10}$/.test(d)) fail(400, 'Enter a valid Nigerian phone number.'); return d;
};
const short = n => { const p = String(n || '').trim().split(/\s+/); return (p[0] || 'Corps member') + (p[1] ? ' ' + p[1][0] + '.' : ''); };
const stats = id => {     // jobs done, rating and reviews are worked out from finished bookings
  const done = Object.values(db.bookings).filter(b => b.vendorId === id && b.stage === 4), rs = done.filter(b => b.rating);
  return { jobs: done.length, rate: rs.length ? Math.round(rs.reduce((a, b) => a + b.rating, 0) / rs.length * 10) / 10 : 0,
    revs: rs.sort((a, b) => b.reviewed - a.reviewed).slice(0, 20).map(b => ({ n: short((db.users[b.corperId] || {}).name), s: b.rating, t: b.text,
      w: '₦' + b.price.toLocaleString('en-NG') + ' · ' + b.what })) };
};
const pub = u => ({ id: u.id, name: u.name, role: u.role, camp: u.camp, batch: u.batch, pic: u.pic || null,
  ...(u.role === 'vendor' ? Object.assign({ cat: u.cat, pkgs: u.pkgs, units: u.units || null, gallery: u.gallery || [], verified: !!u.verified, callPhone: u.callPhone || u.phone, loc: u.loc || null }, stats(u.id)) : {}) });
const me = u => Object.assign(pub(u), { phone: u.phone, stream: u.stream || '', needs: u.needs || [], setup: !!u.setup, hasPin: !!u.pinHash });
const auth = req => {
  const s = db.sessions[(req.headers.authorization || '').replace(/^Bearer /, '')];
  if (!s || !db.users[s.uid]) fail(401, 'Please sign in.'); return db.users[s.uid];
};
const vendorOnly = u => { if (u.role !== 'vendor') fail(403, 'Vendors only.'); };
const MAX_GALLERY = 12;             // portfolio photos on a vendor's listing, separate from the one profile picture
const locIn = raw => {                    // a vendor's own coordinates, set from their device's GPS
  if (!raw) return null;
  const lat = +raw.lat, lng = +raw.lng;
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) fail(400, 'That location does not look right.');
  return { lat, lng };
};
const kmBetween = (a, b) => {              // straight-line distance, good enough for "how far is this vendor"
  if (!a || !b) return null;
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)) * 10) / 10;
};
const galleryPhotoIn = raw => {
  const img = String(raw || '');
  if (!img) fail(400, 'Add a photo first.');
  if (img.length > 400000) fail(413, 'That photo is too large.');
  if (!/^data:image\/[a-z+]+;base64,[A-Za-z0-9+\/=]+$/.test(img)) fail(400, 'That photo is not valid.');
  return img;
};
const pkgIn = b => {
  const nm = str(b.nm, 60), price = Math.round(+b.price);
  if (nm.length < 2) fail(400, 'Give the package a name.'); if (!(price > 0)) fail(400, 'Add the fee in naira.');
  return { nm, price, desc: str(b.desc, 200), dur: str(b.dur, 30) };
};
/* Unit pricing: for trades where cost scales with volume (laundry, printing, shoe/bag repair) rather than
   one flat job fee. Each category has a fixed list of items a vendor can set their own price for, plus a
   minimum order. New vendors in these categories get this template on signup or on switching into the
   category; the item list itself is fixed — only price/min are vendor-editable, via PATCH /me. */
const UNIT_CATS = {
  wash:    { min: 1500, items: [ { id: 'top', nm: 'Tops', price: 300 }, { id: 'bottom', nm: 'Bottoms', price: 350 },
             { id: 'bulky', nm: 'Bulky (bedding, towels)', price: 800 } ] },
  print:   { min: 200,  items: [ { id: 'bw', nm: 'B&W page', price: 20 }, { id: 'color', nm: 'Color page', price: 100 },
             { id: 'bind', nm: 'Spiral binding', price: 300 } ] },
  cobbler: { min: 1500, items: [ { id: 'sole', nm: 'Sole repair', price: 2000 }, { id: 'zip', nm: 'Zip repair', price: 1500 },
             { id: 'stitch', nm: 'Stitching', price: 1200 }, { id: 'polish', nm: 'Clean & polish', price: 1000 } ] },
};
const unitsTemplate = cat => { const t = UNIT_CATS[cat]; return t ? { min: t.min, items: t.items.map(i => ({ id: i.id, nm: i.nm, price: i.price })) } : null; };
/* ---- Disputes: two-way. The corps member opens one (stage 3 only, before releasing the payment); the vendor and the corps member
   then both write into the same thread. While one is open the payment cannot be released. Only the corps member can close it,
   because it is their money that is being held. */
const DISPUTE_REASONS = ['They never showed up', 'Work is not what we agreed', 'They asked for more money', 'They damaged something', 'Something else'];
const MAX_DISPUTES_PER_BOOKING = 3, MAX_THREAD = 100, MAX_DISPUTE_PHOTOS = 8;
const evidenceIn = raw => {        // optional photo evidence: a small JPEG/PNG/WebP/GIF sent as a data address, same size limit as chat photos
  if (!raw) return null; const img = String(raw);
  if (img.length > 900000) fail(413, 'That photo is too large.');
  if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(img)) fail(400, 'That photo is not valid.');
  return img;
};
const photoCount = d => d.thread.filter(m => m.img).length;
const openDisputeOf = bid => Object.values(db.disputes).find(d => d.bookingId === bid && d.status === 'open') || null;
const lastDisputeOf = bid => Object.values(db.disputes).filter(d => d.bookingId === bid).sort((a, b) => b.created - a.created)[0] || null;
const dview = (d, uid) => {
  const b = db.bookings[d.bookingId] || {}, o = db.users[uid === d.corperId ? d.vendorId : d.corperId];
  return { id: d.id, bookingId: d.bookingId, what: b.what || '', price: b.price || 0, reason: d.reason, status: d.status, created: d.created, updated: d.updated,
    resolvedAt: d.resolvedAt || null, mine: uid === d.corperId ? 'corper' : 'vendor', other: o ? { id: o.id, name: o.name } : null,
    thread: d.thread.map(m => ({ id: m.id, by: m.by, text: m.text, at: m.at, img: !!m.img })) };
};
const disputeParty = (d, u) => { if (!d || (d.corperId !== u.id && d.vendorId !== u.id)) fail(404, 'Dispute not found.'); return d; };
const bview = b => Object.assign({}, b, { rated: !!b.rating, vendor: pub(db.users[b.vendorId]), corper: pub(db.users[b.corperId]),
  dispute: (d => d ? { id: d.id, status: d.status, reason: d.reason } : null)(lastDisputeOf(b.id)) });
const quoteOf = id => { const q = db.messages.find(x => x.id === id); return q ? { from: q.from, text: q.text || '', img: !!q.img } : null; };
const mview = m => m.replyTo ? Object.assign({}, m, { quote: quoteOf(m.replyTo) }) : m;


/* ---- Vendor money: earnings, balance, payouts ----
   A vendor is credited (booking price minus the 8% fee) once the corps member releases the payment (stage 4).
   Balance = credits - payouts that are sent or still on their way. A payout is taken off the balance BEFORE the bank is called,
   and put back only if the bank refuses it, so the same money cannot be withdrawn twice.
   Test-mode and real-money entries are kept apart (`live`), so pretend jobs can never turn into a real payout. */
const net = price => Math.round(price * 92 / 100);
const isLive = b => !!(b.ref && b.paidAt);
const sum = a => a.reduce((t, x) => t + x.amt, 0);
const credit = b => {
  if (b.credited) return; b.credited = true;
  db.ledger.push({ id: rid(), uid: b.vendorId, bookingId: b.id, what: b.what, amt: net(b.price), live: isLive(b), at: Date.now() });
};
Object.values(db.bookings).forEach(b => { if (b.stage === 4) credit(b); }); save();      // brings older finished jobs into the ledger once
const wallet = uid => {
  const live = !!PAY_KEY, mine = x => x.uid === uid && x.live === live;
  const earn = db.ledger.filter(mine), pays = Object.values(db.payouts).filter(mine);
  const sent = sum(pays.filter(p => p.status === 'success')), going = sum(pays.filter(p => p.status === 'processing'));
  const held = Object.values(db.bookings).filter(b => b.vendorId === uid && b.stage >= 1 && b.stage < 4 && !b.cancelled && isLive(b) === live).reduce((t, b) => t + net(b.price), 0);
  return { balance: sum(earn) - sent - going, held, earned: sum(earn), withdrawn: sent, processing: going, earn, pays };
};
const walletView = u => {
  const w = wallet(u.id), bk = u.bank;
  const history = w.earn.map(e => ({ kind: 'earning', id: e.id, amt: e.amt, what: e.what, at: e.at }))
    .concat(w.pays.map(p => ({ kind: 'payout', id: p.id, amt: p.amt, status: p.status, to: p.to, at: p.at })))
    .sort((a, b) => b.at - a.at).slice(0, 40);
  return { balance: w.balance, held: w.held, earned: w.earned, withdrawn: w.withdrawn, processing: w.processing, min: MIN_WITHDRAW, live: !!PAY_KEY,
    bank: bk ? { bank: bk.name, last4: bk.acct.slice(-4), name: bk.acctName } : null, hasWPin: !!u.wPinHash, history };
};
const DONE = ['failed', 'reversed', 'abandoned', 'blocked', 'rejected', 'otp'];       // 'otp' = the Paystack account still asks for a code on transfers; we cannot answer it
const applyTransfer = (p, st) => {
  if (st === 'success' && p.status === 'processing') p.status = 'success';
  else if (DONE.includes(st) && (p.status === 'processing' || (st === 'reversed' && p.status === 'success'))) p.status = 'failed';
  else return false;
  p.updated = Date.now(); return true;
};
const reconcile = async uid => {       // settles payouts whose webhook never arrived
  if (!PAY_KEY) return; let ch = false;
  for (const p of Object.values(db.payouts)) {
    if (p.uid !== uid || p.status !== 'processing' || !p.live || Date.now() - p.at < 60000) continue;
    try { const d = await paystack('GET', '/transfer/verify/' + encodeURIComponent(p.ref)); ch = settle(p, d.status) || ch; }
    catch (e) { if (e.api && e.code === 404 && Date.now() - p.at > 600000) { p.status = 'failed'; p.updated = Date.now(); ch = true; } }   // never reached Paystack
  }
  if (ch) save();
};
const BANKS = [['Access Bank', '044'], ['Fidelity Bank', '070'], ['First Bank of Nigeria', '011'], ['FCMB', '214'], ['Guaranty Trust Bank', '058'], ['Kuda', '50211'],
  ['Moniepoint MFB', '50515'], ['OPay', '999992'], ['PalmPay', '999991'], ['Polaris Bank', '076'], ['Stanbic IBTC Bank', '221'], ['Sterling Bank', '232'],
  ['Union Bank', '032'], ['United Bank for Africa', '033'], ['Wema Bank', '035'], ['Zenith Bank', '057']].map(([name, code]) => ({ name, code }));
let bankCache = null;
const bankList = async () => {        // the live list comes from Paystack, so the codes are always the ones it accepts
  if (!PAY_KEY) return BANKS;
  if (!bankCache || Date.now() - bankCache.at > 6 * 3600e3) {
    try {
      const seen = {}, d = await paystack('GET', '/bank?country=nigeria&currency=NGN&perPage=200');
      bankCache = { at: Date.now(), list: d.filter(b => b.code && b.name && b.active !== false && !seen[b.code] && (seen[b.code] = 1)).map(b => ({ name: b.name, code: String(b.code) }))
        .sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e) { if (!bankCache) return BANKS; }
  }
  return bankCache.list;
};
const sendCode = (key, phone) => {     // one place that makes and sends codes; add the SMS provider here (e.g. Termii)
  const o = db.otps[key];
  if (o && Date.now() - o.sent < 30000) fail(429, 'Wait 30 seconds before asking for another code.');
  const code = String(crypto.randomInt(100000, 1000000));
  db.otps[key] = { code, sent: Date.now(), exp: Date.now() + 300000, tries: 0 }; save();
  if (SHOW_OTP) console.log('[otp]', phone, code);
  return SHOW_OTP ? code : null;
};
const checkCode = (key, code) => {
  const o = db.otps[key];
  if (!o || Date.now() > o.exp) fail(400, 'That code has expired. Ask for a new one.');
  if (++o.tries > 5) { delete db.otps[key]; save(); fail(429, 'Too many tries. Ask for a new code.'); }
  if (String(code) !== o.code) { save(); fail(400, 'That code is not right.'); }
  delete db.otps[key]; save();
};

/* ---- PINs: a login PIN (opens the app on this phone) and, for vendors, a separate withdrawal PIN
   (needed to move money out). Neither is the phone OTP, so having the SIM alone is not enough for either. */
const PIN_MAX_TRIES = 5, PIN_LOCK_MS = 5 * 60000;
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const setPin = pin => { const salt = crypto.randomBytes(8).toString('hex'); return { salt, hash: hashPin(pin, salt), tries: 0, lockUntil: 0 }; };
const checkPin = (rec, pin) => {
  if (!rec) fail(400, 'No PIN is set.');
  if (rec.lockUntil && Date.now() < rec.lockUntil) fail(429, 'Too many tries. Wait a few minutes and try again.');
  if (hashPin(pin, rec.salt) !== rec.hash) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= PIN_MAX_TRIES) { rec.lockUntil = Date.now() + PIN_LOCK_MS; rec.tries = 0; }
    save(); fail(400, 'Wrong PIN.');
  }
  if (rec.tries) { rec.tries = 0; save(); }
};
const pinOf = raw => { const p = str(raw, 6); if (!/^\d{4,6}$/.test(p)) fail(400, 'Choose a 4 to 6 digit PIN.'); return p; };

/* ---- Notifications ----
   Every event a person should hear about (booking accepted, work finished, payment released, new message, payout result...)
   goes through notify(). It does two things: keeps the item in that person's inbox on the server (so nothing is lost, and the
   app shows a bell with a count), and sends a Web Push to every device they turned alerts on for, so the phone lights up even
   when the app is closed. Push is best effort: if it fails, the inbox still has it and the app picks it up on the next open.
   No packages: the VAPID signature and the payload encryption (RFC 8291) use Node's built-in crypto. */
const b64u = b => Buffer.from(b).toString('base64url');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (/^https:\/\//.test(process.env.APP_URL || '') ? process.env.APP_URL : 'mailto:hello@trustme.app');
const vapid = (() => {       // set VAPID_PUBLIC and VAPID_PRIVATE so the keys survive a wiped disk; otherwise one pair is made and kept in db.json
  let pub = process.env.VAPID_PUBLIC, d = process.env.VAPID_PRIVATE;
  if (!pub || !d) {
    if (!db.vapid) {
      const j = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
      db.vapid = { pub: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')])), d: j.d }; save();
    }
    pub = db.vapid.pub; d = db.vapid.d;
  }
  const raw = Buffer.from(pub, 'base64url');
  return { pub, key: crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' }) };
})();
const vapidJwt = aud => {
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT }));
  return h + '.' + p + '.' + b64u(crypto.sign('sha256', Buffer.from(h + '.' + p), { key: vapid.key, dsaEncoding: 'ieee-p1363' }));
};
const hkdf = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));
const pushBody = (sub, text) => {       // RFC 8291 "aes128gcm": only the person's device can read it, not the push service in between
  const ua = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1'), mine = ecdh.generateKeys(), salt = crypto.randomBytes(16);
  const ikm = hkdf(auth, ecdh.computeSecret(ua), Buffer.concat([Buffer.from('WebPush: info\0'), ua, mine]), 32);
  const c = crypto.createCipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  const data = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = mine.length;
  return Buffer.concat([head, mine, data]);
};
const PUSH_EXTRA = (process.env.PUSH_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean);       // extra hosts, for testing only
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const pushHostOk = u => (u.protocol === 'https:' && PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) || PUSH_EXTRA.includes(u.hostname);
const subIn = b => {       // a device's push address is user-supplied and the server will call it, so only the real push services are accepted
  let u; try { u = new URL(String(b.endpoint || '')); } catch (e) { fail(400, 'That alert address is not valid.'); }
  const k = b.keys || {}, ua = Buffer.from(String(k.p256dh || ''), 'base64url'), au = Buffer.from(String(k.auth || ''), 'base64url');
  if (!pushHostOk(u) || u.href.length > 600) fail(400, 'That alert address is not supported.');
  if (ua.length !== 65 || ua[0] !== 4 || au.length !== 16) fail(400, 'That alert address is not valid.');
  return { endpoint: u.href, keys: { p256dh: String(k.p256dh), auth: String(k.auth) }, at: Date.now() };
};
const pushTo = (uid, data) => {
  const subs = db.push[uid] || []; if (!subs.length) return Promise.resolve();
  const text = JSON.stringify(data);
  return Promise.all(subs.map(async s => {
    try {
      const r = await fetch(s.endpoint, { method: 'POST', signal: AbortSignal.timeout(10000), body: pushBody(s, text),
        headers: { Authorization: 'vapid t=' + vapidJwt(new URL(s.endpoint).origin) + ', k=' + vapid.pub, 'Content-Encoding': 'aes128gcm',
                   'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' } });
      if (r.status === 404 || r.status === 410) { db.push[uid] = (db.push[uid] || []).filter(x => x.endpoint !== s.endpoint); save(); }     // the device removed the app or the alerts
      else if (!r.ok) console.error('[push] refused', r.status, new URL(s.endpoint).hostname);
    } catch (e) { console.error('[push] failed', e.message); }
  }));
};
const NOTIF_KEEP = 100, NOTIF_DAYS = 30;
/* open = where a tap should land: 'booking:<id>', 'chat:<userId>' or 'wallet'. merge: fold repeats (a run of messages) into one unread item. */
const notify = (uid, kind, title, body, open, merge) => {
  if (!db.users[uid]) return;
  const at = Date.now(), seq = ++db.seq, ex = merge && db.notifs.find(n => n.uid === uid && n.kind === kind && n.open === open && !n.read);
  if (ex) Object.assign(ex, { title, body, at, seq }); else db.notifs.push({ id: rid(), seq, uid, kind, title, body, open, at, read: false });
  const old = db.notifs.filter(n => n.uid === uid).sort((a, b) => b.seq - a.seq).filter((n, i) => i >= NOTIF_KEEP || n.at < at - NOTIF_DAYS * 864e5);
  if (old.length) db.notifs = db.notifs.filter(n => !old.includes(n));
  save();
  pushTo(uid, { title, body, tag: open || kind, data: { open, seq } });
};
const who = id => short((db.users[id] || {}).name);
const naira = n => '₦' + Number(n).toLocaleString('en-NG');
const markPaid = b => {         // a booking's money is now held: tell the vendor. Runs once, whichever of the app or the Paystack webhook gets here first
  if (b.stage !== 0) return false;
  b.stage = 1; b.paidAt = Date.now(); notifyBooking(b); return true;
};
const notifyBooking = b => {    // one place for every booking step, so the wording stays consistent
  const open = 'booking:' + b.id;
  if (b.stage === 1) notify(b.vendorId, 'booking', 'New booking', who(b.corperId) + ' booked ' + b.what + '. Accept it to start the job.', open);
  else if (b.stage === 2) notify(b.corperId, 'booking', 'Booking accepted', who(b.vendorId) + ' accepted your ' + b.what + ' booking.', open);
  else if (b.stage === 3) notify(b.corperId, 'booking', 'Work marked as done', who(b.vendorId) + ' says ' + b.what + ' is finished. Confirm it to release your payment.', open);
  else if (b.stage === 4) notify(b.vendorId, 'booking', 'Payment released', naira(net(b.price)) + ' for ' + b.what + ' was added to your balance.', open);
};
const settle = (p, st) => {      // a payout changed state without the vendor being in the app (webhook, or the re-check on Earnings)
  const before = p.status; if (!applyTransfer(p, st)) return false;
  if (p.status === 'success') notify(p.uid, 'payout', 'Payout sent', naira(p.amt) + ' was sent to ' + p.to + '.', 'wallet');
  else if (p.status === 'failed') notify(p.uid, 'payout', 'Payout returned', naira(p.amt) + ' could not be sent' + (before === 'success' ? ' and was reversed' : '') + '. It is back in your balance.', 'wallet');
  return true;
};
/* Dispute alerts (kind 'dispute', open = 'dispute:<id>') are sent from the dispute routes below: opened -> vendor, reply -> the other side, closed -> vendor.
   A support reply, once support writes into the server thread, should notify both sides the same way. */

/* [method, path, handler, needs sign-in]. Booking stages match the app: 1 paid and waiting, 2 accepted,
   3 work finished, 4 released and done. The vendor moves 1>2>3, the corps member moves 3>4. */
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, payments: !!PAY_KEY }), false],

  ['POST', /^\/api\/auth\/request-otp$/, c => {
    const p = phoneOf(c.body.phone), code = sendCode(p, p);
    return { ok: true, ...(code ? { devCode: code } : {}) };
  }, false],

  ['POST', /^\/api\/auth\/verify$/, c => {
    const b = c.body, p = phoneOf(b.phone), o = db.otps[p];
    if (!o || Date.now() > o.exp) fail(400, 'That code has expired. Ask for a new one.');
    if (++o.tries > 5) { delete db.otps[p]; save(); fail(429, 'Too many tries. Ask for a new code.'); }
    if (String(b.code) !== o.code) { save(); fail(400, 'That code is not right.'); }
    delete db.otps[p];
    let u = Object.values(db.users).find(x => x.phone === p); const isNew = !u;
    if (!u) {
      const role = ['vendor', 'other'].includes(b.role) ? b.role : 'corper';
      u = { id: rid(), phone: p, role, name: str(b.name, 40), camp: str(b.camp, 60), batch: str(b.batch, 20),
            stream: str(b.stream, 10), needs: [], pic: null, setup: true, created: Date.now() };
      if (role === 'vendor') {
        Object.assign(u, { cat: str(b.cat, 30), verified: false, jobs: 0, pkgs: [], gallery: [], units: unitsTemplate(str(b.cat, 30)) });
        if (str(b.pkgName, 60) && +b.pkgFee > 0) u.pkgs.push({ id: rid(), nm: str(b.pkgName, 60), price: Math.round(+b.pkgFee), desc: '', dur: '' });
      }
      db.users[u.id] = u;
    }
    const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = { uid: u.id, at: Date.now() }; save();
    return { token, isNew, user: me(u) };
  }, false],

  /* Login PIN: opens the app on this phone. Separate from the phone OTP on purpose — a stolen phone
     usually means the SIM is gone too, so anything that only needs the SIM (like OTP) is not enough here. */
  ['POST', /^\/api\/auth\/pin$/, c => {
    const u = c.u, pin = pinOf(c.body.pin);
    if (u.pinHash) checkPin(u.pinHash, str(c.body.oldPin, 6));
    u.pinHash = setPin(pin); save(); return { ok: true };
  }, true],
  ['POST', /^\/api\/auth\/pin\/verify$/, c => { checkPin(c.u.pinHash, str(c.body.pin, 6)); return { ok: true }; }, true],
  ['POST', /^\/api\/auth\/pin\/reset$/, c => {         // forgot the PIN: same trust level as signing in in the first place
    const p = phoneOf(c.body.phone), u = Object.values(db.users).find(x => x.phone === p); if (!u) fail(404, 'Account not found.');
    checkCode(p, c.body.code); const pin = pinOf(c.body.pin);
    u.pinHash = setPin(pin);
    const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = { uid: u.id, at: Date.now() }; save();
    return { ok: true, token };
  }, false],

  ['GET', /^\/api\/me$/, c => me(c.u), true],
  ['PATCH', /^\/api\/me$/, c => {
    const b = c.body, u = c.u;
    for (const [k, n] of [['name', 40], ['camp', 60], ['batch', 20], ['stream', 10]]) if (k in b) u[k] = str(b[k], n);
    if (Array.isArray(b.needs)) u.needs = b.needs.slice(0, 20).map(x => str(x, 30));
    if ('pic' in b) {
      if (b.pic && (typeof b.pic !== 'string' || b.pic.length > 400000)) fail(413, 'That photo is too large.');
      if (b.pic && !/^data:image\/[a-z+]+;base64,[A-Za-z0-9+\/=]+$/.test(b.pic)) fail(400, 'That photo is not valid.');
      u.pic = b.pic || null;
    }
    if (u.setup && ['vendor', 'corper', 'other'].includes(b.role)) {          // role can be chosen until setup is finished
      u.role = b.role; if (b.role === 'vendor') Object.assign(u, { cat: u.cat || '', verified: false, jobs: u.jobs || 0, pkgs: u.pkgs || [], gallery: u.gallery || [] });
    }
    if (u.role === 'vendor') {
      if ('cat' in b) {
        const nc = str(b.cat, 30);
        if (nc !== u.cat) { u.cat = nc; u.units = unitsTemplate(nc); }   // switching category resets pricing to that trade's defaults
      }
      if ('callPhone' in b) u.callPhone = b.callPhone ? phoneOf(b.callPhone) : null;   // corps members call this; falls back to the registered number when cleared
      if ('loc' in b) u.loc = b.loc === null ? null : locIn(b.loc);                    // set from the vendor's device GPS in Edit Profile
      if (Array.isArray(b.pkgs)) u.pkgs = b.pkgs.slice(0, 20).map(p => Object.assign({ id: str(p.id, 20).replace(/\W/g, '') || rid() }, pkgIn(p)));
      if (u.units && b.units && typeof b.units === 'object') {          // vendor can only tune price/min, never the item list
        const min = Math.round(+b.units.min);
        if (min > 0) u.units.min = min;
        const byId = new Map(u.units.items.map(i => [i.id, i]));
        if (Array.isArray(b.units.items)) for (const it of b.units.items) {
          const cur = byId.get(str(it && it.id, 20)); if (!cur) continue;
          const price = Math.round(+(it && it.price)); if (price > 0) cur.price = price;
        }
      }
    }
    if (b.done === true) u.setup = false;
    save(); return me(u);
  }, true],

  ['POST', /^\/api\/me\/packages$/, c => { vendorOnly(c.u); const p = Object.assign({ id: rid() }, pkgIn(c.body)); c.u.pkgs.push(p); save(); return p; }, true],
  ['PUT', /^\/api\/me\/packages\/(\w+)$/, c => {
    vendorOnly(c.u); const i = c.u.pkgs.findIndex(p => p.id === c.m[1]); if (i < 0) fail(404, 'Package not found.');
    c.u.pkgs[i] = Object.assign({ id: c.m[1] }, pkgIn(c.body)); save(); return c.u.pkgs[i];
  }, true],
  ['DELETE', /^\/api\/me\/packages\/(\w+)$/, c => {
    vendorOnly(c.u); if (c.u.pkgs.length < 2) fail(400, 'Keep at least one package.');
    c.u.pkgs = c.u.pkgs.filter(p => p.id !== c.m[1]); save(); return { ok: true };
  }, true],

  /* Portfolio gallery: separate from the single profile picture, so vendors (especially photographers,
     tailors and other visual trades) can show a few examples of past work. */
  ['POST', /^\/api\/me\/gallery$/, c => {
    vendorOnly(c.u); const img = galleryPhotoIn(c.body.img);
    c.u.gallery = c.u.gallery || [];
    if (c.u.gallery.length >= MAX_GALLERY) fail(409, 'You can keep up to ' + MAX_GALLERY + ' photos. Remove one first.');
    const item = { id: rid(), img };
    c.u.gallery.push(item); save(); return item;
  }, true],
  ['DELETE', /^\/api\/me\/gallery\/(\w+)$/, c => {
    vendorOnly(c.u); c.u.gallery = (c.u.gallery || []).filter(g => g.id !== c.m[1]); save(); return { ok: true };
  }, true],

  ['GET', /^\/api\/vendors$/, c => {
    const { cat, camp, q, lat, lng } = c.q, s = (q || '').toLowerCase();
    const mine = (lat !== undefined && lng !== undefined) ? { lat: +lat, lng: +lng } : null;   // the browsing corps member's own GPS, if they shared it
    const list = Object.values(db.users).filter(v => v.role === 'vendor' && (v.pkgs.length || v.units) && (!cat || v.cat === cat) && (!camp || v.camp === camp)
      && (!s || (v.name + ' ' + v.pkgs.map(p => p.nm).join(' ')).toLowerCase().includes(s))).map(pub);
    if (mine) { list.forEach(v => { v.km = kmBetween(mine, v.loc); }); list.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9)); }
    return list;
  }, true],
  ['GET', /^\/api\/vendors\/(\w+)$/, c => {
    const v = db.users[c.m[1]]; if (!v || v.role !== 'vendor') fail(404, 'Vendor not found.');
    const p = pub(v), { lat, lng } = c.q;
    if (lat !== undefined && lng !== undefined) p.km = kmBetween({ lat: +lat, lng: +lng }, v.loc);
    return p;
  }, true],

  ['POST', /^\/api\/bookings$/, async c => {
    if (c.u.role === 'vendor') fail(403, 'Vendor accounts cannot book.');
    const v = db.users[c.body.vendorId]; if (!v || v.role !== 'vendor') fail(404, 'Vendor not found.');
    let what, price;
    if (c.body.units && typeof c.body.units === 'object') {         // unit-priced booking: price is computed here, never trusted from the client
      if (!v.units) fail(404, 'This vendor does not offer unit pricing.');
      const counts = c.body.units; let total = 0; const parts = [];
      for (const item of v.units.items) {
        const n = Math.max(0, Math.floor(+counts[item.id] || 0));
        if (n > 0) { total += n * item.price; parts.push(n + '× ' + item.nm); }
      }
      if (!parts.length) fail(400, 'Add at least one item.');
      price = Math.max(total, v.units.min); what = parts.join(', ');
    } else {
      const p = v.pkgs.find(x => x.id === c.body.pkgId); if (!p) fail(404, 'Package not found.');
      what = p.nm; price = p.price;
    }
    const b = { id: rid(), corperId: c.u.id, vendorId: v.id, what, price, stage: 1,
                when: str(c.body.when, 60), where: str(c.body.where, 80), rated: false, created: Date.now() };
    if (!PAY_KEY) { db.bookings[b.id] = b; save(); notifyBooking(b); return bview(b); }        // test mode: no real money, held straight away
    b.stage = 0; b.ref = 'tm_' + b.id;                                       // stage 0 = waiting for the bank payment
    const base = process.env.APP_URL || ((c.req.headers['x-forwarded-proto'] || 'http') + '://' + c.req.headers.host);
    let d; try {
      d = await paystack('POST', '/transaction/initialize', { email: c.u.phone + '@trustme.app', amount: b.price * 100, reference: b.ref,
        callback_url: base.replace(/\/$/, '') + '/', channels: ['bank', 'bank_transfer', 'ussd', 'card'], metadata: { bookingId: b.id } });
    } catch (e) { fail(502, 'Could not reach the payment provider. Try again.'); }
    db.bookings[b.id] = b; save(); return Object.assign(bview(b), { payUrl: d.authorization_url });
  }, true],
  ['POST', /^\/api\/payments\/verify$/, async c => {
    const b = Object.values(db.bookings).find(x => x.ref && x.ref === c.body.reference && x.corperId === c.u.id); if (!b) fail(404, 'Payment not found.');
    if (b.stage === 0) {
      let d; try { d = await paystack('GET', '/transaction/verify/' + encodeURIComponent(b.ref)); } catch (e) { fail(502, 'Could not check the payment. Try again.'); }
      if (d.status !== 'success' || d.amount < b.price * 100) fail(402, 'That payment was not completed.');
      markPaid(b); save();
    }
    return bview(b);
  }, true],
  ['POST', /^\/api\/paystack\/webhook$/, c => {      // Paystack tells us the moment a payment succeeds, even if the app was closed
    const sig = crypto.createHmac('sha512', PAY_KEY || 'x').update(c.raw || '').digest('hex');
    if (!PAY_KEY || sig !== c.req.headers['x-paystack-signature']) fail(401, 'Bad signature.');
    const d = c.body.data || {}, b = Object.values(db.bookings).find(x => x.ref && x.ref === d.reference);
    if (c.body.event === 'charge.success' && b && b.stage === 0 && d.amount >= b.price * 100) { markPaid(b); save(); }
    const ev = String(c.body.event || '');
    if (ev.startsWith('transfer.')) {         // a payout to a vendor's bank finished, failed, or was sent back
      const p = Object.values(db.payouts).find(x => x.ref && x.ref === d.reference);
      if (p && settle(p, ev.slice(9))) save();
    }
    return { ok: true };
  }, false],
  ['GET', /^\/api\/bookings$/, c => Object.values(db.bookings)
    .filter(b => b[c.u.role === 'vendor' ? 'vendorId' : 'corperId'] === c.u.id && (b.stage > 0 || c.u.role !== 'vendor'))
    .sort((a, b) => b.created - a.created).map(bview), true],
  ['POST', /^\/api\/bookings\/(\w+)\/advance$/, c => {
    const b = db.bookings[c.m[1]]; if (!b || (b.vendorId !== c.u.id && b.corperId !== c.u.id)) fail(404, 'Booking not found.');
    if (b.cancelled || cancelLocks.has(b.id)) fail(409, 'This booking was cancelled.');
    if (openDisputeOf(b.id)) fail(409, 'This job has an open dispute. It has to be closed before the payment can be released.');
    const v = c.u.role === 'vendor';
    if (!((v && (b.stage === 1 || b.stage === 2)) || (!v && b.stage === 3))) fail(409, 'That step is not available right now.');
    b.stage++; b.updated = Date.now();
    if (b.stage === 4) { db.users[b.vendorId].jobs = (db.users[b.vendorId].jobs || 0) + 1; credit(b); }
    save(); notifyBooking(b); return bview(b);
  }, true],
  ['POST', /^\/api\/bookings\/(\w+)\/cancel$/, async c => {           // the corps member backs out before the vendor has accepted
    if (c.u.role === 'vendor') fail(403, 'Vendor accounts cannot cancel a booking.');
    const b = db.bookings[c.m[1]]; if (!b || b.corperId !== c.u.id) fail(404, 'Booking not found.');
    if (b.cancelled) return bview(b);
    if (cancelLocks.has(b.id)) fail(409, 'This booking is already being cancelled.');
    if (b.stage !== 1) fail(409, 'This can only be cancelled before it is accepted.');
    const paid = !!(PAY_KEY && b.ref);
    cancelLocks.add(b.id);                                           // lock first: the vendor can no longer accept while the refund runs
    try {
      if (paid) await paystack('POST', '/refund', { transaction: b.ref });   // real money was collected: hand it straight back
    } catch (e) {
      cancelLocks.delete(b.id);                                      // refund failed: booking stays live, nothing changed
      fail(502, 'Could not refund this yet. Nothing was cancelled, try again.');
    }
    cancelLocks.delete(b.id);
    b.cancelled = true; b.refunded = paid; b.cancelledAt = Date.now(); save();
    notify(b.vendorId, 'booking', 'Booking cancelled', who(b.corperId) + ' cancelled the ' + b.what + ' booking before accepting it.', 'booking:' + b.id);
    return bview(b);
  }, true],

  ['POST', /^\/api\/bookings\/(\w+)\/dispute$/, c => {           // the corps member says the finished work is not right
    if (c.u.role === 'vendor') fail(403, 'Only the person who booked can open a dispute.');
    const b = db.bookings[c.m[1]]; if (!b || b.corperId !== c.u.id) fail(404, 'Booking not found.');
    if (b.cancelled || b.stage !== 3) fail(409, 'A dispute can be opened once the work is marked finished and before you release the payment.');
    if (openDisputeOf(b.id)) fail(409, 'This job already has an open dispute.');
    if (Object.values(db.disputes).filter(d => d.bookingId === b.id).length >= MAX_DISPUTES_PER_BOOKING) fail(409, 'This job has reached the limit of disputes.');
    const reason = str(c.body.reason, 60); if (!DISPUTE_REASONS.includes(reason)) fail(400, 'Pick what went wrong.');
    const detail = str(c.body.detail, 1000), img = evidenceIn(c.body.img), now = Date.now(), id = rid();
    const d = db.disputes[id] = { id, bookingId: b.id, corperId: b.corperId, vendorId: b.vendorId, reason, status: 'open', created: now, updated: now,
      thread: detail || img ? [Object.assign({ id: rid(), by: 'corper', text: detail, at: now }, img ? { img } : {})] : [] };
    save();
    notify(b.vendorId, 'dispute', 'Dispute opened', who(b.corperId) + ' opened a dispute on ' + b.what + ' (' + reason + '). Reply with your side.', 'dispute:' + id);
    return dview(d, c.u.id);
  }, true],
  ['GET', /^\/api\/disputes$/, c => Object.values(db.disputes).filter(d => d.corperId === c.u.id || d.vendorId === c.u.id)
    .sort((a, b) => b.updated - a.updated).slice(0, 50).map(d => dview(d, c.u.id)), true],
  ['POST', /^\/api\/disputes\/(\w+)\/reply$/, c => {              // either side adds to the thread; this is how the vendor answers
    const d = disputeParty(db.disputes[c.m[1]], c.u);
    if (d.status !== 'open') fail(409, 'This dispute is closed.');
    const text = str(c.body.text, 1000), img = evidenceIn(c.body.img); if (!text && !img) fail(400, 'Write your reply or add a photo first.');
    if (d.thread.length >= MAX_THREAD) fail(409, 'This thread is full.');
    if (img && photoCount(d) >= MAX_DISPUTE_PHOTOS) fail(409, 'This dispute already has the most photos it can hold (' + MAX_DISPUTE_PHOTOS + ').');
    const corper = c.u.id === d.corperId, now = Date.now();
    d.thread.push(Object.assign({ id: rid(), by: corper ? 'corper' : 'vendor', text, at: now }, img ? { img } : {})); d.updated = now; save();
    notify(corper ? d.vendorId : d.corperId, 'dispute', 'Dispute reply', who(c.u.id) + ': ' + (text ? text.slice(0, 100) : 'Sent a photo'), 'dispute:' + d.id, true);
    return dview(d, c.u.id);
  }, true],
  ['GET', /^\/api\/disputes\/(\w+)\/photos\/(\w+)$/, c => {       // one photo at a time, and only for the two people in the dispute
    const d = disputeParty(db.disputes[c.m[1]], c.u), m = d.thread.find(x => x.id === c.m[2] && x.img);
    if (!m) fail(404, 'Photo not found.'); return { img: m.img };
  }, true],
  ['POST', /^\/api\/disputes\/(\w+)\/resolve$/, c => {            // only the corps member can close it: their money is what is held
    const d = disputeParty(db.disputes[c.m[1]], c.u);
    if (c.u.id !== d.corperId) fail(403, 'Only the corps member who opened the dispute can close it.');
    if (d.status !== 'open') return dview(d, c.u.id);
    const now = Date.now(), b = db.bookings[d.bookingId] || {};
    Object.assign(d, { status: 'resolved', resolvedAt: now, updated: now }); d.thread.push({ id: rid(), by: 'system', text: who(d.corperId) + ' closed this dispute.', at: now }); save();
    notify(d.vendorId, 'dispute', 'Dispute closed', who(d.corperId) + ' closed the dispute on ' + (b.what || 'the job') + '. They can now release your payment.', 'dispute:' + d.id);
    return dview(d, c.u.id);
  }, true],

  ['POST', /^\/api\/bookings\/(\w+)\/review$/, c => {
    const b = db.bookings[c.m[1]]; if (!b || b.corperId !== c.u.id) fail(404, 'Booking not found.');
    if (b.stage !== 4) fail(409, 'You can review once the job is done.'); if (b.rating) fail(409, 'You already reviewed this job.');
    const r = Math.round(+c.body.rating); if (!(r >= 1 && r <= 5)) fail(400, 'Pick a rating from 1 to 5.');
    b.rating = r; b.text = str(c.body.text, 300) || 'Booked through Trust Me.'; b.reviewed = Date.now(); save();
    notify(b.vendorId, 'review', 'New review', who(b.corperId) + ' gave you ' + r + (r === 1 ? ' star' : ' stars') + ' for ' + b.what + '.', 'booking:' + b.id);
    return bview(b);
  }, true],

  ['GET', /^\/api\/banks$/, async c => { vendorOnly(c.u); return bankList(); }, true],
  ['GET', /^\/api\/wallet$/, async c => { vendorOnly(c.u); await reconcile(c.u.id); return walletView(c.u); }, true],
  ['GET', /^\/api\/wallet\/history$/, async c => {          // the in-app view keeps only the latest 40; export gets everything
    vendorOnly(c.u); await reconcile(c.u.id); const w = wallet(c.u.id);
    const history = w.earn.map(e => ({ kind: 'earning', id: e.id, amt: e.amt, what: e.what, at: e.at }))
      .concat(w.pays.map(p => ({ kind: 'payout', id: p.id, amt: p.amt, status: p.status, to: p.to, at: p.at })))
      .sort((a, b) => b.at - a.at);
    return { history, live: !!PAY_KEY };
  }, true],
  ['POST', /^\/api\/wallet\/pin$/, c => {         // the withdrawal PIN: needed to move money out, on top of everything else
    vendorOnly(c.u); const u = c.u, pin = pinOf(c.body.pin);
    if (u.wPinHash) checkPin(u.wPinHash, str(c.body.oldPin, 6));
    u.wPinHash = setPin(pin); save(); return walletView(u);
  }, true],
  ['POST', /^\/api\/wallet\/bank\/otp$/, c => {          // changing where money goes needs a code sent to the vendor's phone
    vendorOnly(c.u); const code = sendCode('bank:' + c.u.phone, c.u.phone); return { ok: true, ...(code ? { devCode: code } : {}) };
  }, true],
  ['PUT', /^\/api\/wallet\/bank$/, async c => {
    vendorOnly(c.u);
    const acct = String(c.body.account || '').replace(/\s/g, ''); if (!/^\d{10}$/.test(acct)) fail(400, 'Enter the 10-digit account number.');
    const bk = (await bankList()).find(x => x.code === String(c.body.bank)); if (!bk) fail(400, 'Choose your bank.');
    let acctName = str(c.u.name, 40).toUpperCase() || 'ACCOUNT HOLDER', recipient = 'test';
    if (PAY_KEY) {
      try { acctName = (await paystack('GET', '/bank/resolve?account_number=' + acct + '&bank_code=' + encodeURIComponent(bk.code))).account_name; }
      catch (e) { fail(e.api ? 422 : 502, e.api ? 'We could not find that account. Check the number and the bank.' : 'Could not check the account. Try again.'); }
    }
    checkCode('bank:' + c.u.phone, c.body.code);
    if (PAY_KEY) {
      try { recipient = (await paystack('POST', '/transferrecipient', { type: 'nuban', name: acctName, account_number: acct, bank_code: bk.code, currency: 'NGN' })).recipient_code; }
      catch (e) { fail(502, 'Could not save the account. Try again.'); }
    }
    c.u.bank = { code: bk.code, name: bk.name, acct, acctName, recipient, at: Date.now() }; save(); return walletView(c.u);
  }, true],
  ['POST', /^\/api\/wallet\/withdraw$/, async c => {
    vendorOnly(c.u); const u = c.u, bk = u.bank; if (!bk) fail(400, 'Add your bank account first.');
    if (!u.wPinHash) fail(409, 'Set a withdrawal PIN first.', { needPin: true });
    checkPin(u.wPinHash, str(c.body.pin, 6));
    if (Object.values(db.payouts).some(p => p.uid === u.id && p.status === 'processing' && p.live === !!PAY_KEY)) fail(409, 'You have a payout on its way. Wait for it to finish.');
    const bal = wallet(u.id).balance, amt = c.body.all ? bal : Math.floor(+c.body.amount);
    if (!(amt >= MIN_WITHDRAW)) fail(400, 'The smallest withdrawal is ₦' + MIN_WITHDRAW.toLocaleString('en-NG') + '.');
    if (amt > bal) fail(409, 'That is more than your available balance.');
    const id = rid(), p = db.payouts[id] = { id, uid: u.id, amt, status: 'processing', ref: 'tmw_' + id, live: !!PAY_KEY, at: Date.now(),
      to: bk.name + ' ••••' + bk.acct.slice(-4) };
    save();                                       // the money leaves the balance here, before the bank is called
    if (!PAY_KEY) { p.status = 'success'; p.updated = Date.now(); save(); return walletView(u); }        // test mode: pretend it was sent
    try {
      const t = await paystack('POST', '/transfer', { source: 'balance', amount: amt * 100, recipient: bk.recipient, reference: p.ref, reason: 'Trust Me payout' });
      p.code = t.transfer_code; applyTransfer(p, t.status); save();
      if (p.status === 'failed') { console.error('[payout] not accepted', p.ref, t.status); fail(502, 'The payout could not be sent. Your money is back in your balance.'); }
    } catch (e) {
      if (e && e.c) throw e;
      if (e.api) { p.status = 'failed'; p.updated = Date.now(); save(); console.error('[payout] refused', p.ref, e.message); fail(502, 'The payout could not be sent. Your money is back in your balance.'); }
      console.error('[payout] no answer, will re-check', p.ref, e.message);      // unknown outcome: it stays "on its way" until the webhook or a re-check settles it
    }
    return walletView(u);
  }, true],

  /* Alerts: the app asks for the public key, subscribes this device, and reads the inbox. */
  ['GET', /^\/api\/push\/key$/, () => ({ key: vapid.pub }), false],
  ['POST', /^\/api\/push\/subscribe$/, c => {
    const s = subIn(c.body);
    for (const k of Object.keys(db.push)) db.push[k] = db.push[k].filter(x => x.endpoint !== s.endpoint);     // a device belongs to whoever signed in on it last
    (db.push[c.u.id] = db.push[c.u.id] || []).push(s); if (db.push[c.u.id].length > 5) db.push[c.u.id].shift(); save(); return { ok: true };
  }, true],
  ['POST', /^\/api\/push\/unsubscribe$/, c => {
    const ep = str(c.body.endpoint, 600); db.push[c.u.id] = (db.push[c.u.id] || []).filter(x => x.endpoint !== ep); save(); return { ok: true };
  }, true],
  ['GET', /^\/api\/notifications$/, c => {
    const mine = db.notifs.filter(n => n.uid === c.u.id).sort((a, b) => b.seq - a.seq);
    return { seq: mine.length ? mine[0].seq : 0, unread: mine.filter(n => !n.read).length, items: mine.slice(0, 30).map(({ uid, ...n }) => n) };
  }, true],
  ['POST', /^\/api\/notifications\/read$/, c => {
    const ids = Array.isArray(c.body.ids) ? c.body.ids.map(x => str(x, 20)) : [];
    db.notifs.forEach(n => { if (n.uid === c.u.id && !n.read && (c.body.all === true || ids.includes(n.id))) n.read = true; }); save(); return { ok: true };
  }, true],

  ['POST', /^\/api\/messages$/, c => {
    const to = db.users[c.body.to]; if (!to || to.role === c.u.role) fail(400, 'You can only message the other side.');
    const text = str(c.body.text, 1000);
    let img = null;
    if (c.body.img) {
      img = String(c.body.img);
      if (img.length > 900000) fail(413, 'That photo is too large.');
      if (!/^data:image\/[a-z+]+;base64,[A-Za-z0-9+\/=]+$/.test(img)) fail(400, 'That photo is not valid.');
    }
    if (!text && !img) fail(400, 'Write a message first.');
    let replyTo = null;
    if (c.body.replyTo) {
      const q = db.messages.find(x => x.id === str(c.body.replyTo, 20)
        && ((x.from === c.u.id || x.to === c.u.id) && (x.from === to.id || x.to === to.id)));   // only messages from this same thread
      if (q) replyTo = q.id;
    }
    const m = { id: rid(), from: c.u.id, to: to.id, text, img, replyTo, at: Date.now() };
    db.messages.push(m); save();
    notify(to.id, 'message', who(c.u.id), text ? text.slice(0, 100) : 'Sent a photo', 'chat:' + c.u.id, true);
    return mview(m);
  }, true],
  ['GET', /^\/api\/messages$/, c => {
    const last = {}; db.messages.forEach(m => { if (m.from === c.u.id || m.to === c.u.id) last[m.from === c.u.id ? m.to : m.from] = m; });
    return Object.entries(last).map(([o, m]) => ({ with: pub(db.users[o]), last: mview(m) })).sort((a, b) => b.last.at - a.last.at);
  }, true],
  ['GET', /^\/api\/messages\/(\w+)$/, c => db.messages.filter(m => (m.from === c.u.id && m.to === c.m[1]) || (m.to === c.u.id && m.from === c.m[1])).map(mview), true],
];

const readBody = req => new Promise((ok, no) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 3e6) { no({ c: 413, m: 'Request too large.' }); req.destroy(); } });
  req.on('end', () => { req.rawBody = s; try { ok(s ? JSON.parse(s) : {}); } catch (e) { no({ c: 400, m: 'Bad JSON.' }); } });
});

const ASSETS = { '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'], '/icon-512.png': ['icon-512.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'], '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'] };
http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
  const send = (code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const asset = req.method === 'GET' && ASSETS[url.pathname];
  if (asset) {                                                              // the alerts worker, the install manifest and the icons (folder: public/)
    return fs.readFile(path.join(__dirname, 'public', asset[0]), (e, d) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': asset[0] === 'sw.js' ? 'no-cache' : 'public, max-age=86400', 'Service-Worker-Allowed': '/' }); res.end(d);
    });
  }
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {          // serves the app itself at /
    return fs.readFile(FRONTEND, (e, d) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  }
  try {
    const body = (req.method === 'GET' || req.method === 'DELETE') ? {} : await readBody(req);
    for (const [method, re, fn, needAuth] of routes) {
      const m = req.method === method && url.pathname.match(re); if (!m) continue;
      const c = { body, m, req, raw: req.rawBody, q: Object.fromEntries(url.searchParams) }; if (needAuth) c.u = auth(req);
      return send(200, await fn(c));
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    if (e && e.c) { const { c: code, m, ...extra } = e; return send(code, Object.assign({ error: m }, extra)); }
    console.error(e); send(500, { error: 'Something went wrong.' });
  }
}).listen(PORT, () => console.log('Trust Me backend on port ' + PORT));
