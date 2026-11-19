import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [accounts]: any = await conn.query(`
    SELECT sa.id, sa.email, sa.phone, sa.status, mp.id as profile_id, mp.first_name, mp.last_name, ut.category
    FROM campusone_cug.staff_accounts sa
    JOIN campusone_cug.member_profiles mp ON mp.staff_account_id = sa.id
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = 6
    ORDER BY ut.category, mp.id
  `);
  console.table(accounts);
  await conn.end();
}

main().catch(console.error);
