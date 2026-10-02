// DriveMate accounts and sync API, plus the web app's pages (served from ./public with security headers).
//
// Access control: there is no database-level row security in D1, so every query that touches account
// data is scoped by the user id taken from the session — never from anything the client sends.
// test/security.test.mjs checks this against a live deployment.

import { CSP } from "./csp.generated.js";

const ITER = 100000;               // PBKDF2 iterations (the Workers maximum)
const SESSION_IDLE = 180 * 864e5;  // sign out after 6 months unused
const MAX_DOC = 1_000_000;         // bytes per stored document
const MAX_BODY = 1_100_000;        // bytes per request
const MAX_DOCS = 600;              // config + 50 years of months
const DOC_ID = /^(config|m-\d{4}-\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TERMS_VERSION = "2026-10-01"; // bump when the Terms of Use or Privacy Policy change materially
const REPORT_RETENTION = 730 * 864e5;
const DONOR_PAUSE = 182 * 864e5;   // a $5+ donation pauses the donation reminder for about 6 months
const DONOR_MIN = 500;             // cents
const DONATION_CHECK = 7 * 864e5;  // keep asking Square about an unpaid donation for this long
// Compared against when an email has no account, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Tells Android the DriveMate app and this site belong together: saved passwords work in both,
// and sign-in links (/auth/done) open the app. Fingerprint = APK signing key's SHA-256.
const ASSET_LINKS = [{
  relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
  target: {
    namespace: "android_app",
    package_name: "app.drivemate",
    sha256_cert_fingerprints: ["E6:76:2B:AB:B1:72:2C:7F:94:C4:5C:B4:C1:3E:C1:B0:EC:7C:3F:66:63:31:E5:AA:D1:AF:D8:30:69:C1:87:23"],
  },
}];

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), geolocation=(self), microphone=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

// Cloudflare serves privacy.html at /privacy itself; the sign-in return page is the app.
const PAGES = { "/auth/done": "/" };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/assetlinks.json") return json(ASSET_LINKS);
    if (!url.pathname.startsWith("/api/")) return page(req, env, url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: SECURITY_HEADERS }); // no CORS: same-site only
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },

  // Daily clean-up, matching the retention periods in the Privacy Policy.
  async scheduled(_event, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE last_seen < ?").bind(now - SESSION_IDLE),
      env.DB.prepare("DELETE FROM attempts WHERE first < ?").bind(now - 864e5),
      env.DB.prepare("DELETE FROM login_codes WHERE created < ?").bind(now - 3600e3),
      env.DB.prepare("DELETE FROM reports WHERE created < ?").bind(now - REPORT_RETENTION),
      env.DB.prepare("DELETE FROM donations WHERE paid IS NULL AND created < ?").bind(now - DONATION_CHECK),
    ]);
    if (hasSquare(env)) {
      const { results } = await env.DB.prepare("SELECT user_id FROM donations WHERE paid IS NULL GROUP BY user_id").all();
      for (const r of results) await checkDonations(env, r.user_id).catch(e => console.error(e));
    }
  },
};

