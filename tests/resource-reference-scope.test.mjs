// Node >= 22.13: node --test tests/resource-reference-scope.test.mjs
// Production handlers and authorization logic; synthetic database/framework only.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = process.env.AUDIT_SOURCE_ROOT || path.resolve(import.meta.dirname, '..');
function load(file, globals = {}) {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  source = source.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export default .*;\s*$/gm, '').replace(/^export /gm, '');
  const ctx = vm.createContext({ console, ...globals });
  vm.runInContext(stripTypeScriptTypes(source), ctx, { filename: file });
  return ctx;
}
class ObjectId {
  constructor(id = '000000000000000000000099') { this.id = String(id); if (!ObjectId.isValid(this.id)) throw Error('invalid ObjectId'); }
  toString() { return this.id; }
  static isValid(id) { return /^[a-f0-9]{24}$/.test(String(id)); }
}
const id = n => n.toString(16).padStart(24, '0');
const owner = id(1), foreign = id(2), resource = id(3), classId = id(4), school = id(5), cpId = id(6), tlId = id(7);
function match(doc, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => match(doc, q));
    if (value?.$in) return value.$in.some(v => String(v) === String(doc[key]));
    return String(value) === String(doc[key]);
  });
}
function database(seed = {}) {
  const state = { writes: 0, docs: structuredClone(seed) };
  const db = { state, collection(name) { const docs = state.docs[name] ||= []; return {
    findOne: async query => docs.find(d => match(d, query)) || null,
    find(query) { const values = docs.filter(d => match(d, query)); return { project() { return this; }, limit() { return this; }, toArray: async () => values }; },
    insertOne: async doc => { state.writes++; docs.push(doc); },
    updateOne: async (query, update) => { state.writes++; const d = docs.find(d => match(d, query)); if (d) Object.assign(d, update.$set); return { matchedCount: d ? 1 : 0 }; },
  }; } };
  return db;
}
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } }; }
function setup(db, schools = []) {
  const resourceApi = load('util/ci_resource.ts', { ObjectId, log() {}, mySchoolIds: async () => schools.map(s => new ObjectId(s)), activeGrantsReceived: async () => [], getSchoolRole: async () => null,
    normalizeClassPlanData: () => ({ fixed: 0 }), snapshotDoc: async () => { db.state.writes++; },
  });
  const handlers = new Map();
  const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, fn) => handlers.set(method + ' ' + url, fn)]));
  const globals = { ObjectId, log() {}, express: { Router: () => router }, scopeOf: resourceApi.scopeOf, validateResourceReferences: resourceApi.validateResourceReferences, getSchoolRole: async () => null };
  load('router/console/ci/class.ts', globals);
  const publicApi = load('util/ci_public.ts', globals);
  return { resourceApi, publicApi, handlers, globals };
}
async function callClass(api, db, method, body) {
  const res = response();
  await api.handlers.get(method + ' /v1/console/ci/class' + (method === 'put' ? '/:id' : ''))({ auth: { userId: owner }, params: { id: classId }, body, db }, res);
  return res;
}
const fields = { classplanId: 'ci_classplans', timelayoutId: 'ci_timelayouts', subjectsId: 'ci_subjects', settingsId: 'ci_settings', policyId: 'ci_policies' };
for (const [field, collection] of Object.entries(fields)) {
  test('create/update reject foreign ' + field + ' before writing', async () => {
    const db = database({ [collection]: [{ _id: resource, userId: foreign }], ci_classes: [{ _id: classId, userId: owner }] });
    const api = setup(db);
    for (const method of ['post', 'put']) {
      const res = await callClass(api, db, method, { name: 'my class', [field]: resource });
      assert.equal(res.statusCode, 403); assert.equal(db.state.writes, 0);
    }
  });
}
test('owned and school-shared resources can be associated; clearing is allowed', async () => {
  for (const extra of [{ userId: owner }, { userId: foreign, schoolId: school }]) {
    const db = database({ ci_subjects: [{ _id: resource, ...extra }], ci_classes: [{ _id: classId, userId: owner }] });
    const api = setup(db, [school]);
    assert.equal((await callClass(api, db, 'post', { name: 'class', subjectsId: resource })).statusCode, 200);
    assert.equal((await callClass(api, db, 'put', { subjectsId: null })).statusCode, 200);
  }
});
test('malformed and missing references are rejected without writes', async () => {
  const db = database(); const api = setup(db);
  assert.equal((await callClass(api, db, 'post', { name: 'class', subjectsId: 'bad-id' })).statusCode, 400);
  assert.equal((await callClass(api, db, 'post', { name: 'class', subjectsId: resource })).statusCode, 403);
  assert.equal(db.state.writes, 0);
});
test('indirect classplan references are checked when associating a class', async () => {
  const db = database({ ci_classplans: [{ _id: cpId, userId: owner, data: { subjectsId: resource } }], ci_subjects: [{ _id: resource, userId: foreign }] });
  const api = setup(db);
  assert.equal((await callClass(api, db, 'post', { name: 'class', classplanId: cpId })).statusCode, 403);
  assert.equal(db.state.writes, 0);
});
test('classplan CRUD and history restore reject unauthorized indirect references', async () => {
  const badData = { timelayoutId: tlId, subjectsId: resource };
  const db = database({ ci_classplans: [{ _id: cpId, userId: owner, version: 1, data: {} }], ci_subjects: [{ _id: resource, userId: foreign }], ci_timelayouts: [{ _id: tlId, userId: owner }], ci_history: [{ resourceCollection: 'ci_classplans', resourceId: cpId, version: 1, data: badData }] });
  const api = setup(db);
  for (const action of ['create', 'update', 'restore']) {
    const res = response();
    await api.resourceApi[action]({ auth: { userId: owner }, params: { id: cpId, version: '1' }, body: { name: 'plan', data: badData }, db }, res, 'ci_classplans');
    assert.equal(res.statusCode, 403, action); assert.equal(db.state.writes, 0, action);
  }
});
test('public resolution rejects legacy foreign refs by ObjectId and identity', async () => {
  const cls = { _id: classId, identity: 'room', userId: owner, subjectsId: resource };
  const db = database({ ci_classes: [cls], ci_subjects: [{ _id: resource, userId: foreign }] });
  const api = setup(db);
  assert.equal(await api.publicApi.findClass(db, classId), null);
  assert.equal(await api.publicApi.findClass(db, 'room'), null);
});
test('public resolution rejects nested foreign refs but retains missing-resource fallback', async () => {
  const cls = { _id: classId, userId: owner, classplanId: cpId };
  const db = database({ ci_classes: [cls], ci_classplans: [{ _id: cpId, userId: owner, data: { subjectsId: resource } }], ci_subjects: [{ _id: resource, userId: foreign }] });
  const api = setup(db);
  assert.equal(await api.publicApi.findClass(db, classId), null);
  db.state.docs.ci_subjects = [];
  assert.equal((await api.publicApi.findClass(db, classId))._id, classId);
});
test('active delegated resources retain visibility semantics', async () => {
  const db = database({ ci_subjects: [{ _id: resource, userId: foreign }] });
  const { resourceApi } = setup(db);
  const scope = { userId: new ObjectId(owner), schoolIds: [], grantResourceIds: [new ObjectId(resource)] };
  assert.equal((await resourceApi.validateResourceReferences(db, scope, { subjectsId: resource })).ok, true);
});
test('snapshot restore cannot reintroduce a foreign indirect reference', async () => {
  const db = database({ ci_classplans: [{ _id: cpId, userId: owner, version: 1 }], ci_subjects: [{ _id: resource, userId: foreign }] });
  const api = setup(db);
  load('router/console/ci/snapshots.ts', { ...api.globals, visibleFilter: api.resourceApi.visibleFilter, canWrite: api.resourceApi.canWrite,
    getSnapshot: async () => ({ collection: 'ci_classplans', resourceId: cpId, userId: owner, data: { subjectsId: resource } }),
    snapshotDoc: async () => { db.state.writes++; },
  });
  const res = response();
  await api.handlers.get('post /v1/console/ci/classplan/:id/snapshots/:snapshotId/restore')({ db, auth: { userId: owner }, params: { id: cpId, snapshotId: id(9) } }, res);
  assert.equal(res.statusCode, 403); assert.equal(db.state.writes, 0);
});
