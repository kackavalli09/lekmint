import assert from 'node:assert/strict';
import test from 'node:test';
import { generateRedirects, getConfiguration, validateOrigin } from './build.mjs';

const env = {
  START9_API_ORIGIN: 'https://upstream.example.invalid',
  PUBLIC_CANONICAL_ORIGIN: 'https://wallet.example.invalid',
};

test('requires both explicit origins, with no inferred public domain', () => {
  assert.throws(() => getConfiguration({}), /START9_API_ORIGIN/);
  assert.throws(() => getConfiguration({ START9_API_ORIGIN: env.START9_API_ORIGIN }), /PUBLIC_CANONICAL_ORIGIN/);
  assert.deepEqual(getConfiguration(env), {
    upstream: env.START9_API_ORIGIN, canonical: env.PUBLIC_CANONICAL_ORIGIN,
  });
});

test('strict HTTPS origin validation prevents credentials and redirect injection', () => {
  for (const value of [
    undefined, '', 'http://api.example.invalid', 'https://user:pass@api.example.invalid',
    'https://api.example.invalid/api', 'https://api.example.invalid/?q=1',
    'https://api.example.invalid?', 'https://api.example.invalid#',
    'https://api.example.invalid/#x', 'https://api.example.invalid/a/..',
    ' https://api.example.invalid', 'https://api.example.invalid\n/* /index.html 200',
    'https://api.example.invalid\\', 'https://',
  ]) {
    assert.throws(() => validateOrigin(value, 'ORIGIN'), /ORIGIN/);
  }
  assert.equal(validateOrigin('https://API.example.invalid:443/', 'ORIGIN'), 'https://api.example.invalid');
  assert.equal(validateOrigin('https://api.example.invalid:8443', 'ORIGIN'), 'https://api.example.invalid:8443');
});

test('rejects canonical and Netlify deploy URL proxy loops after normalization', () => {
  assert.throws(() => getConfiguration({ ...env, START9_API_ORIGIN: 'https://WALLET.example.invalid:443/' }), /recursion/);
  for (const key of ['URL', 'DEPLOY_URL', 'DEPLOY_PRIME_URL']) {
    assert.throws(() => getConfiguration({ ...env, [key]: `${env.START9_API_ORIGIN}/` }), /recursion/);
  }
});

test('ordered routing isolates all API failures, exact paths and admin assets from wallet SPA', () => {
  const lines = generateRedirects(getConfiguration(env)).trim().split('\n');
  assert.deepEqual(lines, [
    `/api ${env.START9_API_ORIGIN}/api 200!`,
    `/api/* ${env.START9_API_ORIGIN}/api/:splat 200!`,
    '/admin /admin/ 301!',
    '/admin/* /admin/index.html 200',
    '/__mockup /netlify-not-found.html 404!',
    '/__mockup/* /netlify-not-found.html 404!',
    '/* /index.html 200',
  ]);
  assert.equal(lines.some((line) => /\/api.*\/index\.html/.test(line)), false);
  assert.equal(lines[3].endsWith('!'), false, 'existing admin static files must be served, not rewritten');
});