// Mesure les trois criteres de "reclamation des instances inactives" d'Oracle.
// Doc officielle (freetier_topic-Always_Free_Resources.htm, maj 2026-06-12) : une instance
// Always Free est reputee inactive si, sur 7 jours, TOUTES ces conditions sont vraies :
//   - utilisation CPU au 95e centile < 20 %
//   - utilisation reseau < 20 %
//   - utilisation memoire < 20 %  (formes A1 uniquement)
// Le "toutes" est la cle : tenir UN seul critere au-dessus de 20 % suffit a rester hors
// de la definition. Ce script mesure ce qui est mesurable (CPU et memoire via
// oci_computeagent) et dit lequel nous protege.
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const CFG = {
  region: 'eu-marseille-1',
  tenancy: 'ocid1.tenancy.oc1..aaaaaaaaudgb2rry4yqmybhlqzpzn7wqsb7auxyidjl2x3zubumkydf3widq',
  user: 'ocid1.user.oc1..aaaaaaaarkpbwlqhrfvzi4bnufynkxckxcpvl3t45bbg2iqnexpd37rx5jma',
  fingerprint: '5d:64:e2:62:73:ad:4c:48:01:97:00:fa:d1:13:16:76',
  displayName: 'claude-dev',
};
const DAYS = Number(process.env.DAYS || 7);
const THRESHOLD = 20;
const KEY = fs.readFileSync(process.env.OCI_KEY_FILE || 'C:\\Users\\marin\\.oci\\oci_api_key.pem', 'utf8');
const keyId = `${CFG.tenancy}/${CFG.user}/${CFG.fingerprint}`;

function ociRequest(method, host, pathWithQuery, bodyObj) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    let toSign = `date: ${date}\n(request-target): ${method.toLowerCase()} ${pathWithQuery}\nhost: ${host}`;
    const headers = { date, host, accept: 'application/json' };
    let signed = 'date (request-target) host';
    if (method === 'POST') {
      const sha = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
      const len = Buffer.byteLength(body, 'utf8');
      toSign += `\ncontent-length: ${len}\ncontent-type: application/json\nx-content-sha256: ${sha}`;
      signed += ' content-length content-type x-content-sha256';
      Object.assign(headers, { 'content-length': len, 'content-type': 'application/json', 'x-content-sha256': sha });
    }
    headers.authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${signed}",signature="${crypto.createSign('RSA-SHA256').update(toSign).sign(KEY, 'base64')}"`;
    const req = https.request({ method, host, path: pathWithQuery, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

async function series(metric, instanceId, start, end) {
  const payload = {
    namespace: 'oci_computeagent',
    query: `${metric}[5m]{resourceId = "${instanceId}"}.mean()`,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
  const res = await ociRequest('POST', `telemetry.${CFG.region}.oraclecloud.com`,
    `/20180401/metrics/actions/summarizeMetricsData?compartmentId=${CFG.tenancy}`, payload);
  if (res.status < 200 || res.status >= 300) {
    return { error: `HTTP ${res.status}: ${res.body.slice(0, 200)}` };
  }
  const parsed = JSON.parse(res.body);
  const points = (parsed[0]?.aggregatedDatapoints ?? []).map((d) => d.value);
  return { points };
}

(async () => {
  const list = await ociRequest('GET', `iaas.${CFG.region}.oraclecloud.com`,
    `/20160918/instances?compartmentId=${CFG.tenancy}&displayName=${encodeURIComponent(CFG.displayName)}`);
  if (list.status !== 200) {
    console.error(`Liste des instances : HTTP ${list.status} ${list.body.slice(0, 200)}`);
    process.exit(1);
  }
  const live = JSON.parse(list.body).filter((i) => !['TERMINATED', 'TERMINATING'].includes(i.lifecycleState));
  if (live.length === 0) {
    console.log(`Aucune instance "${CFG.displayName}" : rien a mesurer.`);
    console.log('Plomberie de l\'API Monitoring verifiee quand meme ci-dessous.');
  }

  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400_000);
  const target = live[0]?.id ?? 'ocid1.instance.oc1.eu-marseille-1.inexistante';

  const cpu = await series('CpuUtilization', target, start, end);
  const mem = await series('MemoryUtilization', target, start, end);

  if (cpu.error || mem.error) {
    console.error('Monitoring inaccessible :', cpu.error || mem.error);
    process.exit(1);
  }

  const cpu95 = percentile(cpu.points, 95);
  const memMean = mem.points.length ? mem.points.reduce((a, b) => a + b, 0) / mem.points.length : null;
  const memMin = mem.points.length ? Math.min(...mem.points) : null;

  console.log(`Fenetre : ${DAYS} jours, ${cpu.points.length} points CPU / ${mem.points.length} points memoire.`);
  if (cpu.points.length === 0) {
    console.log('Aucun point : instance absente, ou plugin "Compute Instance Monitoring" desactive.');
    process.exit(0);
  }

  const fmt = (v) => (v === null ? 'n/a' : `${v.toFixed(1)} %`);
  const verdict = (v) => (v === null ? '?' : v >= THRESHOLD ? `AU-DESSUS de ${THRESHOLD} % -> protege` : `sous ${THRESHOLD} %`);
  console.log(`CPU 95e centile : ${fmt(cpu95)} — ${verdict(cpu95)}`);
  console.log(`Memoire moyenne : ${fmt(memMean)} — ${verdict(memMean)}`);
  console.log(`Memoire minimum : ${fmt(memMin)} (c'est le creux qui compte si Oracle prend un minimum)`);
  console.log('Reseau : Oracle ne documente pas la metrique exacte de son critere reseau — non mesure ici.');

  const safe = (cpu95 !== null && cpu95 >= THRESHOLD) || (memMean !== null && memMean >= THRESHOLD);
  console.log(safe
    ? '\nVERDICT : au moins un critere est au-dessus de 20 %, l\'instance ne rentre pas dans la definition d\'inactivite.'
    : '\nVERDICT : CPU et memoire sont tous deux sous 20 %. Si le reseau l\'est aussi — ce qui est probable — l\'instance est reclamable.');
})();