async function page(req, env, url) {
  const path = PAGES[url.pathname];
  const res = await env.ASSETS.fetch(path ? new Request(new URL(path, url), req) : req);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (out.status >= 300 && out.status < 400) out.headers.set("Cache-Control", "no-store");
  if ((out.headers.get("Content-Type") || "").includes("text/html")) out.headers.set("Content-Security-Policy", CSP);
  return out;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  if (+(req.headers.get("Content-Length") || 0) > MAX_BODY) throw new HttpError(413, "That request is too large.");

  if (p === "/api/config" && m === "GET") return json({ google: hasGoogle(env), facebook: hasFacebook(env), donate: hasSquare(env), terms: TERMS_VERSION });
  if (p === "/api/signup" && m === "POST") return signup(req, env);
  if (p === "/api/login" && m === "POST") return login(req, env);
  if (p === "/api/reset" && m === "POST") return reset(req, env);
  if (p === "/api/report" && m === "POST") return report(req, env);
  if (p === "/api/oauth/exchange" && m === "POST") return oauthExchange(req, env);
  if (p === "/api/donate" && m === "POST") return donate(req, env, url);
  const om = p.match(/^\/api\/oauth\/(google|facebook)\/(start|callback)$/);
  if (om && m === "GET") return om[2] === "start" ? oauthStart(env, url, om[1]) : oauthCallback(req, env, url, om[1]);

  const user = await auth(req, env);
  if (p === "/api/me" && m === "GET") return me(env, user);
  if (p === "/api/terms" && m === "POST") {
    await env.DB.prepare("UPDATE users SET terms_version = ?, terms_accepted = ? WHERE id = ?").bind(TERMS_VERSION, Date.now(), user.id).run();
    return json({ ok: true });
  }
  if (p === "/api/logout" && m === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
    return json({ ok: true });
  }
  if (p === "/api/password" && m === "POST") return changePassword(req, env, user);
  if (p === "/api/recovery" && m === "POST") return newRecovery(req, env, user);
  if (p === "/api/account" && m === "DELETE") return deleteAccount(req, env, user);
  if (p === "/api/data" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT doc_id, data, updated FROM docs WHERE user_id = ?").bind(user.id).all();
    return json({ docs: results.map(r => ({ id: r.doc_id, data: JSON.parse(r.data), updated: r.updated })) });
  }
  const dm = p.match(/^\/api\/data\/([^/]+)$/);
  if (dm) {
    let id;
    try { id = decodeURIComponent(dm[1]); } catch { throw new HttpError(400, "Unknown document."); }
    if (!DOC_ID.test(id)) throw new HttpError(400, "Unknown document.");
    if (m === "PUT") {
      const text = await bodyText(req, MAX_DOC);
      let data;
      try { data = JSON.parse(text).data; } catch { throw new HttpError(400, "Bad data."); }
      if (!data || typeof data !== "object") throw new HttpError(400, "Bad data.");
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE user_id = ? AND doc_id != ?").bind(user.id, id).first("n");
      if (n >= MAX_DOCS) throw new HttpError(413, "Storage limit reached.");
      await env.DB.prepare(
        "INSERT INTO docs (user_id, doc_id, data, updated) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (user_id, doc_id) DO UPDATE SET data = excluded.data, updated = excluded.updated"
      ).bind(user.id, id, JSON.stringify(data), Date.now()).run();
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await env.DB.prepare("DELETE FROM docs WHERE user_id = ? AND doc_id = ?").bind(user.id, id).run();
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "Not found.");
}

// ---------- accounts ----------

async function signup(req, env) {
  const body = await readJson(req);
  const { email, password } = credentials(body, true);
  if (body.acceptTerms !== true) throw new HttpError(400, "Please agree to the Terms of Use and Privacy Policy.");
  await limit(env, "signup:" + ip(req), 10, 3600e3, "Too many new accounts from this connection. Try again later.");
  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (exists) throw new HttpError(409, "There's already an account with that email. Sign in instead.");
  const id = crypto.randomUUID(), code = recoveryCode(), now = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, pass, recovery, created, terms_version, terms_accepted) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, email, await hash(password), await hash(normCode(code)), now, TERMS_VERSION, now).run();
  return json({ token: await newSession(env, id), email, recovery: code });
}

async function login(req, env) {
  const { email, password } = credentials(await readJson(req), false);
  await limit(env, "loginip:" + ip(req), 30, 15 * 60e3, "Too many sign-in attempts from this connection. Wait 15 minutes and try again.");
  await limit(env, "login:" + email, 10, 15 * 60e3, "Too many tries. Wait 15 minutes and try again.");
  const user = await env.DB.prepare("SELECT id, pass FROM users WHERE email = ?").bind(email).first();
  const ok = await verify(password, user ? user.pass : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, "Email or password isn't right.");
  await env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind("login:" + email).run();
  return json({ token: await newSession(env, user.id), email });
}

