import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const hash = '$argon2id$v=19$m=19456,t=2,p=1$UL0+BHNvqFQFWZIFNSsK2Q$9bFee9m0D/pUXmdEWpKVi0h/xhzzzt853crd/YKQSy0'; // Hello@123

  const [accIds]: any = await conn.query(`
    SELECT DISTINCT mp.account_id
    FROM campusone_cug.member_profiles mp
    WHERE mp.institution_id = 6 AND mp.account_id IS NOT NULL
  `);

  const ids = accIds.map((a: any) => a.account_id);
  console.log(`Updating passwords to Hello@123 for ${ids.length} PBCOE accounts...`);

  await conn.query(`
    UPDATE campusone.account_credentials
    SET hash = ?, failed_attempts = 0, locked_until = NULL, must_change = 0
    WHERE account_id IN (?) AND kind = 'PASSWORD'
  `, [hash, ids]);

  console.log('Successfully set password for all PBCOE accounts.');
  await conn.end();
}

main().catch(console.error);
