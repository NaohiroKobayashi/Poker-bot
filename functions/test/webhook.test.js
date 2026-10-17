const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// LINE SDKの本物の署名検証を使い、Firebaseと秘密値だけをテスト用に置き換える。
const entryPath = path.join(__dirname, "../index.js");
const entryRequire = createRequire(entryPath);
const secret = "webhook-test-secret";
const context = {
  exports: {},
  console,
  require(name) {
    if (name === "firebase-functions/v2/https") return { onRequest: (_, handler) => handler };
    if (name === "firebase-functions/v2/scheduler") return { onSchedule: (_, handler) => handler };
    if (name === "firebase-functions/params") return { defineSecret: () => ({ value: () => secret }) };
    if (name === "firebase-admin") return { apps: [{}], firestore: () => ({}) };
    return entryRequire(name);
  },
};
vm.runInNewContext(fs.readFileSync(entryPath, "utf8"), context, { filename: entryPath });

const rawBody = Buffer.from(JSON.stringify({ events: [] }));

for (const signature of [undefined, "invalid", ["invalid"]]) {
  test(`Webhookは不正な署名を403で拒否する: ${JSON.stringify(signature)}`, async () => {
    let status;
    let body;
    const res = { status(code) { status = code; return this; }, send(text) { body = text; } };
    await context.exports.webhook({ headers: { "x-line-signature": signature }, rawBody, body: { events: [] } }, res);
    assert.equal(status, 403);
    assert.equal(body, "invalid signature");
  });
}

test("Webhookは正しい署名の空イベントを200で受け付ける", async () => {
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  let status;
  let body;
  const res = { status(code) { status = code; return this; }, send(text) { body = text; } };
  await context.exports.webhook({ headers: { "x-line-signature": signature }, rawBody, body: { events: [] } }, res);
  assert.equal(status, 200);
  assert.equal(body, "ok");
});