async function reset(req, env) {
  const body = await readJson(req);
  const email = normEmail(body.email), code = normCode(body.recovery), password = String(body.password || "");
  checkNewPassword(password);
  await limit(env, "resetip:" + ip(req), 20, 3600e3, "Too many tries from this connection. Wait an hour and try again.");
  await limit(env, "reset:" + email, 5, 3600e3, "Too many tries. Wait an hour and try again.");
  const user = await env.DB.prepare("SELECT id, recovery FROM users WHERE email = ?").bind(email).first();
  const ok = await verify(code, user ? user.recovery : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, "Email or recovery code isn't right.");
  const next = recoveryCode();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pass = ?, recovery = ? WHERE id = ?").bind(await hash(password), await hash(normCode(next)), user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind("reset:" + email),
  ]);
  return json({ token: await newSession(env, user.id), email, recovery: next });
}

async function me(env, user) {
  if (hasSquare(env)) await checkDonations(env, user.id).catch(e => console.error(e));
  const row = await env.DB.prepare("SELECT email, pass, terms_version, donor_until FROM users WHERE id = ?").bind(user.id).first();
  const { results } = await env.DB.prepare("SELECT provider FROM identities WHERE user_id = ?").bind(user.id).all();
  return json({
    email: row.email.includes("@") ? row.email : null,
    hasPassword: !!row.pass,
    providers: results.map(r => r.provider),
    termsAccepted: row.terms_version === TERMS_VERSION,
    terms: TERMS_VERSION,
    donorUntil: row.donor_until || 0,
  });
}

/** Change (or, for Google/Facebook-only accounts, set) the password. Other devices are signed out. */
async function changePassword(req, env, user) {
  const body = await readJson(req);
  const password = String(body.password || "");
  const row = await env.DB.prepare("SELECT pass FROM users WHERE id = ?").bind(user.id).first();
  if (row.pass) await checkPassword(env, user, body.current);
  checkNewPassword(password);
  const updates = [
    env.DB.prepare("UPDATE users SET pass = ? WHERE id = ?").bind(await hash(password), user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, user.tokenHash),
  ];
  let recovery = null;
  if (!row.pass) { // first password: give them a recovery code too
    recovery = recoveryCode();
    updates.push(env.DB.prepare("UPDATE users SET recovery = ? WHERE id = ?").bind(await hash(normCode(recovery)), user.id));
  }
  await env.DB.batch(updates);
  return json({ ok: true, recovery });
}

async function newRecovery(req, env, user) {
  await checkPassword(env, user, (await readJson(req)).password);
  const code = recoveryCode();
  await env.DB.prepare("UPDATE users SET recovery = ? WHERE id = ?").bind(await hash(normCode(code)), user.id).run();
  return json({ recovery: code });
}

async function deleteAccount(req, env, user) {
  const body = await readJson(req);
  const row = await env.DB.prepare("SELECT pass FROM users WHERE id = ?").bind(user.id).first();
  if (row.pass) await checkPassword(env, user, body.password);
  else if (body.confirm !== "DELETE") throw new HttpError(403, "Type DELETE to confirm.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM docs WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM identities WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM donations WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE reports SET account_email = NULL WHERE account_email = ?").bind(user.email),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  return json({ ok: true });
}

async function checkPassword(env, user, password) {
  const key = "password:" + user.id;
  await limit(env, key, 10, 15 * 60e3, "Too many tries. Wait 15 minutes and try again.");
  const row = await env.DB.prepare("SELECT pass FROM users WHERE id = ?").bind(user.id).first();
  if (!row.pass) throw new HttpError(403, "Set a password first.");
  if (!(await verify(String(password || ""), row.pass))) throw new HttpError(403, "Your current password isn't right.");
  await env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(key).run();
}

