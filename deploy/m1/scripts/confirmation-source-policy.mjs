// Source evidence supplements, and never replaces, the real Compose render/probes.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import yaml from './vendor/yaml-2.9.0.cjs';

const { parseAllDocuments, isAlias, isMap, isSeq, isPair, isScalar } = yaml;
const target = '/var/lib/bondbuddy/upload-confirmation';
const reject = () => { throw new Error('invalid confirmation source policy'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const overrideTags = ['map', 'seq'].map(collection => ({
  tag: '!override', collection, resolve: value => value,
}));
const coreTags = new Set(['map', 'seq', 'str', 'null', 'bool', 'int', 'float', 'merge'].map(name => `tag:yaml.org,2002:${name}`));

function parseSource(bytes) {
  if (!bytes.length || bytes.length > 1024 * 1024) reject();
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const docs = parseAllDocuments(source, {
    version: '1.2', schema: 'core', merge: true, uniqueKeys: true,
    strict: true, resolveKnownTags: false, customTags: overrideTags,
  });
  if (docs.length !== 1) reject();
  const doc = docs[0];
  if (doc.errors.length || doc.warnings.length || doc.directives.yaml.version !== '1.2' || !isMap(doc.contents)) reject();
  // Keep the AST and its tags. Only Compose's collection replacement is known;
  // no custom scalar coercion, include expansion or user-defined tag handler runs.
  // Alias-count limits alone do not reject cycles, so inspect the actual graph too.
  let visits = 0;
  const stack = new Set();
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object') return;
    if (++visits > 50000 || depth > 100 || stack.has(node)) reject();
    stack.add(node);
    if (node.tag && !coreTags.has(node.tag) && !(node.tag === '!override' && (isMap(node) || isSeq(node)))) reject();
    if (isAlias(node)) {
      const sourceNode = node.resolve(doc);
      if (!sourceNode) reject();
      visit(sourceNode, depth + 1);
    } else if (isPair(node)) {
      visit(node.key, depth + 1); visit(node.value, depth + 1);
    } else if (isMap(node)) {
      // YAML merge keys use separate Symbol('<<') values, and alias keys can
      // resolve only during toJS. Neither may bypass source-level uniqueness.
      const keys = new Set();
      for (const item of node.items) {
        if (!isPair(item) || !isScalar(item.key)) reject();
        const value = item.key.value;
        const key = typeof value === 'string' ? value : typeof value === 'symbol' && value.description === '<<' ? '<<' : null;
        if (key === null || keys.has(key)) reject();
        keys.add(key); visit(item, depth + 1);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) visit(item, depth + 1);
    }
    stack.delete(node);
  }
  visit(doc.contents);
  const result = doc.toJS({ mapAsMap: true, maxAliasCount: 100 });
  visits = 0;
  function inspect(value, depth = 0) {
    if (++visits > 50000 || depth > 100) reject();
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || stack.has(value)) reject();
    stack.add(value);
    if (value instanceof Map) {
      for (const [key, child] of value) { if (typeof key !== 'string') reject(); inspect(child, depth + 1); }
    } else if (Array.isArray(value)) {
      for (const child of value) inspect(child, depth + 1);
    } else reject();
    stack.delete(value);
  }
  inspect(result);
  return result;
}

function inspectPolicy(document, required) {
  if (!(document instanceof Map) || document.has('include')) reject();
  const services = document.get('services');
  if (services === undefined && !required) return;
  if (!(services instanceof Map)) reject();
  const service = services.get('upload-confirmation');
  if (service === undefined && !required) return;
  if (!(service instanceof Map) || service.has('extends') || service.has('volumes_from')) reject();
  // No Compose merge is emulated here. An untouched service/volumes entry inherits
  // the checked fixed base. Any authored entry must itself contain explicit false,
  // even when an empty bind map would render like false on this Compose version.
  if (!service.has('volumes') && !required) return;
  const volumes = service.get('volumes');
  if (!Array.isArray(volumes) || volumes.length !== 1) reject();
  const volume = volumes[0];
  if (!(volume instanceof Map) || volume.get('type') !== 'bind' || volume.get('target') !== target ||
      typeof volume.get('source') !== 'string' || !volume.get('source')) reject();
  const bind = volume.get('bind');
  if (!(bind instanceof Map) || !bind.has('create_host_path') || bind.get('create_host_path') !== false) reject();
}

// Only role-config supplies these paths: the checked-in execution and selected
// integrity sources, followed by the already protected private override identity.
// Return a final identity check to run after consuming all render/probe streams,
// before any environment binding can be adopted.
export function validateConfirmationSources({ directory, integrityMode, overrideFile = '', overrideSha256 = '' }) {
  if (!['beijing', 'direct', 'disabled'].includes(integrityMode) || Boolean(overrideFile) !== Boolean(overrideSha256)) reject();
  if (overrideFile && !/^[a-f0-9]{64}$/.test(overrideSha256)) reject();
  const paths = [join(directory, 'compose.execution.yaml')];
  if (integrityMode !== 'disabled') paths.push(join(directory, integrityMode === 'beijing' ? 'compose.integrity-beijing.yaml' : 'compose.integrity-browser.yaml'));
  if (overrideFile) paths.push(overrideFile);
  const snapshots = paths.map((path, index) => {
    const realpath = realpathSync(path), bytes = readFileSync(path), sha256 = digest(bytes);
    if (overrideFile && index === paths.length - 1 && sha256 !== overrideSha256) reject();
    inspectPolicy(parseSource(bytes), index === 0);
    return { path, realpath, sha256 };
  });
  return () => {
    for (const source of snapshots) {
      if (realpathSync(source.path) !== source.realpath || digest(readFileSync(source.path)) !== source.sha256) reject();
    }
  };
}
