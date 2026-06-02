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
  shape:        'VM.Standard.E2.1.Micro',
  bootVolumeSizeInGBs: 50,
  displayName:  'claude-grabber',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE72Q+wrL9iEinFF0MBH7HzFTDwtXpQDBqLvXGGmABLr pc1-marin-oracle',
};

const KEY = fs.readFileSync(process.env.OCI_KEY_FILE || 'C:\\Users\\marin\\.oci\\oci_api_key.pem', 'utf8');
const keyId = `${CFG.tenancy}/${CFG.user}/${CFG.fingerprint}`;
const IAAS = `iaas.${CFG.region}.oraclecloud.com`;

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

async function latestX86Image() {
  const path = `/20160918/images?compartmentId=${CFG.tenancy}` +
    `&operatingSystem=${encodeURIComponent('Canonical Ubuntu')}` +
    `&operatingSystemVersion=24.04&shape=${encodeURIComponent(CFG.shape)}` +
    `&lifecycleState=AVAILABLE&sortBy=TIMECREATED&sortOrder=DESC&limit=5`;
  const res = await ociRequest('GET', IAAS, path);
  if (res.status !== 200) throw new Error(`List images failed: HTTP ${res.status}: ${res.body}`);
  const imgs = JSON.parse(res.body);
  if (!imgs.length) throw new Error('No x86 Ubuntu 24.04 image found for E2.1.Micro');
  return imgs[0];
}

(async () => {
  const list = await ociRequest('GET', IAAS,
    `/20160918/instances?compartmentId=${CFG.tenancy}&displayName=${encodeURIComponent(CFG.displayName)}`);
  if (list.status === 200) {
    const live = JSON.parse(list.body).filter(i => !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState));
    if (live.length > 0) {
      console.log(`Instance "${CFG.displayName}" already exists (${live[0].lifecycleState}). OCID: ${live[0].id}`);
      process.exit(0);
    }
  }

  const img = await latestX86Image();
  console.log(`Using image: ${img.displayName}\n  ${img.id}`);

  const payload = {
    compartmentId: CFG.tenancy,
    availabilityDomain: CFG.availabilityDomain,
    displayName: CFG.displayName,
    shape: CFG.shape,
    sourceDetails: { sourceType: 'image', imageId: img.id, bootVolumeSizeInGBs: CFG.bootVolumeSizeInGBs },
    createVnicDetails: { subnetId: CFG.subnetId, assignPublicIp: true },
    metadata: { ssh_authorized_keys: CFG.sshPublicKey },
  };
  const res = await ociRequest('POST', IAAS, '/20160918/instances', payload);

  if (res.status >= 200 && res.status < 300) {
    const inst = JSON.parse(res.body);
    console.log('============================================================');
    console.log('  SUCCESS — E2.1.Micro CREATED!');
    console.log('  OCID: ' + inst.id);
    console.log('  IP publique: voir la console OCI dans ~1 min.');
    console.log('============================================================');
    process.exit(0);
  }

  if (/capacity/i.test(res.body)) {
    console.log(`Out of capacity for E2.1.Micro (HTTP ${res.status}). Réessayer plus tard.`);
    process.exit(2);
  }
  console.error(`Launch failed: HTTP ${res.status}: ${res.body}`);
  process.exit(1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
