import assert from "node:assert/strict";
import { test } from "node:test";
import { safePath } from "../src/record.js";

test("long path segments are not recorded", () => {
  assert.equal(safePath("/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX"), "/services/T000/B000/…");
  assert.equal(safePath("/bot123456:ABCDEFGHIJKLMNOP/sendMessage"), "/…/sendMessage");
  assert.equal(safePath("/v1/models"), "/v1/models");
});
