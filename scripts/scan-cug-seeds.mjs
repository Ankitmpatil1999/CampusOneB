import fs from 'node:fs';
import readline from 'node:readline';

async function scan() {
  const fileStream = fs.createReadStream('db_backups_before_wipe.sql');
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let currentDb = '';
  const inserts = [];

  for await (const line of rl) {
    if (line.includes('Current Database:')) {
      currentDb = line;
    }
    if (line.startsWith('INSERT INTO') && currentDb.includes('campusone_cug')) {
      const parts = line.split('`');
      if (parts[1]) {
        inserts.push(parts[1]);
      }
    }
  }
  console.log('Tables with inserts in campusone_cug in backup (' + inserts.length + '):', [...new Set(inserts)]);
}
scan();