function credentials(body, isNew) {
  const email = normEmail(body.email), password = String(body.password || "");
  if (email.length > 254 || !EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (isNew) checkNewPassword(password);
  else if (!password) throw new HttpError(400, "Enter your password.");
  else if (password.length > 256) throw new HttpError(400, "Email or password isn't right.");
  return { email, password };
}

function checkNewPassword(p) {
  if (p.length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
  if (p.length > 256) throw new HttpError(400, "Use 256 characters or fewer for your password.");
}

async function auth(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!m) throw new HttpError(401, "Sign in to continue.");
  const tokenHash = await sha256(m[1]);
  const row = await env.DB.prepare(
    "SELECT s.user_id, s.last_seen, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(tokenHash).first();
  const now = Date.now();
  if (!row || now - row.last_seen > SESSION_IDLE) throw new HttpError(401, "Sign in to continue.");
  if (now - row.last_seen > 864e5) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?").bind(now, tokenHash).run();
  }
  return { id: row.user_id, email: row.email, tokenHash };
}

async function newSession(env, userId) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created, last_seen) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now, now).run();
  return token;
}

/** Fixed-window rate limit. One atomic statement, so parallel requests can't slip past the count. */
async function limit(env, key, max, windowMs, message) {
  const count = await env.DB.prepare(
    "INSERT INTO attempts (key, count, first) VALUES (?1, 1, ?2) ON CONFLICT (key) DO UPDATE SET " +
    "count = CASE WHEN ?2 - first >= ?3 THEN 1 ELSE count + 1 END, " +
    "first = CASE WHEN ?2 - first >= ?3 THEN ?2 ELSE first END RETURNING count"
  ).bind(key, Date.now(), windowMs).first("count");
  if (count > max) throw new HttpError(429, message);
}

const ip = req => req.headers.get("CF-Connecting-IP") || "unknown";

// ---------- Donations (Square) ----------
//
// /api/donate makes a Square payment link for the chosen amount and the page sends the donor there.
// Signed-in donations are recorded by Square order id; /api/me (and the daily job) ask Square whether
// they were paid, and a paid donation of $5 or more sets donor_until, which pauses the monthly reminder.
// Card details only ever go to Square.

