// DriveMate accounts and sync API. Static files (the web app) are served by the assets binding.

const ITER = 100000;               // PBKDF2 iterations (the Workers maximum)
const SESSION_IDLE = 180 * 864e5;  // sign out after 6 months unused
const MAX_DOC = 1_000_000;         // bytes per stored document
const MAX_DOCS = 600;              // config + 50 years of months
const DOC_ID = /^(config|m-\d{4}-\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  if (p === "/api/signup" && m === "POST") return signup(req, env);
  if (p === "/api/login" && m === "POST") return login(req, env);
  if (p === "/api/reset" && m === "POST") return reset(req, env);
  if (p === "/api/report" && m === "POST") return report(req, env);

  const user = await auth(req, env);
  if (p === "/api/me" && m === "GET") return json({ email: user.email });
  if (p === "/api/logout" && m === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
    return json({ ok: true });
  }
  if (p === "/api/account" && m === "DELETE") {
    const body = await readJson(req);
    const row = await env.DB.prepare("SELECT pass FROM users WHERE id = ?").bind(user.id).first();
    if (!(await verify(String(body.password || ""), row.pass))) throw new HttpError(403, "That password isn't right.");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM docs WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    return json({ ok: true });
  }
  if (p === "/api/data" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT doc_id, data, updated FROM docs WHERE user_id = ?").bind(user.id).all();
    return json({ docs: results.map(r => ({ id: r.doc_id, data: JSON.parse(r.data), updated: r.updated })) });
  }
  const dm = p.match(/^\/api\/data\/([^/]+)$/);
  if (dm) {
    const id = decodeURIComponent(dm[1]);
    if (!DOC_ID.test(id)) throw new HttpError(400, "Unknown document.");
    if (m === "PUT") {
      const text = await req.text();
      if (text.length > MAX_DOC) throw new HttpError(413, "That's too much data to save in one go.");
      let data;
      try { data = JSON.parse(text).data; } catch { throw new HttpError(400, "Bad data."); }
      if (!data || typeof data !== "object") throw new HttpError(400, "Bad data.");
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE user_id = ?").bind(user.id).first("n");
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

// ---------- bug reports ----------

async function report(req, env) {
  const body = await readJson(req);
  const message = String(body.message || "").trim().slice(0, 5000);
  const contact = String(body.contact || "").trim().slice(0, 200);
  const diag = JSON.stringify(body.diag || {}).slice(0, 8000);
  if (message.length < 5) throw new HttpError(400, "Tell us a little about what went wrong.");
  await limit(env, "report:" + (req.headers.get("CF-Connecting-IP") || "?"), 5, 3600e3,
    "Thanks — you've sent a few reports already. Try again in an hour.");
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

// ---------- accounts ----------

async function signup(req, env) {
  const { email, password } = await credentials(req);
  await limit(env, "signup:" + (req.headers.get("CF-Connecting-IP") || "?"), 10, 3600e3,
    "Too many new accounts from this connection. Try again later.");
  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (exists) throw new HttpError(409, "There's already an account with that email. Sign in instead.");
  const id = crypto.randomUUID(), code = recoveryCode();
  await env.DB.prepare("INSERT INTO users (id, email, pass, recovery, created) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, await hash(password), await hash(normCode(code)), Date.now()).run();
  return json({ token: await newSession(env, id), email, recovery: code });
}

async function login(req, env) {
  const { email, password } = await credentials(req, false);
  const key = "login:" + email;
  await limit(env, key, 10, 15 * 60e3, "Too many tries. Wait 15 minutes and try again.");
  const user = await env.DB.prepare("SELECT id, pass FROM users WHERE email = ?").bind(email).first();
  if (!user || !(await verify(password, user.pass))) throw new HttpError(401, "Email or password isn't right.");
  await env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(key).run();
  return json({ token: await newSession(env, user.id), email });
}

async function reset(req, env) {
  const body = await readJson(req);
  const email = normEmail(body.email), code = normCode(body.recovery), password = String(body.password || "");
  if (password.length < 8) throw new HttpError(400, "Use at least 8 characters for the new password.");
  const key = "reset:" + email;
  await limit(env, key, 5, 60 * 60e3, "Too many tries. Wait an hour and try again.");
  const user = await env.DB.prepare("SELECT id, recovery FROM users WHERE email = ?").bind(email).first();
  if (!user || !(await verify(code, user.recovery))) throw new HttpError(401, "Email or recovery code isn't right.");
  const next = recoveryCode();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pass = ?, recovery = ? WHERE id = ?").bind(await hash(password), await hash(normCode(next)), user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM attempts WHERE key = ?").bind(key),
  ]);
  return json({ token: await newSession(env, user.id), email, recovery: next });
}

async function credentials(req, strict = true) {
  const body = await readJson(req);
  const email = normEmail(body.email), password = String(body.password || "");
  if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (strict && password.length < 8) throw new HttpError(400, "Use at least 8 characters for your password.");
  if (!password) throw new HttpError(400, "Enter your password.");
  return { email, password };
}

async function auth(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer (\S+)$/);
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

/** Counts attempts per key in a fixed window and refuses once `max` is reached. */
async function limit(env, key, max, windowMs, message) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, first FROM attempts WHERE key = ?").bind(key).first();
  if (row && now - row.first < windowMs) {
    if (row.count >= max) throw new HttpError(429, message);
    await env.DB.prepare("UPDATE attempts SET count = count + 1 WHERE key = ?").bind(key).run();
  } else {
    await env.DB.prepare("INSERT OR REPLACE INTO attempts (key, count, first) VALUES (?, 1, ?)").bind(key, now).run();
  }
}

// ---------- crypto helpers ----------

async function hash(secret, salt = crypto.getRandomValues(new Uint8Array(16)), iter = ITER) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return `pbkdf2$${iter}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

async function verify(secret, stored) {
  const [, iter, salt] = String(stored).split("$");
  const again = await hash(secret, unb64url(salt), +iter);
  if (again.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < again.length; i++) diff |= again.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
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

async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, "Bad request."); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
