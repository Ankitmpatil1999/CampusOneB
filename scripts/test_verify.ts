import mysql from 'mysql2/promise';
import { verifySecret } from '../utils/password';

async function test() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [creds]: any = await conn.query('SELECT account_id, hash FROM campusone.account_credentials WHERE account_id IN (9, 1078, 1128)');
  
  const hash9 = creds.find((c: any) => c.account_id === 9)?.hash;
  const hashPbcoe = creds.find((c: any) => c.account_id === 1078)?.hash;

  console.log('Testing account 9 with Ankit@1999:');
  console.log('Result:', await verifySecret(hash9, 'Ankit@1999'));

  const candidates = [
    'Pbcoe@2026', 'Tvps@2026', 'CampusOne@2026', 'College@2026', 'Admin@2026', 'Staff@2026',
    'Pbcoe@123', 'Tvps@123', 'CampusOne@123', 'Password@123', 'Admin@123', 'Member@2026',
    'Dev@2026', 'School@2026', 'Operator@2026', 'Console@2026', 'Welcome@2026', 'Ankit@1999',
    'Pbcoe@2025', 'Pbcoe@2024', 'tvps123', 'pbcoe123', 'campusone123', 'Prakash@2026',
    'Hello@123', 'pbcoe@2026', 'Pbcoe@2027', 'Priyadarshini@2026', 'Priyadarshini@123',
    'pbcoe', 'PBCOE@2026', 'Password123!', 'Admin@1234', '12345678', 'Pbcoe@1234'
  ];

  console.log('\nTesting PBCOE hash with candidates:');
  for (const c of candidates) {
    if (await verifySecret(hashPbcoe, c)) {
      console.log('>>> MATCH FOUND FOR PBCOE! Password is:', c);
      await conn.end();
      return;
    }
  }
  console.log('None of the candidates matched PBCOE hash.');
  await conn.end();
}

test().catch(console.error);
