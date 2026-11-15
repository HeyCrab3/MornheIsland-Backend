// Run: node --experimental-vm-modules --test tests/grpc-clients.test.mjs
// Real router, client registry, class resolver, grants and JWT verification;
// synthetic MongoDB records and isolated gRPC/configuration dependencies.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { SourceTextModule, SyntheticModule } from "node:vm";
import test from "node:test";
import express from "express";
import { expressjwt } from "express-jwt";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const unused = () => { throw new Error("Unexpected unrelated service call"); };
const fixtures = new Map([
  [new URL("config.ts", root).href, { config: {} }],
  [new URL("util/log.ts", root).href, { log: () => {} }],
  [new URL("util/token_guard.ts", root).href, { forgetTokenVersion: unused }],
  [new URL("util/grpc_scope.ts", root).href, { resolveTargets: unused }],
  [new URL("grpc/server.ts", root).href, {
    sendNotification: unused, sendDataUpdated: unused, sendRestartApp: unused,
    isGrpcListening: unused, getGrpcPort: unused, isGrpcTlsEnabled: unused,
  }],
]);
const modules = new Map();
function synthetic(exports) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  });
}
async function load(url) {
  if (modules.has(url.href)) return modules.get(url.href);
  const promise = (async () => {
    if (fixtures.has(url.href)) return synthetic(fixtures.get(url.href));
    const source = await readFile(url, "utf8");
    const result = ts.transpileModule(source, {
      fileName: url.pathname,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    assert.deepEqual(result.diagnostics, []);
    const module = new SourceTextModule(result.outputText, { identifier: url.href });
    await module.link(async specifier => {
      if (specifier.startsWith(".")) {
        return load(new URL(specifier.endsWith(".ts") ? specifier : `${specifier}.ts`, url));
      }
      return synthetic(await import(specifier));
    });
    return module;
  })();
  modules.set(url.href, promise);
  return promise;
}
const routeModule = await load(new URL("router/console/ci/grpc.ts", root));
await routeModule.evaluate();
const router = routeModule.namespace.default;
const registry = (await load(new URL("grpc/clients.ts", root))).namespace;
const oid = n => new ObjectId(n.toString(16).padStart(24, "0"));
const A = oid(1), B = oid(2), CA = oid(101), CB = oid(102), G = oid(201);
const secret = "synthetic-grpc-clients-test-secret";

function equal(a, b) {
  if (a instanceof ObjectId || b instanceof ObjectId) {
    return a instanceof ObjectId && b instanceof ObjectId && a.equals(b);
  }
  return a === b || (b === null && a === undefined);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(item => matches(doc, item));
    if (value && typeof value === "object" && !(value instanceof ObjectId)) {
      assert.deepEqual(Object.keys(value), ["$in"], "unsupported test query operator");
      return value.$in.some(item => equal(doc[key], item));
    }
    return equal(doc[key], value);
  });
}
function database({ classes = [], devices = [], grants = [], members = [], fail } = {}) {
  const collections = { ci_classes: classes, ci_clients: devices, ci_grants: grants, ci_grant_members: members };
  return { collection(name) {
    if (name === fail) throw new Error("Synthetic database outage");
    assert.ok(Object.hasOwn(collections, name), `Unexpected collection: ${name}`);
    const find = filter => {
      let rows = collections[name].filter(doc => matches(doc, filter));
      return {
        project() { return this; },
        limit(n) { rows = rows.slice(0, n); return this; },
        async toArray() { return rows; },
      };
    };
    return {
      find,
      async findOne(filter) { return (await find(filter).limit(1).toArray())[0] ?? null; },
      async createIndex() {},
    };
  } };
}
function ownClasses() {
  return [{ _id: CA, userId: A, identity: "class-a" }, { _id: CB, userId: B, identity: "class-b" }];
}
function grant(cap, extra = {}) {
  return { _id: G, ownerId: B, classIds: [CB], caps: [cap], expiresAt: new Date("2100-01-01"), revokedAt: null, ...extra };
}

