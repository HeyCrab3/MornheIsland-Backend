// Node >= 22.13: node --test tests/*.test.mjs
// Execute production source; replace only framework hooks and external services.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = process.env.AUDIT_SOURCE_ROOT || path.resolve(import.meta.dirname, '..');
function load(file, globals = {}, expose = '') {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  if (file.endsWith('.vue')) source = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  source = source.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export default .*;\s*$/gm, '').replace(/^export /gm, '');
  const ctx = vm.createContext({ console, ...globals });
  vm.runInContext(stripTypeScriptTypes(source) + '\n' + expose, ctx, { filename: file });
  return ctx;
}
const ref = value => ({ value });
const base = { ref, reactive: x => x, computed: f => ({ get value() { return f(); } }), onMounted() {}, onUnmounted() {}, watch() {}, ElMessage: { warning() {}, success() {}, error() {} } };
const plain = value => JSON.parse(JSON.stringify(value));

class ObjectId { constructor(id) { this.id = String(id ?? 'generated'); } toString() { return this.id; } static isValid(value) { return /^[a-f0-9]{24}$/.test(String(value)); } }
function response() { return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } }; }
function routes(extra = {}) {
  const handlers = new Map();
  const router = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, fn) => handlers.set(method + ' ' + url, fn)]));
  return { handlers, globals: { ObjectId, log() {}, express: { Router: () => router }, ...extra } };
}

async function removeSubject(linked) {
  let deleted = false, snapshots = 0;
  const id = '000000000000000000000001';
  const doc = { _id: new ObjectId(id), userId: new ObjectId('owner'), version: 1 };
  const ctx = load('util/ci_resource.ts', { ObjectId, log() {}, mySchoolIds: async () => [], activeGrantsReceived: async () => [], snapshotDoc: async () => snapshots++ });
  const db = { collection(name) { return { findOne: async () => doc,
    find(query) { if (name === 'ci_classplans') assert.deepEqual(plain(query), { 'data.subjectsId': id });
      return { project: () => ({ toArray: async () => name === 'ci_classplans' && linked ? [{ name: 'linked plan' }] : [] }) }; },
    deleteOne: async () => { deleted = true; },
  }; } };
  const res = response(); await ctx.remove({ auth: { userId: 'owner' }, params: { id }, db }, res, 'ci_subjects');
  return { res, deleted, snapshots };
}
test('a classplan-only reference prevents deletion and snapshot writes', async () => {
  const r = await removeSubject(true); assert.equal(r.res.statusCode, 409); assert.equal(r.deleted, false); assert.equal(r.snapshots, 0);
  assert.match(r.res.body.msg, /linked plan/);
});
test('unreferenced subjects remain deletable with a pre-delete snapshot', async () => {
  const r = await removeSubject(false); assert.equal(r.res.statusCode, 200); assert.equal(r.deleted, true); assert.equal(r.snapshots, 1);
});
