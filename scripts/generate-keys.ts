/**
 * Creates local development keys in keys/ (gitignored): access-token signing keys (default and
 * back office) and the field-encryption key file. Existing files are never overwritten — losing
 * the field keys makes encrypted data unreadable. Production keys come from the secret store.
 *
 *   npm run keys:generate
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyFile } from '../utils/signing-keys';
import { generateFieldKeyFile } from '../utils/fieldEncryption';

const dir = join(import.meta.dirname, '..', 'keys');
mkdirSync(dir, { recursive: true });

const files: [string, () => Promise<unknown> | unknown][] = [
  ['signing-keys.json', () => generateKeyFile('rp')],
  ['ops-signing-keys.json', () => generateKeyFile('rp-ops')],
  ['field-keys.json', () => generateFieldKeyFile()],
];

for (const [name, make] of files) {
  const path = join(dir, name);
  if (existsSync(path)) {
    console.log(`kept     keys/${name} (already exists)`);
    continue;
  }
  writeFileSync(path, `${JSON.stringify(await make(), null, 2)}\n`, { mode: 0o600 });
  console.log(`created  keys/${name}`);
}

console.log(`
Add to .env (paths are relative to this folder):
AUTH_SIGNING_KEYS_FILE=keys/signing-keys.json
AUTH_OPS_SIGNING_KEYS_FILE=keys/ops-signing-keys.json
FIELD_KEYS_FILE=keys/field-keys.json`);
