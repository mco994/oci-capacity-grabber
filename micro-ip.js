const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const TENANCY = 'ocid1.tenancy.oc1..aaaaaaaaudgb2rry4yqmybhlqzpzn7wqsb7auxyidjl2x3zubumkydf3widq';
const USER = 'ocid1.user.oc1..aaaaaaaarkpbwlqhrfvzi4bnufynkxckxcpvl3t45bbg2iqnexpd37rx5jma';
const FINGERPRINT = '5d:64:e2:62:73:ad:4c:48:01:97:00:fa:d1:13:16:76';
const REGION = 'eu-marseille-1';
const NAME = 'claude-grabber';
const KEY = fs.readFileSync(process.env.OCI_KEY_FILE || 'C:\\Users\\marin\\.oci\\oci_api_key.pem', 'utf8');
const keyId = `${TENANCY}/${USER}/${FINGERPRINT}`;
const host = `iaas.${REGION}.oraclecloud.com`;

function ociGet(pathWithQuery) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const signingString = `date: ${date}\n(request-target): get ${pathWithQuery}\nhost: ${host}`;
    const sig = crypto.createSign('RSA-SHA256').update(signingString).sign(KEY, 'base64');
    const auth = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="date (request-target) host",signature="${sig}"`;
    const req = https.request({ method: 'GET', host, path: pathWithQuery,
      headers: { date, host, authorization: auth, accept: 'application/json' } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => res.statusCode < 300 ? resolve(JSON.parse(b)) : reject(new Error(`HTTP ${res.statusCode}: ${b}`)));
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  const insts = await ociGet(`/20160918/instances?compartmentId=${TENANCY}&displayName=${encodeURIComponent(NAME)}`);
  const inst = insts.find(i => !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState));
  if (!inst) { console.log('Aucune instance active.'); return; }
  console.log(`État: ${inst.lifecycleState}`);
  const atts = await ociGet(`/20160918/vnicAttachments?compartmentId=${TENANCY}&instanceId=${inst.id}`);
  const att = atts.find(a => a.lifecycleState === 'ATTACHED');
  if (!att) { console.log('VNIC pas encore attaché, réessaie dans 30s.'); return; }
  const vnic = await ociGet(`/20160918/vnics/${att.vnicId}`);
  console.log(`IP publique : ${vnic.publicIp || '(pas encore)'}`);
  console.log(`IP privée   : ${vnic.privateIp}`);
  console.log(`SSH         : ssh -i ~/.ssh/<clé pc1-marin-oracle> ubuntu@${vnic.publicIp}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
