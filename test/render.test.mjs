import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, globToRegExp, needsOwnerMatches, parseConfig, shipBranch } from '../lib/config.mjs';
import { addMissingConfigKeys, render, renderConfig } from '../lib/render.mjs';
import { parseYaml } from '../lib/yaml.mjs';

test('render fills {{names}}, leaves GitHub expressions alone, and refuses unknown names', () => {
  assert.equal(render('a {{x}} ${{ github.ref }} ${{github.sha}}', { x: 1 }), 'a 1 ${{ github.ref }} ${{github.sha}}');
  assert.throws(() => render('{{missing}}', {}), /missing/);
});

test('the config template renders every key and reads back as the same settings', () => {
  const config = {
    ...DEFAULTS,
    shipTarget: 'staging',
    branches: { production: 'main', staging: 'staging' },
    checkCommand: 'node scripts/check-before-push.mjs --hook',
    queueCheckCommand: 'pnpm lint && pnpm test',
    generated: [{ run: 'node scripts/generate-api-reference.mjs' }],
    deployWorkflows: ['deploy-web.yml', 'deploy-backend.yml'],
    liveUrl: 'https://staging.example.com',
    mergeMethod: 'merge',
    ciCheck: 'Lint + Typecheck + Build',
  };
  const text = renderConfig(config);
  assert.deepEqual(parseConfig(text), JSON.parse(JSON.stringify(config)));
  const back = parseConfig(text);
  assert.equal(shipBranch(back), 'staging');
  assert.deepEqual(back.deployWorkflows, ['deploy-web.yml', 'deploy-backend.yml']);
  assert.deepEqual(back.generated, [{ run: 'node scripts/generate-api-reference.mjs' }]);
  assert.equal(back.queueCheckCommand, 'pnpm lint && pnpm test');
  assert.equal(parseConfig(renderConfig(DEFAULTS)).queueCheckCommand, null);
  assert.equal(back.mergeMethod, 'merge');
  assert.equal(back.ciCheck, 'Lint + Typecheck + Build');
  for (const key of ['shipTarget', 'branches', 'needsOwner', 'checkCommand', 'queueCheckCommand', 'deployWorkflows', 'liveUrl', 'mergeMethod']) assert.ok(key in parseYaml(text), key);
});

test('config validation', () => {
  assert.throws(() => parseConfig('shipTarget: prod\n'), /production or staging/);
  assert.throws(() => parseConfig('mergeMethod: fast\n'), /mergeMethod/);
  assert.throws(() => parseConfig('queueCheckCommand: [a, b]\n'), /queueCheckCommand must be a command/);
  assert.throws(() => shipBranch(parseConfig('shipTarget: staging\nbranches:\n  staging: null\n')), /branches.staging is not set/);
});

test('addMissingConfigKeys appends missing settings and keeps the user\'s text byte for byte', () => {
  const existing = '# mine\nshipTarget: production\n\nbranches:\n  production: main   # deploys\n  staging: null\n';
  const { text, added } = addMissingConfigKeys(existing);
  assert.ok(text.startsWith(existing));
  assert.ok(added.includes('needsOwner') && added.includes('deployWorkflows') && !added.includes('branches') && !added.includes('shipTarget'));
  assert.equal(parseConfig(text).branches.production, 'main');
  assert.deepEqual(addMissingConfigKeys(text).added, []);
  const crlf = addMissingConfigKeys(existing.replace(/\n/g, '\r\n')).text;
  assert.ok(!/[^\r]\n/.test(crlf), 'a CRLF config stays CRLF');
});

test('needsOwner globs', () => {
  assert.ok(globToRegExp('.github/**').test('.github/workflows/ci.yml'));
  assert.ok(!globToRegExp('.github/**').test('src/.github'));
  assert.ok(globToRegExp('*.sql').test('db/migrations/1.sql'));
  assert.ok(globToRegExp('AGENTS.md').test('AGENTS.md'));
  assert.ok(globToRegExp('apps/*/migrations/**').test('apps/web/migrations/x/1.sql'));
  assert.deepEqual(needsOwnerMatches(parseConfig(null), ['src/a.ts', '.mergify.yml', 'AGENTS.md']), ['.mergify.yml', 'AGENTS.md']);
});
