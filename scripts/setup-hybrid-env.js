import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const keyName = process.argv[2] || 'xsuaa-imsdev-key';
const instanceName = process.argv[3] || 'xsuaa-imsdev';

console.log(`Fetching service key ${keyName} from ${instanceName}...`);

const raw = execFileSync('cf', ['service-key', instanceName, keyName], { encoding: 'utf8' });
const jsonStart = raw.indexOf('{');
const creds = JSON.parse(raw.slice(jsonStart)).credentials;

const env = {
  VCAP_SERVICES: {
    xsuaa: [{
      label: 'xsuaa',
      name: instanceName,
      tags: ['xsuaa'],
      credentials: creds
    }]
  },
  destinations: JSON.stringify([{
    name: 'srv-api',
    url: 'http://localhost:4004',
    forwardAuthToken: true
  }])
};

const outPath = join(projectRoot, 'approuter', 'default-env.json');
writeFileSync(outPath, JSON.stringify(env, null, 2));
console.log(`Written ${outPath}`);
console.log('\nRun "npm run dev:hybrid" to start CAP + approuter together.');