const hasSquare = env => !!env.SQUARE_ACCESS_TOKEN;
const squareBase = env => env.SQUARE_API_BASE /* local tests only */ || (env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");
let squareLocation = null; // {id, currency}, looked up once per Worker instance

async function square(env, path, body) {
  const r = await fetch(squareBase(env) + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + env.SQUARE_ACCESS_TOKEN, "Square-Version": "2025-01-23", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Square ${path} ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  return j;
}

async function squareLoc(env) {
  if (squareLocation) return squareLocation;
  const { locations = [] } = await square(env, "/v2/locations");
  const loc = locations.find(l => l.id === env.SQUARE_LOCATION_ID) || locations.find(l => l.status === "ACTIVE");
  if (!loc) throw new Error("Square has no active location");
  return squareLocation = { id: loc.id, currency: loc.currency || "AUD" };
}

async function donate(req, env, url) {
  if (!hasSquare(env)) throw new HttpError(404, "Donations aren't set up yet.");
  const user = req.headers.get("Authorization") ? await auth(req, env) : null;
  await limit(env, "donate:" + ip(req), 20, 3600e3, "Too many tries. Please wait a while and try again.");
  const amount = Math.round(+(await readJson(req)).amount);
  if (!(amount >= 100 && amount <= 100000)) throw new HttpError(400, "Choose an amount from $1 to $1,000.");
  const loc = await squareLoc(env);
  let res;
  try {
    res = await square(env, "/v2/online-checkout/payment-links", {
      idempotency_key: crypto.randomUUID(),
      quick_pay: { name: "DriveMate donation", price_money: { amount, currency: loc.currency }, location_id: loc.id },
      checkout_options: { redirect_url: `${url.origin}/?donated=1`, ask_for_shipping_address: false },
      payment_note: "DriveMate donation",
    });
  } catch (e) {
    console.error(e);
    throw new HttpError(502, "Couldn't reach the payment service. Try again soon.");
  }
  const link = res.payment_link;
  if (user) {
    await env.DB.prepare("INSERT INTO donations (order_id, user_id, amount, currency, created) VALUES (?, ?, ?, ?, ?)")
      .bind(link.order_id, user.id, amount, loc.currency, Date.now()).run();
  }
  return json({ url: link.url });
}

/** Asks Square about this user's unpaid donations from the last week and records any that were paid. */
async function checkDonations(env, userId) {
  const { results } = await env.DB.prepare("SELECT order_id FROM donations WHERE user_id = ? AND paid IS NULL AND created > ?")
    .bind(userId, Date.now() - DONATION_CHECK).all();
  for (const { order_id } of results) {
    const { order } = await square(env, "/v2/orders/" + encodeURIComponent(order_id));
    let paid = 0;
    for (const t of order?.tenders || []) {
      if (!t.payment_id) continue;
      const { payment } = await square(env, "/v2/payments/" + encodeURIComponent(t.payment_id));
      if (payment?.status === "COMPLETED") paid += payment.amount_money?.amount || 0;
    }
    if (!paid) continue;
    const now = Date.now();
    const stmts = [env.DB.prepare("UPDATE donations SET paid = ? WHERE order_id = ? AND user_id = ?").bind(paid, order_id, userId)];
    if (paid >= DONOR_MIN) {
      stmts.push(env.DB.prepare("UPDATE users SET donor_until = MAX(COALESCE(donor_until, 0), ?) WHERE id = ?").bind(now + DONOR_PAUSE, userId));
    }
    await env.DB.batch(stmts);
  }
}

// ---------- Google / Facebook sign-in ----------
//
// The browser (or, from the Android app, the phone's browser — Google blocks sign-in inside app web views)
// goes to /api/oauth/<provider>/start, then to the provider, then back to /callback. The callback finds or
// creates the account and redirects to /auth/done#code=…, a one-time code the page exchanges for a session.
// From the app, /auth/done is an Android App Link, so it opens straight back in DriveMate.

const hasGoogle = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OAUTH_SECRET);
const hasFacebook = env => !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET && env.OAUTH_SECRET);
const FB = "https://graph.facebook.com/v21.0";