async function request(t, { entries = [], user = A, claims, ...data } = {}) {
  registry.clients.clear();
  for (const entry of entries) {
    const c = registry.upsertClient(entry.cuid, entry.clientId ?? "", entry.mac ?? `synthetic-${entry.cuid}`);
    c.registeredAt = 1000;
    c.lastSeen = 2000;
    if (entry.online !== false) registry.attachStream(entry.cuid, { write: unused });
    c.lastSeen = 2000;
  }
  const before = registry.listClients();
  const app = express();
  app.use(expressjwt({ secret, algorithms: ["HS256"] }));
  app.use((req, _res, next) => { req.db = database(data); next(); });
  app.use("/api", router);
  app.use((error, _req, res, _next) => res.status(error.name === "UnauthorizedError" ? 401 : 500).json({ code: error.name === "UnauthorizedError" ? 401 : 500 }));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const headers = { Connection: "close" };
  if (user !== null) headers.Authorization = `Bearer ${jwt.sign(claims ?? { userId: String(user), admin: false }, secret, { expiresIn: "1m" })}`;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/console/ci/grpc/clients`, { headers });
  const body = await response.json();
  assert.deepEqual(registry.listClients(), before, "listing must not mutate the shared registry");
  return { status: response.status, body, before };
}
function expectClients(result, cuids) {
  assert.equal(result.status, 200);
  // Compare all fields, their types and ordering, not just the visible IDs.
  assert.deepEqual(result.body, { code: 0, msg: "ok", data: result.before.filter(c => cuids.includes(c.cuid)) });
}

test("gRPC registry listing respects tenant and delegation scope", async t => {
  const entries = [{ cuid: "own", clientId: String(CA) }, { cuid: "foreign", clientId: String(CB) }];
  const devices = [{ cuid: "own", classId: CA }, { cuid: "foreign", classId: CB }];
  await t.test("anonymous callers cannot enumerate", async t => {
    const r = await request(t, { user: null, entries });
    assert.equal(r.body.code, 401);
    assert.equal(r.body.data, undefined);
  });
  await t.test("a JWT without userId cannot enumerate", async t => {
    const r = await request(t, { claims: { admin: false }, entries });
    assert.equal(r.status, 401);
    assert.equal(r.body.data, undefined);
  });
  await t.test("ordinary user A sees only A's records", async t => expectClients(await request(t, { classes: ownClasses(), entries, devices }), ["own"]));
  await t.test("ordinary user B sees only B's records", async t => expectClients(await request(t, { user: B, classes: ownClasses(), entries, devices }), ["foreign"]));
  await t.test("user without classes or grants gets an empty array", async t => expectClients(await request(t, { entries, devices }), []));
  await t.test("admin claim does not grant global enumeration", async t => expectClients(await request(t, { claims: { userId: String(A), admin: true }, classes: ownClasses(), entries, devices }), ["own"]));

  for (const cap of ["device.control", "device.restart", "notify.send", "view", "resource.edit"]) {
    await t.test(`delegation capability ${cap}`, async t => {
      const r = await request(t, { classes: ownClasses(), entries, devices, grants: [grant(cap)], members: [{ grantId: G, userId: A }] });
      expectClients(r, cap.startsWith("device.") || cap === "notify.send" ? ["own", "foreign"] : ["own"]);
    });
  }
  for (const [label, extra, members] of [
    ["expired", { expiresAt: new Date("2000-01-01") }, [{ grantId: G, userId: A }]],
    ["revoked", { revokedAt: new Date("2020-01-01") }, [{ grantId: G, userId: A }]],
    ["membership removed", {}, []],
  ]) {
    await t.test(`${label} delegation exposes no foreign device`, async t => expectClients(await request(t, {
      classes: ownClasses(), entries, devices, grants: [grant("device.control", extra)], members,
    }), ["own"]));
  }
  await t.test("a delegation referencing a deleted class does not expose stale devices", async t => {
    expectClients(await request(t, {
      classes: ownClasses().filter(c => c._id.equals(CA)), entries, devices,
      grants: [grant("device.control")], members: [{ grantId: G, userId: A }],
    }), ["own"]);
  });
  await t.test("pinned classId wins over conflicting legacy identity and accepts strings", async t => {
    const r = await request(t, { classes: ownClasses(), entries, devices: [
      { cuid: "own", classId: String(CA), identity: "class-b" },
      { cuid: "foreign", classId: CB, identity: "class-a" },
    ] });
    expectClients(r, ["own"]);
  });
  await t.test("unbound duplicate legacy identities are not guessed", async t => {
    const classes = ownClasses().map(c => ({ ...c, identity: "duplicate" }));
    expectClients(await request(t, { classes, entries: [{ cuid: "ambiguous", clientId: "duplicate" }], devices: [{ cuid: "ambiguous", identity: "duplicate" }] }), []);
  });
  await t.test("unique legacy identity remains compatible", async t => {
    expectClients(await request(t, { classes: ownClasses(), entries: [{ cuid: "legacy", clientId: "class-a" }], devices: [{ cuid: "legacy", identity: "class-a" }] }), ["legacy"]);
  });
  await t.test("ObjectId class identifier takes precedence over another class's alias", async t => {
    const classes = ownClasses();
    classes[0].identity = String(CB);
    expectClients(await request(t, { classes, entries: [{ cuid: "collision", clientId: String(CB) }], devices: [{ cuid: "collision", identity: String(CB) }] }), []);
  });
  await t.test("reconnected entry with empty memory identity uses persisted identity", async t => {
    expectClients(await request(t, { classes: ownClasses(), entries: [{ cuid: "reconnected" }], devices: [{ cuid: "reconnected", identity: String(CA) }] }), ["reconnected"]);
  });
  await t.test("newly registered entry can resolve its class before persistence completes", async t => {
    expectClients(await request(t, { classes: ownClasses(), entries }), ["own"]);
  });
  await t.test("unknown and stale class bindings do not fall back to a matching alias", async t => {
    expectClients(await request(t, { classes: ownClasses(), entries: [{ cuid: "unknown" }, { cuid: "stale", clientId: "class-a" }], devices: [{ cuid: "stale", classId: oid(999), identity: "class-a" }] }), []);
  });
  await t.test("registered offline devices and the original response shape are preserved", async t => {
    expectClients(await request(t, { classes: ownClasses(), entries: [{ cuid: "own", clientId: String(CA), online: false }], devices }), ["own"]);
  });
  await t.test("database errors fail closed instead of returning all clients", async t => {
    const r = await request(t, { classes: ownClasses(), entries, devices, fail: "ci_classes" });
    assert.equal(r.status, 500);
    assert.equal(r.body.data, undefined);
  });
});
