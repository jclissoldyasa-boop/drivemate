// Security tests for the DriveMate API. They run against a live deployment and clean up after themselves.
//   BASE=https://drivemate.agency-log.workers.dev node test/security.test.mjs
// Each test account uses a "sectest-" email and is deleted at the end.

const BASE = process.env.BASE || "https://drivemate.agency-log.workers.dev";
const results = [];
const created = [];
let failures = 0;

async function call(path, { method = "GET", token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = "Bearer " + token;
  if (body !== undefined || raw !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  let j = null;
  try { j = await r.clone().json(); } catch {}
  return { status: r.status, json: j, headers: r.headers };
}

async function test(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (e) {
    failures++;
    results.push(["FAIL", name + " — " + e.message]);
  }
}

function expect(cond, msg) { if (!cond) throw new Error(msg); }

async function account(tag) {
  const email = `sectest-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const password = "Sectest-pass-" + Math.random().toString(36).slice(2);
  const r = await call("/api/signup", { method: "POST", body: { email, password, acceptTerms: true } });
  if (r.status !== 200) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.json)}`);
  const a = { email, password, token: r.json.token, recovery: r.json.recovery };
  created.push(a);
  return a;
}

const A = await account("a");
const B = await account("b");
await call("/api/data/config", { method: "PUT", token: A.token, body: { data: { secret: "A-only", vehicles: [{ id: "va", name: "A's car" }] } } });
await call("/api/data/m-2026-01", { method: "PUT", token: A.token, body: { data: { trips: [{ id: "ta" }] } } });

// ---------- authentication ----------

await test("No token: data can't be read, written or deleted", async () => {
  for (const [m, p] of [["GET", "/api/data"], ["PUT", "/api/data/config"], ["DELETE", "/api/data/config"], ["GET", "/api/me"]]) {
    const r = await call(p, { method: m, body: m === "PUT" ? { data: {} } : undefined });
    expect(r.status === 401, `${m} ${p} gave ${r.status}`);
  }
});

await test("Forged and malformed tokens are refused", async () => {
  for (const t of ["x", "A".repeat(43), A.token.slice(0, -1) + (A.token.endsWith("A") ? "B" : "A"), "' OR '1'='1"]) {
    const r = await call("/api/data", { token: t });
    expect(r.status === 401, `token ${t.slice(0, 10)}… gave ${r.status}`);
  }
  const r = await call("/api/data", { headers: { Authorization: "Basic " + A.token } });
  expect(r.status === 401, `non-Bearer scheme gave ${r.status}`);
});

// ---------- row-level isolation ----------

await test("Account B can't see account A's data", async () => {
  const r = await call("/api/data", { token: B.token });
  expect(r.status === 200, `status ${r.status}`);
  expect(!JSON.stringify(r.json).includes("A-only"), "B's data list contains A's document");
  expect(r.json.docs.length === 0, `B sees ${r.json.docs.length} documents`);
});

await test("Account B writing the same document ids doesn't touch A's", async () => {
  await call("/api/data/config", { method: "PUT", token: B.token, body: { data: { secret: "B-wrote" } } });
  const r = await call("/api/data", { token: A.token });
  const cfg = r.json.docs.find(d => d.id === "config");
  expect(cfg && cfg.data.secret === "A-only", "A's config was changed by B");
});

await test("Account B deleting a document id doesn't delete A's", async () => {
  await call("/api/data/m-2026-01", { method: "DELETE", token: B.token });
  const r = await call("/api/data", { token: A.token });
  expect(r.json.docs.some(d => d.id === "m-2026-01"), "A's month was deleted by B");
});

await test("Document ids can't be used for injection or path tricks", async () => {
  const bad = ["config' OR '1'='1", "..%2Fconfig", "%2e%2e%2fconfig", "config%00", "m-2026-1", "m-2026-01;DROP TABLE docs", "CONFIG", "m-2026-01/x"];
  for (const id of bad) {
    const r = await call("/api/data/" + id, { method: "PUT", token: B.token, body: { data: { x: 1 } } });
    expect(r.status === 400 || r.status === 404, `id ${id} gave ${r.status}`);
  }
  const r = await call("/api/data", { token: A.token });
  expect(r.json.docs.length === 2, "A's documents changed during injection attempts");
});

await test("Injection in the email field doesn't sign anyone in", async () => {
  for (const email of ["' OR '1'='1", `${A.email}' --`, `${A.email}" OR "1"="1`]) {
    const r = await call("/api/login", { method: "POST", body: { email, password: "x" } });
    expect(r.status !== 200, `email ${email} signed in`);
  }
});

// ---------- input handling ----------

await test("Malformed JSON gives 400, not a server error", async () => {
  for (const p of ["/api/login", "/api/signup", "/api/reset", "/api/report"]) {
    const r = await call(p, { method: "POST", raw: "{not json" });
    expect(r.status === 400, `${p} gave ${r.status}`);
  }
});

await test("Oversized bodies are refused", async () => {
  const r = await call("/api/data/config", { method: "PUT", token: B.token, raw: JSON.stringify({ data: { x: "y".repeat(1_100_000) } }) });
  expect(r.status === 413, `big document gave ${r.status}`);
  const r2 = await call("/api/login", { method: "POST", raw: JSON.stringify({ email: "a@b.co", password: "p".repeat(2_000_000) }) });
  expect(r2.status === 413 || r2.status === 400, `2 MB login body gave ${r2.status}`);
});

await test("Over-long email and password are refused at sign-up", async () => {
  const r = await call("/api/signup", { method: "POST", body: { email: "a".repeat(300) + "@example.com", password: "longenough1", acceptTerms: true } });
  expect(r.status === 400, `300-char email gave ${r.status}`);
  const r2 = await call("/api/signup", { method: "POST", body: { email: `sectest-long-${Date.now()}@example.com`, password: "p".repeat(5000), acceptTerms: true } });
  expect(r2.status === 400, `5000-char password gave ${r2.status}`);
});

await test("Sign-up requires agreeing to the terms", async () => {
  const r = await call("/api/signup", { method: "POST", body: { email: `sectest-noterms-${Date.now()}@example.com`, password: "longenough1" } });
  expect(r.status === 400, `sign-up without acceptTerms gave ${r.status}`);
});

// ---------- sessions ----------

await test("Signing out revokes the token", async () => {
  const s = await call("/api/login", { method: "POST", body: { email: B.email, password: B.password } });
  expect(s.status === 200, `login ${s.status}`);
  await call("/api/logout", { method: "POST", token: s.json.token });
  const r = await call("/api/me", { token: s.json.token });
  expect(r.status === 401, `token still works after sign-out (${r.status})`);
});

await test("Changing password signs out other devices but not this one", async () => {
  const other = await call("/api/login", { method: "POST", body: { email: B.email, password: B.password } });
  const np = B.password + "-2";
  const r = await call("/api/password", { method: "POST", token: B.token, body: { current: B.password, password: np } });
  expect(r.status === 200, `change gave ${r.status}`);
  B.password = np;
  expect((await call("/api/me", { token: other.json.token })).status === 401, "other device still signed in");
  expect((await call("/api/me", { token: B.token })).status === 200, "this device was signed out");
});

await test("Password reset with a recovery code signs out every old session", async () => {
  const r = await call("/api/reset", { method: "POST", body: { email: B.email, recovery: B.recovery, password: B.password + "-3" } });
  expect(r.status === 200, `reset gave ${r.status}`);
  expect((await call("/api/me", { token: B.token })).status === 401, "old token survived reset");
  B.token = r.json.token; B.password += "-3"; B.recovery = r.json.recovery;
  const again = await call("/api/reset", { method: "POST", body: { email: B.email, recovery: "AAAA-AAAA-AAAA-AAAA", password: "whatever12" } });
  expect(again.status === 401, `wrong recovery code gave ${again.status}`);
});

// ---------- cross-origin and headers ----------

await test("Other websites can't call the API from a browser", async () => {
  const r = await fetch(BASE + "/api/data", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
  const allow = r.headers.get("access-control-allow-origin");
  expect(!allow || allow === BASE, `preflight allowed origin ${allow}`);
});

await test("Security headers are set on the app and the API", async () => {
  for (const p of ["/", "/api/me"]) {
    const r = await fetch(BASE + p);
    const h = k => r.headers.get(k) || "";
    expect(h("strict-transport-security").includes("max-age"), `${p}: no HSTS`);
    expect(h("x-content-type-options") === "nosniff", `${p}: no nosniff`);
    expect(/frame-ancestors 'none'/.test(h("content-security-policy")) || h("x-frame-options") === "DENY", `${p}: can be framed`);
    expect(h("referrer-policy"), `${p}: no Referrer-Policy`);
    if (p === "/") expect(/script-src/.test(h("content-security-policy")), "/: CSP has no script-src");
  }
});

// ---------- abuse ----------

await test("Unknown and known emails take about the same time to refuse (no account probing)", async () => {
  const time = async email => { const t = Date.now(); await call("/api/login", { method: "POST", body: { email, password: "wrong-password" } }); return Date.now() - t; };
  const ghost = `sectest-ghost-${Date.now()}@example.com`;
  let known = 0, unknown = 0;
  for (let i = 0; i < 4; i++) { known += await time(A.email); unknown += await time(ghost); }
  expect(known - unknown < 4 * 120, `known emails are slower by ${Math.round((known - unknown) / 4)} ms on average`);
});

await test("Login attempts per email are capped, even when sent all at once", async () => {
  const rs = await Promise.all(Array.from({ length: 20 }, () => call("/api/login", { method: "POST", body: { email: A.email, password: "wrong" } })));
  const allowed = rs.filter(r => r.status !== 429).length;
  expect(allowed <= 10, `${allowed} of 20 parallel attempts were processed (limit is 10)`);
});

await test("One connection can't spray passwords across many emails", async () => {
  let blocked = false;
  for (let i = 0; i < 40 && !blocked; i++) {
    const r = await call("/api/login", { method: "POST", body: { email: `sectest-spray-${i}-${Date.now()}@example.com`, password: "Password1" } });
    blocked = r.status === 429;
  }
  expect(blocked, "40 different emails were all tried without a block");
});

// ---------- Google / Facebook sign-in ----------

await test("Sign-in callback rejects a missing or forged state cookie", async () => {
  for (const provider of ["google", "facebook"]) {
    for (const cookie of [undefined, "dm_oauth=eyJzIjoieCJ9.deadbeef", "dm_oauth=garbage"]) {
      const r = await fetch(`${BASE}/api/oauth/${provider}/callback?code=abc&state=x`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
      expect(r.status === 302, `${provider} callback gave ${r.status}`);
      expect((r.headers.get("location") || "").includes("#error="), `${provider} callback with ${cookie || "no cookie"} didn't fail safely`);
    }
  }
});

await test("Sign-in codes can't be guessed or reused", async () => {
  for (const code of ["", "x", "A".repeat(43), "' OR 1=1 --"]) {
    const r = await call("/api/oauth/exchange", { method: "POST", body: { code } });
    expect(r.status === 400 || r.status === 429, `code ${code.slice(0, 8)} gave ${r.status}`);
    expect(!r.json?.token, "got a session from a made-up code");
  }
});

await test("Unconfigured sign-in providers are switched off", async () => {
  const c = await call("/api/config");
  for (const provider of ["google", "facebook"]) {
    if (c.json[provider]) continue;
    const r = await fetch(`${BASE}/api/oauth/${provider}/start`, { redirect: "manual" });
    expect(r.status === 404, `${provider} start gave ${r.status} while not configured`);
  }
});

await test("Privacy Policy, Terms and sign-in return pages are served with the security policy", async () => {
  for (const p of ["/privacy", "/terms", "/auth/done"]) {
    const r = await fetch(BASE + p);
    expect(r.status === 200, `${p} gave ${r.status}`);
    expect(/script-src/.test(r.headers.get("content-security-policy") || ""), `${p} has no CSP`);
  }
  const privacy = await (await fetch(BASE + "/privacy")).text();
  for (const must of ["Yasa Yard Management", "Australian Privacy Principles", "Office of the Australian Information Commissioner", "Overseas"]) {
    expect(privacy.includes(must), `Privacy Policy doesn't mention ${must}`);
  }
});

// ---------- account deletion ----------

await test("Deleting an account removes its data and sessions", async () => {
  const C = await account("c");
  await call("/api/data/config", { method: "PUT", token: C.token, body: { data: { x: 1 } } });
  const wrong = await call("/api/account", { method: "DELETE", token: C.token, body: { password: "nope" } });
  expect(wrong.status === 403, `wrong password delete gave ${wrong.status}`);
  const r = await call("/api/account", { method: "DELETE", token: C.token, body: { password: C.password } });
  expect(r.status === 200, `delete gave ${r.status}`);
  C.deleted = true;
  expect((await call("/api/data", { token: C.token })).status === 401, "token still works after deletion");
  expect((await call("/api/login", { method: "POST", body: { email: C.email, password: C.password } })).status !== 200, "deleted account can still sign in");
});

// ---------- clean up ----------
for (const a of created) {
  if (a.deleted) continue;
  const s = await call("/api/login", { method: "POST", body: { email: a.email, password: a.password } });
  const token = s.json?.token || a.token;
  await call("/api/account", { method: "DELETE", token, body: { password: a.password } });
}

for (const [s, n] of results) console.log(`${s === "PASS" ? "✓" : "✗"} ${n}`);
console.log(`\n${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
