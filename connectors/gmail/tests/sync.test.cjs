const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function environment() {
  const config = new Map(Object.entries({
    API_BASE: "https://example.test", BCA_TOKEN: "testing", LABEL_ID: "bca", START_UNIX_SECONDS: "1700000000"
  }));
  const sent = [];
  let allow = true;
  const messages = [{id: "transaksi"}, {id: "otp"}];
  const context = vm.createContext({
    Date, PropertiesService: {getScriptProperties: () => ({
      getProperty: k => config.get(k), setProperty: (k, v) => config.set(k, v)
    })},
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock: () => {}})},
    Utilities: {base64DecodeWebSafe: value => Buffer.from(value, "base64url"),
      newBlob: bytes => ({getDataAsString: () => bytes.toString("utf8")})},
    Gmail: {Users: {Messages: {list: () => ({messages}), get: (_, id) => ({
      labelIds: ["bca"], internalDate: "1700010000000", payload: {headers: [{name: "Subject", value: id}],
        mimeType: "text/plain", body: {data: Buffer.from(id === "otp" ? "kode verifikasi 123456" : "Pembayaran Rp35.000").toString("base64url")}}
    })}}},
    UrlFetchApp: {fetch: (url, options) => {
      assert.equal(url, "https://example.test/v1/events/bca");
      assert.equal(options.followRedirects, false);
      sent.push(JSON.parse(options.payload));
      return {getResponseCode: () => allow ? 200 : 503};
    }}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8"), context);
  return {context, config, sent, setAllow(v) { allow = v; }};
}

test("only labelled transaction content is sent and the cursor advances after acknowledgment", () => {
  const env = environment();
  env.context.syncBca();
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].external_id, "transaksi");
  assert.match(env.sent[0].text, /Rp35.000/);
  assert.ok(JSON.parse(env.config.get("SYNC_CURSOR")).from > 1700000000);
});

test("server failure keeps the checkpoint and retries the identical receipt ID", () => {
  const env = environment();
  env.setAllow(false);
  assert.throws(() => env.context.syncBca(), /503/);
  assert.equal(env.config.has("SYNC_CURSOR"), false);
  env.setAllow(true);
  env.context.syncBca();
  assert.deepEqual(env.sent.map(e => e.external_id), ["transaksi", "transaksi"]);
});

test("HTML receipt contains no active content and attachments are excluded", () => {
  const env = environment();
  const body = {mimeType: "text/html", body: {data: Buffer.from("<p>Bayar Rp10.000</p><script>javascript</script>").toString("base64url")}};
  assert.equal(env.context.bodyBca_(body).trim(), "Bayar Rp10.000");
  assert.equal(env.context.bodyBca_({...body, filename: "struk.html"}), "");
});

test("a second page uses the same time window and advances only after the final page", () => {
  const env = environment();
  const queries = [];
  env.context.Gmail.Users.Messages.list = (_, options) => {
    queries.push(options.q);
    return options.pageToken === "page-2" ? {messages: [{id: "second"}]} :
      {messages: [{id: "first"}], nextPageToken: "page-2"};
  };
  env.context.syncBca();
  const intermediate = JSON.parse(env.config.get("SYNC_CURSOR"));
  assert.equal(intermediate.page, "page-2");
  env.context.syncBca();
  const final = JSON.parse(env.config.get("SYNC_CURSOR"));
  assert.equal(queries[0], queries[1]);
  assert.equal(final.from, intermediate.until);
  assert.equal(final.page, "");
  assert.deepEqual(env.sent.map(e => e.external_id), ["first", "second"]);
});
