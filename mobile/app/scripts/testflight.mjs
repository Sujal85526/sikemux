// Answers a TestFlight build's export compliance questions, so it does not wait at "Missing
// Compliance": the app uses standard encryption it brings itself (TLS and QUIC from rustls), none
// of it proprietary, and is not sold in France. Every build is assigned to the one declaration
// that says so, made the first time.
//
//   node scripts/testflight.mjs compliance 10007
//
// Signs in with the App Store Connect API key in APP_STORE_CONNECT_KEY (or the file at
// APP_STORE_CONNECT_KEY_PATH), with APP_STORE_CONNECT_KEY_ID and APP_STORE_CONNECT_ISSUER_ID.
import { Buffer } from 'node:buffer';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BUNDLE_ID = 'com.nodelike.sikemux.mobile';
const API = 'https://api.appstoreconnect.apple.com';
/** Apple takes a few minutes to list an upload, and up to half an hour to process it. */
const WAIT_MS = 45 * 60_000;
const POLL_MS = 30_000;

export const DECLARATION = {
  appDescription:
    'Sikemux connects to the person’s own computer over TLS 1.3 and QUIC, using the rustls library with the ring cryptography provider, and opens notifications sealed with AES-GCM. It uses only standard algorithms and no proprietary cryptography.',
  containsProprietaryCryptography: false,
  containsThirdPartyCryptography: true,
  availableOnFrenchStore: false,
};

const USABLE = new Set(['CREATED', 'IN_REVIEW', 'APPROVED']);

/** A declaration that says what this app's does, and that Apple has not turned down. */
export function matches(declaration) {
  const said = declaration.attributes;
  return (
    USABLE.has(said.appEncryptionDeclarationState) &&
    said.containsProprietaryCryptography === DECLARATION.containsProprietaryCryptography &&
    said.containsThirdPartyCryptography === DECLARATION.containsThirdPartyCryptography &&
    said.availableOnFrenchStore === DECLARATION.availableOnFrenchStore
  );
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

/** The ES256 token App Store Connect takes, good for 20 minutes, its limit. */
export function token({ key, keyId, issuerId }, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1' }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

function credentials(env = process.env) {
  const key = env.APP_STORE_CONNECT_KEY || (env.APP_STORE_CONNECT_KEY_PATH && readFileSync(env.APP_STORE_CONNECT_KEY_PATH, 'utf8'));
  const keyId = env.APP_STORE_CONNECT_KEY_ID;
  const issuerId = env.APP_STORE_CONNECT_ISSUER_ID;
  if (!key || !keyId || !issuerId)
    throw new Error('Set APP_STORE_CONNECT_KEY (or APP_STORE_CONNECT_KEY_PATH), APP_STORE_CONNECT_KEY_ID and APP_STORE_CONNECT_ISSUER_ID');
  return { key, keyId, issuerId };
}

async function call(auth, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token(auth)}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`App Store Connect answered ${response.status} to ${method} ${path}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function waitForBuild(auth, appId, buildNumber) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { data } = await call(auth, 'GET', `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&limit=1`);
    const build = data[0];
    if (build?.attributes.processingState === 'VALID') return build;
    if (build && ['FAILED', 'INVALID'].includes(build.attributes.processingState))
      throw new Error(`Apple could not process build ${buildNumber}: ${build.attributes.processingState}`);
    if (Date.now() > deadline) throw new Error(`Build ${buildNumber} was not processed within ${WAIT_MS / 60_000} minutes`);
    console.log(
      build ? `Build ${buildNumber} is ${build.attributes.processingState.toLowerCase()}` : `Waiting for build ${buildNumber} to appear`,
    );
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

async function compliance(buildNumber) {
  const auth = credentials();
  const { data: apps } = await call(auth, 'GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&limit=1`);
  if (!apps.length) throw new Error(`No app in App Store Connect has the bundle id ${BUNDLE_ID}`);
  const appId = apps[0].id;
  const build = await waitForBuild(auth, appId, buildNumber);
  const current = await call(auth, 'GET', `/v1/builds/${build.id}/appEncryptionDeclaration`);
  if (current.data) {
    console.log(`Build ${buildNumber} already has its export compliance answered`);
    return;
  }
  const { data: declarations } = await call(auth, 'GET', `/v1/appEncryptionDeclarations?filter[app]=${appId}&limit=200`);
  let declaration = declarations.find(matches);
  if (!declaration) {
    ({ data: declaration } = await call(auth, 'POST', '/v1/appEncryptionDeclarations', {
      data: {
        type: 'appEncryptionDeclarations',
        attributes: DECLARATION,
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    }));
    console.log(`Made the app's export compliance declaration ${declaration.id}`);
  }
  await call(auth, 'POST', `/v1/appEncryptionDeclarations/${declaration.id}/relationships/builds`, {
    data: [{ type: 'builds', id: build.id }],
  });
  console.log(`Build ${buildNumber} is assigned to export compliance declaration ${declaration.id}`);
}

const [command, argument] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (command === 'compliance' && argument) {
    compliance(argument).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  } else {
    console.error('usage: node scripts/testflight.mjs compliance <build number>');
    process.exit(2);
  }
}
