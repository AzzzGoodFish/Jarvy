import test from "node:test";
import assert from "node:assert/strict";
import { UpdateService } from "../.test-dist/server/service/update.js";

test("UpdateService exposes idle progress initially", () => {
  const svc = new UpdateService();
  const st = svc.status();
  assert.equal(st.updating, false);
  assert.equal(st.progress?.phase, "idle");
  assert.equal(st.progress?.targetVersion, null);
  assert.equal(st.progress?.detail, null);
});

test("UpdateService validates git checkout mode before starting background install", async () => {
  const svc = new UpdateService();
  if (svc.installMode === "git") {
    await assert.rejects(() => svc.apply("9.9.9"), /git source checkout/);
    assert.equal(svc.status().updating, false);
    assert.equal(svc.status().progress?.phase, "idle");
  }
});
