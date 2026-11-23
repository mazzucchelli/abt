import { test } from "node:test";
import assert from "node:assert/strict";
import { trackerCredentials } from "../../src/onboard/cli.ts";

test("onboard open defaults the Linear key to the Keychain item setup creates, which the runner daemon can read", () => {
  assert.deepEqual(trackerCredentials({}), { keychain: "abt-linear" });
});

test("onboard open takes another Keychain item, or an env var on request", () => {
  assert.deepEqual(trackerCredentials({ "--credentials-keychain": "linear-work" }), { keychain: "linear-work" });
  assert.deepEqual(trackerCredentials({ "--credentials-env": "LINEAR_API_KEY" }), { env: "LINEAR_API_KEY" });
});

test("onboard open refuses both a Keychain item and an env var", () => {
  assert.equal(trackerCredentials({ "--credentials-keychain": "a", "--credentials-env": "B" }), undefined);
});
