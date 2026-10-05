'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

test('API route modules cannot open tenant database clients directly', () => {
  const routeDirectory = path.join(root, 'routes');
  const routeFiles = fs.readdirSync(routeDirectory).filter(file => file.endsWith('.js') && file !== 'public-pages.js');
  const directClientPattern = /(?:require\s*\(\s*['"](?:@libsql\/client|better-sqlite3|sqlite3|libsql)['"]\s*\)|\bcreateClient\s*\(|\bnew\s+(?:Database|sqlite3\.Database)\b)/;
  const tenantEscapeHatchPattern = /\b(?:getTenantClient|runForEachTenant)\s*\(/;

  for (const file of routeFiles) {
    const source = fs.readFileSync(path.join(routeDirectory, file), 'utf8');
    assert.doesNotMatch(source, directClientPattern, `${file} must use the tenant-bound database module`);
    assert.doesNotMatch(source, tenantEscapeHatchPattern, `${file} must not bypass the active company context`);
    if (!['superadmin.js', 'public.js', 'billing.js'].includes(file)) {
      assert.match(source, /require\(['"]\.\.\/db['"]\)/, `${file} must use the tenant-bound database module`);
    }
  }
});

test('tenant context middleware is installed before every API router', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const contextPosition = server.indexOf('app.use(createCompanyContextMiddleware');
  const apiMounts = [...server.matchAll(/app\.use\(['"]\/api(?:\/[^'"]*)?['"]/g)];

  assert.notEqual(contextPosition, -1);
  assert.ok(apiMounts.length > 0);
  for (const mount of apiMounts) assert.ok(mount.index > contextPosition, `${mount[0]} must follow tenant context middleware`);
  assert.match(server, /req\.path === '\/api\/public\/demo-requests'/);
});

test('scheduled maintenance never invokes automatic company deletion', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.doesNotMatch(server, /processDueCompanyDeletions\s*\(/);
});

test('environment template contains placeholders only for secret values', () => {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const ignoreRules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

  for (const line of template.split(/\r?\n/)) {
    const assignment = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment || !/(?:TOKEN|SECRET|PASSWORD|KEY)$/.test(assignment[1])) continue;
    const value = assignment[2].trim();
    assert.ok(!value || /^(?:your-|replace-with-|generate-|<)/i.test(value), `${assignment[1]} must not contain a live value`);
  }
  assert.match(ignoreRules, /^\.env$/m);
  assert.match(ignoreRules, /^\.env\.\*$/m);
  assert.match(ignoreRules, /^!\.env\.example$/m);
});