async function oauthStart(env, url, provider) {
  if (provider === "google" ? !hasGoogle(env) : !hasFacebook(env)) throw new HttpError(404, "That sign-in option isn't available.");
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const redirect = `${url.origin}/api/oauth/${provider}/callback`;
  let to;
  if (provider === "google") {
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    to = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: "openid email",
      state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    });
  } else {
    to = "https://www.facebook.com/v21.0/dialog/oauth?" + new URLSearchParams({
      client_id: env.FACEBOOK_APP_ID, redirect_uri: redirect, response_type: "code", scope: "email", state,
    });
  }
  const cookie = await sign(env, { s: state, v: verifier, p: provider, app: url.searchParams.get("app") === "1", t: Date.now() });
  return new Response(null, { status: 302, headers: {
    Location: to, ...SECURITY_HEADERS, "Cache-Control": "no-store",
    "Set-Cookie": `dm_oauth=${cookie}; Path=/api/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  } });
}

async function oauthCallback(req, env, url, provider) {
  const cookie = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)dm_oauth=([^;]+)/);
  const st = cookie && await unsign(env, cookie[1]);
  const done = (frag, app) => new Response(null, { status: 302, headers: {
    Location: `${url.origin}/auth/done${app ? "?app=1" : ""}#${frag}`, ...SECURITY_HEADERS, "Cache-Control": "no-store",
    "Set-Cookie": "dm_oauth=; Path=/api/oauth; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
  } });
  if (!st || st.p !== provider || Date.now() - st.t > 600e3 || !safeEqual(st.s, url.searchParams.get("state") || "")) {
    return done("error=expired", st && st.app);
  }
  const code = url.searchParams.get("code");
  if (!code) return done("error=cancelled", st.app);
  const redirect = `${url.origin}/api/oauth/${provider}/callback`;
  let subject, email;
  try {
    ({ subject, email } = provider === "google" ? await googleUser(env, code, redirect, st.v) : await facebookUser(env, code, redirect));
  } catch (e) {
    console.error("oauth", provider, e.message);
    return done("error=failed", st.app);
  }
  await limit(env, "oauth:" + ip(req), 30, 3600e3, "Too many sign-ins from this connection.").catch(() => null);

  let isNew = 0;
  let userId = (await env.DB.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, subject).first("user_id"));
  if (!userId && email) userId = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first("id");
  if (!userId) {
    userId = crypto.randomUUID(); isNew = 1;
    const now = Date.now();
    // By continuing with Google/Facebook the person agrees to the terms (stated next to the buttons).
    await env.DB.prepare("INSERT INTO users (id, email, pass, recovery, created, terms_version, terms_accepted) VALUES (?, ?, '', '', ?, ?, ?)")
      .bind(userId, email || `${provider}:${subject}`, now, TERMS_VERSION, now).run();
  }
  await env.DB.prepare("INSERT OR IGNORE INTO identities (provider, subject, user_id, created) VALUES (?, ?, ?, ?)")
    .bind(provider, subject, userId, Date.now()).run();
  const one = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO login_codes (code_hash, user_id, is_new, created) VALUES (?, ?, ?, ?)")
    .bind(await sha256(one), userId, isNew, Date.now()).run();
  return done("code=" + one, st.app);
}

async function googleUser(env, code, redirect, verifier) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }),
  });
  const j = await r.json();
  if (!r.ok || !j.id_token) throw new Error("google token " + r.status);
  // The ID token came straight from Google's token endpoint over TLS, so its signature needn't be re-checked (OIDC 3.1.3.7).
  const claims = JSON.parse(new TextDecoder().decode(unb64url(j.id_token.split(".")[1])));
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !/^(https:\/\/)?accounts\.google\.com$/.test(claims.iss)) throw new Error("google claims");
  return { subject: String(claims.sub), email: claims.email && claims.email_verified ? normEmail(claims.email) : null };
}

async function facebookUser(env, code, redirect) {
  const t = await fetch(`${FB}/oauth/access_token?` + new URLSearchParams({ client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri: redirect, code }));
  const tj = await t.json();
  if (!t.ok || !tj.access_token) throw new Error("facebook token " + t.status);
  const proof = await hmacHex(env.FACEBOOK_APP_SECRET, tj.access_token);
  const u = await fetch(`${FB}/me?` + new URLSearchParams({ fields: "id,email", access_token: tj.access_token, appsecret_proof: proof }));
  const uj = await u.json();
  if (!u.ok || !uj.id) throw new Error("facebook me " + u.status);
  return { subject: String(uj.id), email: uj.email ? normEmail(uj.email) : null }; // Facebook only returns confirmed emails
}

