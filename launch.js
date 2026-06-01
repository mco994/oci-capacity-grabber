const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const CFG = {
  region:       'eu-marseille-1',
  tenancy:      'ocid1.tenancy.oc1..aaaaaaaaudgb2rry4yqmybhlqzpzn7wqsb7auxyidjl2x3zubumkydf3widq',
  user:         'ocid1.user.oc1..aaaaaaaarkpbwlqhrfvzi4bnufynkxckxcpvl3t45bbg2iqnexpd37rx5jma',
  fingerprint:  '5d:64:e2:62:73:ad:4c:48:01:97:00:fa:d1:13:16:76',
  availabilityDomain: 'QqsV:EU-MARSEILLE-1-AD-1',
  subnetId:     'ocid1.subnet.oc1.eu-marseille-1.aaaaaaaaxi2kvzkpacr2534cr7jqazameuies2dojhhhugeuntwizqig7aya',
  imageId:      'ocid1.image.oc1.eu-marseille-1.aaaaaaaafma24hdplplovw2mtxxpge5q5gwxilt5go3nbjefvsn4dd2scq7q',
  shape:        'VM.Standard.A1.Flex',
  ocpus:        4,
  memoryInGBs:  24,
  bootVolumeSizeInGBs: 200,
  displayName:  'claude-dev',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE72Q+wrL9iEinFF0MBH7HzFTDwtXpQDBqLvXGGmABLr pc1-marin-oracle',
};

const MAX_RUN_MINUTES = Number(process.env.MAX_RUN_MINUTES || 50);
const RETRY_INTERVAL_MS = Number(process.env.RETRY_INTERVAL_MS || 30_000);

const KEY = fs.readFileSync(process.env.OCI_KEY_FILE || './oci_api_key.pem', 'utf8');
const keyId = `${CFG.tenancy}/${CFG.user}/${CFG.fingerprint}`;
const IAAS = `iaas.${CFG.region}.oraclecloud.com`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ociRequest(method, host, pathWithQuery, bodyObj) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    let headersToSign = `date: ${date}\n(request-target): ${method.toLowerCase()} ${pathWithQuery}\nhost: ${host}`;
    const outHeaders = { date, host, accept: 'application/json' };
    let signedList = 'date (request-target) host';

    if (method === 'POST' || method === 'PUT') {
      const sha = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
      const len = Buffer.byteLength(body, 'utf8');
      headersToSign += `\ncontent-length: ${len}\ncontent-type: application/json\nx-content-sha256: ${sha}`;
      signedList += ' content-length content-type x-content-sha256';
      outHeaders['content-length'] = len;
      outHeaders['content-type'] = 'application/json';
      outHeaders['x-content-sha256'] = sha;
    }
    const sig = crypto.createSign('RSA-SHA256').update(headersToSign).sign(KEY, 'base64');
    outHeaders['authorization'] =
      `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${signedList}",signature="${sig}"`;

    const req = https.request({ method, host, path: pathWithQuery, headers: outHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function attempt() {
  const list = await ociRequest('GET', IAAS,
    `/20160918/instances?compartmentId=${CFG.tenancy}&displayName=${encodeURIComponent(CFG.displayName)}`);
  if (list.status === 200) {
    const live = JSON.parse(list.body).filter(i => !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState));
    if (live.length > 0) {
      console.log(`Instance "${CFG.displayName}" already exists (${live[0].lifecycleState}). Nothing to do.`);
      return 'exists';
    }
  } else {
    console.error(`List instances failed: HTTP ${list.status}: ${list.body}`);
    return 'error';
  }

  const payload = {
    compartmentId: CFG.tenancy,
    availabilityDomain: CFG.availabilityDomain,
    displayName: CFG.displayName,
    shape: CFG.shape,
    shapeConfig: { ocpus: CFG.ocpus, memoryInGBs: CFG.memoryInGBs },
    sourceDetails: { sourceType: 'image', imageId: CFG.imageId, bootVolumeSizeInGBs: CFG.bootVolumeSizeInGBs },
    createVnicDetails: { subnetId: CFG.subnetId, assignPublicIp: true },
    metadata: { ssh_authorized_keys: CFG.sshPublicKey },
  };
  const res = await ociRequest('POST', IAAS, '/20160918/instances', payload);

  if (res.status >= 200 && res.status < 300) {
    const inst = JSON.parse(res.body);
    console.log('============================================================');
    console.log('  SUCCESS — INSTANCE CREATED! 🎉');
    console.log('  OCID: ' + inst.id);
    console.log('  Check the OCI console for the public IP. Then DISABLE this workflow.');
    console.log('============================================================');
    return 'created';
  }

  if (res.status === 429) {
    console.log(`Rate-limited (HTTP 429). Backing off.`);
    return 'ratelimit';
  }

  if (/capacity/i.test(res.body)) {
    console.log(`Still no capacity (HTTP ${res.status}).`);
    return 'nocap';
  }

  console.error(`Unexpected launch response: HTTP ${res.status}: ${res.body}`);
  return 'error';
}

(async () => {
  const deadline = Date.now() + MAX_RUN_MINUTES * 60_000;
  let n = 0;
  while (true) {
    n++;
    let outcome;
    try {
      outcome = await attempt();
    } catch (e) {
      console.error(`Attempt ${n} threw: ${e.message}`);
      outcome = 'nocap';
    }

    if (outcome === 'created' || outcome === 'error') process.exit(1);
    if (outcome === 'exists') process.exit(0);

    const wait = outcome === 'ratelimit' ? RETRY_INTERVAL_MS * 3 : RETRY_INTERVAL_MS;
    if (Date.now() + wait >= deadline) {
      console.log(`Time budget exhausted after ${n} attempt(s); still no capacity. Next cron will retry.`);
      process.exit(0);
    }
    await sleep(wait);
  }
})();
