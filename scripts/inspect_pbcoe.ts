import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');

  console.log('--- PBCOE (institution_id = 6) USERS & ROLES ---');
  const [profiles]: any = await conn.query(`
    SELECT 
      mp.id AS profile_id, 
      mp.account_id, 
      CONCAT(mp.first_name, ' ', mp.last_name) AS full_name,
      pa.email, 
      pa.mobile, 
      r.code AS role_code,
      r.name AS role_name,
      pa.status AS account_status,
      ac.kind AS cred_kind,
      ac.failed_attempts,
      ac.locked_until
    FROM campusone_cug.member_profiles mp
    LEFT JOIN campusone_cug.profile_roles pr ON pr.profile_id = mp.id
    LEFT JOIN campusone.roles r ON r.id = pr.role_id
    LEFT JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    LEFT JOIN campusone.account_credentials ac ON ac.account_id = mp.account_id
    WHERE mp.institution_id = 6
    ORDER BY mp.id ASC
  `);
  console.table(profiles);

  console.log('\n--- ALL OPERATOR / PLATFORM ADMIN ACCOUNTS ---');
  const [adminAccounts]: any = await conn.query(`
    SELECT 
      pa.id, 
      CONCAT(pa.first_name, ' ', pa.last_name) AS full_name,
      pa.email, 
      pa.mobile, 
      pa.status,
      ac.kind,
      ac.failed_attempts,
      ac.locked_until
    FROM campusone.platform_accounts pa
    LEFT JOIN campusone.account_credentials ac ON ac.account_id = pa.id
    WHERE pa.id <= 15 OR pa.email LIKE '%ankit%' OR pa.email LIKE '%arya%'
  `);
  console.table(adminAccounts);

  await conn.end();
}

main().catch(console.error);
