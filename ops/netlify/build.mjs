import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'ops/netlify/dist');

export function validateOrigin(value, name) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${name} must be an explicitly configured HTTPS origin.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`);
  }
  // Validate the spelling as well as URL's normalized pathname: URL otherwise
  // accepts dot-segments, empty query/hash delimiters, and escaped whitespace.
  if (
    url.protocol !== 'https:' || !url.hostname ||
    url.username || url.password || url.search || url.hash ||
    !/^https:\/\/[^/?#\s\\]+\/?$/.test(value) ||
    url.pathname !== '/'
  ) {
    throw new Error(`${name} must use HTTPS, with no credentials, path, query, or fragment.`);
  }
  return url.origin;
}

export function getConfiguration(env) {
  const upstream = validateOrigin(env.START9_API_ORIGIN, 'START9_API_ORIGIN');
  const canonical = validateOrigin(env.PUBLIC_CANONICAL_ORIGIN, 'PUBLIC_CANONICAL_ORIGIN');
  if (upstream === canonical) {
    throw new Error('START9_API_ORIGIN must differ from PUBLIC_CANONICAL_ORIGIN (proxy recursion).');
  }
  // Netlify's current deploy/site URLs must not loop back either. Aliases and
  // DNS ownership still require an operator review; string comparison cannot
  // detect an upstream hostname that resolves to this same Netlify site.
  for (const key of ['URL', 'DEPLOY_URL', 'DEPLOY_PRIME_URL']) {
    if (env[key] && validateOrigin(env[key], key) === upstream) {
      throw new Error(`START9_API_ORIGIN must differ from ${key} (proxy recursion).`);
    }
  }
  return { upstream, canonical };
}

export function generateRedirects({ upstream }) {
  // The force flag prevents a future static file under /api from shadowing the
  // proxy. These are rewrites, not redirects: failures stay upstream failures.
  return [
    `/api ${upstream}/api 200!`,
    `/api/* ${upstream}/api/:splat 200!`,
    '/admin /admin/ 301!',
    '/admin/* /admin/index.html 200',
    '/__mockup /netlify-not-found.html 404!',
    '/__mockup/* /netlify-not-found.html 404!',
    '/* /index.html 200',
    '',
  ].join('\n');
}

export async function build(env = process.env) {
  const config = getConfiguration(env); // Fail before building or publishing anything.
  for (const [name, base, port] of [
    ['lek-mint', '/', '3100'],
    ['admin-dashboard', '/admin/', '3101'],
  ]) {
    const result = spawnSync('pnpm', ['--filter', `@workspace/${name}`, 'run', 'build'], {
      cwd: root,
      stdio: 'inherit',
      // Override only these child builds. Replit's env, configs, and scripts
      // remain unchanged; no backend or preview sandbox is built.
      env: { ...env, NODE_ENV: 'production', PORT: port, BASE_PATH: base },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${name} build failed (${result.status}).`);
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(path.join(root, 'artifacts/lek-mint/dist/public'), output, { recursive: true });
  await cp(path.join(root, 'artifacts/admin-dashboard/dist/public'), path.join(output, 'admin'), { recursive: true });
  await writeFile(path.join(output, '_redirects'), generateRedirects(config));
  await writeFile(path.join(output, 'netlify-not-found.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><h1>Not found</h1></html>\n');
  console.info('Static wallet + admin prepared in ops/netlify/dist. No backend or deployment performed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((error) => {
    console.error(`Netlify preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}