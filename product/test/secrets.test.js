import test from "node:test";
import assert from "node:assert/strict";
import { rejectSecrets } from "../src/secrets.js";
test("typed credential schemas remain shareable while scalar values and defaults are rejected", () => {
  const contract = JSON.stringify({
    properties: {
      password: { type: "string", minLength: 12, writeOnly: true },
      access_token: { $ref: "#/components/schemas/AccessToken" },
    },
  });
  const input = { content: contract };
  rejectSecrets(input);
  assert.equal(input.content, contract);
  for (const value of [
    { password: "hunter2" },
    { content: '{"password":"hunter2"}' },
    {
      content: JSON.stringify({
        properties: { password: { type: "string", default: "hunter2" } },
      }),
    },
    { content: "API_KEY=realcredentialvalue" },
    { content: "Authorization: Bearer abcdefghijklmnop" },
  ])
    assert.throws(
      () => rejectSecrets(value),
      (e) => e.statusCode === 400 && /secret/i.test(e.message),
    );
});
test("schema annotation renaming cannot hide secret values behind colliding keys", () => {
  assert.throws(
    () =>
      rejectSecrets({
        __schema_annotation_0__: "sk-proj-abcdefghijklmnopqrstuv",
        password: { type: "string" },
      }),
    /secret/,
  );
  assert.throws(
    () =>
      rejectSecrets({
        properties: {
          token: {
            type: "string",
            description: "sk-proj-abcdefghijklmnopqrstuv",
          },
        },
      }),
    /secret/,
  );
  rejectSecrets({ content: "API_KEY=<redacted>; password=$PASSWORD" });
});
