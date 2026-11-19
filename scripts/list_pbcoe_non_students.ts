import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [profiles]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, ut.category, ut.name as role_name
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = 6 AND mp.status != 'INACTIVE' AND ut.category != 'STUDENT'
    ORDER BY ut.category, mp.id
  `);
  console.table(profiles);
  await conn.end();
}

main().catch(console.error);
