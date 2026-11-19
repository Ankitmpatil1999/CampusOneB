import mysql from 'mysql2/promise';

async function listStaff() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [rows]: any = await conn.query(`
    SELECT 
      mp.id AS profile_id,
      mp.account_id,
      CONCAT(mp.first_name, ' ', mp.last_name) AS full_name,
      pa.email,
      pa.mobile,
      r.name AS designation,
      r.code AS role_code
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.profile_roles pr ON pr.profile_id = mp.id
    JOIN campusone.roles r ON r.id = pr.role_id
    JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    WHERE mp.institution_id = 6
    ORDER BY mp.id ASC
  `);

  console.log('=== PBCOE STAFF ACCOUNTS ===');
  for (const r of rows) {
    console.log(`${r.designation.padEnd(35)} | ${r.full_name.padEnd(22)} | ${r.email.padEnd(30)} | Mobile: ${r.mobile}`);
  }

  await conn.end();
}

listStaff().catch(console.error);
