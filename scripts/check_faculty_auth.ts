import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [profiles]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, mp.contact_email, mp.account_id, mp.own_account_id, ut.category
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = 6 AND ut.category IN ('TEACHER', 'COORDINATOR', 'DEAN', 'PRINCIPAL')
    LIMIT 10
  `);
  console.table(profiles);

  if (profiles.length > 0) {
    const accIds = profiles.map((p: any) => p.account_id).filter(Boolean);
    const [creds]: any = await conn.query(`
      SELECT account_id, email, phone, is_email_verified, status
      FROM campusone.account_credentials
      WHERE account_id IN (?)
    `, [accIds]);
    console.log('Account Credentials:');
    console.table(creds);
  }

  await conn.end();
}

main().catch(console.error);
