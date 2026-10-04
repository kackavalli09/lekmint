// Synthetic local checks: no real SMTP, database, mint keys or transactions.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import express from "express";
import nodemailer from "nodemailer";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
const require = createRequire(import.meta.url);
const qs = createRequire(require.resolve("express"))("qs");
assert.deepEqual(qs.parse("amount=123&unit=sat"), { amount: "123", unit: "sat" });
assert.equal({}.polluted, undefined);
qs.parse("__proto__[polluted]=yes&constructor[prototype][polluted]=yes");
assert.equal({}.polluted, undefined);
assert.equal(ipKeyGenerator("192.0.2.1"), "192.0.2.1");
assert.equal(ipKeyGenerator("2001:db8::1"), ipKeyGenerator("2001:db8::2"));
const mail = nodemailer.createTransport({ streamTransport: true, buffer: true });
const result = await mail.sendMail({
  from: "mint@example.invalid", to: "operator@example.invalid",
  subject: "SMTP regression", text: "Synthetic message", html: "<p>Synthetic message</p>",
});
assert.deepEqual(result.envelope.to, ["operator@example.invalid"]);
assert.match(result.message.toString(), /Subject: SMTP regression/);
assert.match(result.message.toString(), /Synthetic message/);
const failing = nodemailer.createTransport({
  name: "fixture", version: "1",
  send(_mail, callback) { callback(new Error("Synthetic SMTP rejection")); },
});
await assert.rejects(failing.sendMail({ to: "operator@example.invalid", text: "test" }), /Synthetic SMTP rejection/);
const app = express();
app.set("trust proxy", false);
app.use(rateLimit({ windowMs: 60000, limit: 2, validate: false }));
app.get("/", (_req, res) => res.json({ ok: true }));
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { headers: { "X-Forwarded-For": "192.0.2.44" } })).status, 429);
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log("Email generation/error handling, parsing, IP keys and HTTP rate-limit checks passed.");