// Run with: node --experimental-vm-modules --test tests/bootstrap.test.mjs
// The real router and token guard run behind real JWT verification. Only external
// services, configuration and the database are replaced with synthetic fixtures.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";
import express from "express";
import { expressjwt } from "express-jwt";
import jwt from "jsonwebtoken";
import ts from "typescript";

const endpoint = "/api/v1/console/ci/plugin/bootstrap";
const userId = "000000000000000000000001";
const config = { bootstrap_plugin_url: "https://downloads.example.test/bootstrap.cipx" };
const secret = "synthetic-bootstrap-test-key-not-a-deployment-secret";
const unused = () => { throw new Error("Unexpected unrelated service call"); };

function moduleOf(exports) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  });
}

async function loadSource(relativePath, fixtures) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const result = ts.transpileModule(source, {
    fileName: relativePath,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics, []);
  const module = new SourceTextModule(result.outputText, { identifier: relativePath });
  await module.link(async (specifier) => {
    if (Object.hasOwn(fixtures, specifier)) return moduleOf(fixtures[specifier]);
    // These are the actual runtime dependencies, not mocks of Express or ObjectId.
    if (specifier.startsWith("node:") || ["express", "mongodb"].includes(specifier)) {
      return moduleOf(await import(specifier));
    }
    throw new Error(`Unaccounted import in bootstrap test: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

const { default: router } = await loadSource("../router/console/ci/plugin.ts", {
  "../../../config": { config },
  "../../../util/log": { log: () => {} },
  "../../../util/ci_public": { safeClientIdentities: unused },
  "../../../util/cipx": { readCipxManifest: unused },
  "../../../util/public_url": { resolvePublicBase: unused, resolvePluginSourceUrl: unused },
  "../../../util/plugin_source": { fetchFirstAvailable: unused },
  "../../../grpc/server": {
    deliverPlugin: unused, fetchClientPlugins: unused, BOOTSTRAP_PLUGIN_ID: "test.bootstrap",
  },
  "../../../grpc/clients": { isOnline: unused },
  "../../../util/grpc_scope": { resolveTargets: unused },
  "./plugin_market": { fetchMarket: unused, resolveMarketPackage: unused },
});
const { tokenGuard, forgetTokenVersion } = await loadSource("../util/token_guard.ts", {
  "../config.ts": { config },
  "./log.ts": { log: () => {} },
  "./db.ts": { client: { db: unused } },
});

function database(saved) {
  const state = { saved: structuredClone(saved), reads: 0, writes: 0 };
  return {
    state,
    collection(name) {
      if (name === "user") return { findOne: async () => ({ tokenVersion: 0 }) };
      assert.equal(name, "ci_system_settings");
      return {
        async findOne(filter) {
          assert.equal(filter._id, "bootstrap_plugin_url");
          state.reads++;
          return state.saved;
        },
        async updateOne(filter, update) {
          assert.equal(filter._id, "bootstrap_plugin_url");
          state.writes++;
          state.saved = { _id: filter._id, ...update.$set };
          return { matchedCount: 1 };
        },
        async deleteOne(filter) {
          assert.equal(filter._id, "bootstrap_plugin_url");
          state.writes++;
          state.saved = null;
          return { deletedCount: 1 };
        },
      };
    },
  };
}

async function request(t, { method = "GET", claims = { userId, admin: false, tv: 0 }, body, saved = null } = {}) {
  const db = database(saved);
  forgetTokenVersion(userId);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(expressjwt({ secret, algorithms: ["HS256"] }));
  app.use(tokenGuard);
  // Mirrors the frontend /api proxy prefix; the production router has /v1 paths.
  app.use("/api", router);
  app.use((error, _req, res, _next) => {
    // server.ts uses HTTP 200 + code 401 for JWT failures.
    if (error.name === "UnauthorizedError") return res.json({ code: 401, msg: "请先登录" });
    res.status(500).json({ code: 500, msg: String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const headers = { "Content-Type": "application/json", Connection: "close" };
  if (claims) headers.Authorization = `Bearer ${jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: "1m" })}`;
  const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, state: db.state };
}

test("bootstrap is read-only and trusts deployment configuration", async (t) => {
  for (const method of ["GET", "PUT"]) {
    await t.test(`anonymous ${method} remains unauthenticated`, async (t) => {
      const r = await request(t, { method, claims: null, body: method === "PUT" ? { url: "https://untrusted.example.test/plugin.cipx" } : undefined });
      assert.equal(JSON.parse(r.text).code, 401);
      assert.equal(r.state.writes, 0);
      assert.equal(r.state.reads, 0);
    });
  }
  await t.test("GET still requires a userId", async (t) => {
    const r = await request(t, { claims: { admin: false } });
    assert.equal(r.status, 401);
    assert.equal(JSON.parse(r.text).code, 401);
  });
  for (const admin of [false, true]) {
    for (const url of ["https://untrusted.example.test/plugin.cipx", ""]) {
      await t.test(`${admin ? "admin" : "ordinary user"} cannot ${url ? "replace" : "reset"} the global URL`, async (t) => {
        const saved = { _id: "bootstrap_plugin_url", value: "https://legacy.example.test/plugin.cipx" };
        const r = await request(t, { method: "PUT", claims: { userId, admin, tv: 0 }, body: { url }, saved });
        assert.equal(r.state.writes, 0, "the removed endpoint must never write or delete settings");
        assert.deepEqual(r.state.saved, saved);
        assert.equal(r.status, 404);
      });
    }
  }
  for (const [label, configured, saved] of [
    ["configured HTTPS URL", "https://downloads.example.test/bootstrap.cipx", null],
    ["configured HTTP URL", "http://intranet.example.test/bootstrap.cipx", null],
    ["polluted database override", "https://downloads.example.test/bootstrap.cipx", { value: "https://untrusted.example.test/plugin.cipx" }],
    ["legacy override without metadata", "https://downloads.example.test/bootstrap.cipx", { value: "https://legacy.example.test/plugin.cipx" }],
    ["empty configuration", "", { value: "https://untrusted.example.test/plugin.cipx" }],
    ["omitted configuration", undefined, { value: "https://untrusted.example.test/plugin.cipx" }],
  ]) {
    await t.test(`GET preserves its response contract: ${label}`, async (t) => {
      config.bootstrap_plugin_url = configured;
      const r = await request(t, { saved });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.text), { code: 0, msg: "ok", data: { url: configured || "", isDefault: true } });
      assert.equal(r.state.reads, 0, "legacy global settings must not be trusted");
      assert.equal(r.state.writes, 0);
      assert.deepEqual(r.state.saved, saved, "reading must not delete forensic evidence");
    });
  }
});
