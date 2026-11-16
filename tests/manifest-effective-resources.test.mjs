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

async function manifest(cls, docs) {
  const r = routes({ findClass: async () => cls });
  load('router/ci/manifest.ts', r.globals);
  const res = response();
  await r.handlers.get('get /v1/ci/:classIdentity/manifest.json')({ params: { classIdentity: 'class' }, protocol: 'https', get: () => 'local.test', db: { collection: () => ({ findOne: async q => docs[String(q._id)] }) } }, res);
  assert.equal(res.statusCode, 200); return res.body;
}
test('manifest tracks the same course-owned resources as the download routes', async () => {
  const cls = { _id: 'class', classplanId: 'cp', timelayoutId: 'oldTL', subjectsId: 'oldSJ' };
  const docs = { cp: { version: 1, data: { timelayoutId: 'newTL', subjectsId: 'newSJ' } }, oldTL: { version: 2 }, oldSJ: { version: 3 }, newTL: { version: 10 }, newSJ: { version: 11 } };
  const result = await manifest(cls, docs);
  assert.equal(result.TimeLayoutSource.Version, 10); assert.equal(result.SubjectsSource.Version, 11);
  docs.newSJ.version++; assert.equal((await manifest(cls, docs)).SubjectsSource.Version, 12);
  delete cls.timelayoutId; delete cls.subjectsId;
  assert.ok((await manifest(cls, docs)).SubjectsSource.Value);
  assert.ok((await manifest(cls, docs)).TimeLayoutSource.Value);
});
test('legacy references and missing preferred subjects match existing fallback semantics', async () => {
  const cls = { _id: 'class', classplanId: 'cp', timelayoutId: 'tl', subjectsId: 'sj' };
  const docs = { cp: { version: 1, data: {} }, tl: { version: 2 }, sj: { version: 3 } };
  assert.equal((await manifest(cls, docs)).TimeLayoutSource.Version, 2);
  docs.cp.data.subjectsId = 'deleted';
  assert.equal((await manifest(cls, docs)).SubjectsSource.Version, 3);
  delete cls.subjectsId; assert.equal((await manifest(cls, docs)).SubjectsSource.Value, null);
});