async function oauthExchange(req, env) {
  const code = String((await readJson(req)).code || "");
  await limit(env, "exchange:" + ip(req), 30, 3600e3, "Too many tries. Try again later.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new HttpError(400, "That sign-in link isn't valid. Try again.");
  const row = await env.DB.prepare("DELETE FROM login_codes WHERE code_hash = ? RETURNING user_id, is_new, created").bind(await sha256(code)).first();
  if (!row || Date.now() - row.created > 300e3) throw new HttpError(400, "That sign-in link has expired. Try again.");
  const u = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(row.user_id).first();
  if (!u) throw new HttpError(400, "That account no longer exists.");
  return json({ token: await newSession(env, row.user_id), email: u.email.includes("@") ? u.email : null, isNew: !!row.is_new });
}

// ---------- bug reports ----------

async function report(req, env) {
  const body = await readJson(req, 20000);
  const message = String(body.message || "").trim().slice(0, 5000);
  const contact = String(body.contact || "").trim().slice(0, 200);
  const diag = JSON.stringify(body.diag || {}).slice(0, 8000);
  if (message.length < 5) throw new HttpError(400, "Tell us a little about what went wrong.");
  await limit(env, "report:" + ip(req), 5, 3600e3, "Thanks — you've sent a few reports already. Try again in an hour.");
  let accountEmail = null;
  try { accountEmail = (await auth(req, env)).email; } catch {}
  const id = (await env.DB.prepare(
    "INSERT INTO reports (created, message, contact, account_email, diag) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).bind(Date.now(), message, contact || null, accountEmail, diag).first("id"));
  const issue = await openIssue(env, id, message, body.diag || {});
  if (issue) await env.DB.prepare("UPDATE reports SET issue_url = ? WHERE id = ?").bind(issue, id).run();
  return json({ ok: true, id, issue: issue && issue.startsWith("https://") ? issue : null });
}

/** Posts the report as a GitHub issue when GITHUB_TOKEN and GITHUB_REPO are set. Contact details are never included. */
async function openIssue(env, id, message, diag) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return "not sent: GITHUB_TOKEN or GITHUB_REPO not set";
  const firstLine = message.split("\n")[0].slice(0, 70);
  const lines = Object.entries(diag).map(([k, v]) => `| ${k} | ${String(typeof v === "object" ? JSON.stringify(v) : v).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 500)} |`);
  const body = `${message}\n\n<details><summary>Diagnostics</summary>\n\n| | |\n|---|---|\n${lines.join("\n")}\n\n</details>\n\n_Sent from the in-app bug reporter (report #${id})._`;
  try {
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "drivemate-worker", "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Bug report: ${firstLine}`, body, labels: ["bug", "in-app report"] }),
    });
    if (!r.ok) {
      const why = `not sent: GitHub ${r.status} ${(await r.text()).slice(0, 200)}`;
      console.error(why);
      return why;
    }
    return (await r.json()).html_url;
  } catch (e) { console.error(e); return `not sent: ${e.message}`; }
}

// ---------- crypto helpers ----------

async function hash(secret, salt = crypto.getRandomValues(new Uint8Array(16)), iter = ITER) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

async function verify(secret, stored) {
  const [kind, iter, salt] = String(stored || "").split("$");
  if (kind !== "pbkdf2" || !salt || !(+iter > 0)) return false; // e.g. Google/Facebook-only accounts have no password
  const again = await hash(secret, unb64url(salt), +iter);
  return safeEqual(again, stored);
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Tamper-proof value for the short-lived sign-in cookie. */
async function sign(env, obj) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(obj)));
  return payload + "." + await hmacHex(env.OAUTH_SECRET, payload);
}

async function unsign(env, value) {
  const [payload, sig] = String(value).split(".");
  if (!payload || !sig || !safeEqual(sig, await hmacHex(env.OAUTH_SECRET, payload))) return null;
  try { return JSON.parse(new TextDecoder().decode(unb64url(payload))); } catch { return null; }
}

function recoveryCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const r = crypto.getRandomValues(new Uint8Array(16));
  return [...r].map(b => A[b % 32]).join("").match(/.{4}/g).join("-");
}

const normCode = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const normEmail = s => String(s || "").trim().toLowerCase();
const b64url = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function bodyText(req, max) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "That's too much data to save in one go.");
  return text;
}

async function readJson(req, max = 8000) {
  const text = await bodyText(req, max);
  try { return JSON.parse(text) || {}; } catch { throw new HttpError(400, "Bad request."); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": API_CSP, ...SECURITY_HEADERS,
  } });
}
