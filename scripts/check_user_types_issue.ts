import mysql from 'mysql2/promise';

async function check() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [rows]: any = await conn.query(`
    SELECT mp.id, mp.first_name, mp.last_name, mp.user_type_id, ut.name as user_type_name, ut.category, pa.email
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    WHERE pa.email IN ('coordinator@pbcoe.edu.in', 'dean@pbcoe.edu.in', 'principal@pbcoe.edu.in', 'hod.cse@pbcoe.edu.in')
  `);
  console.log('Member Profiles and user_types:', rows);

  // Also check all distinct categories in user_types
  const [cats]: any = await conn.query(`
    SELECT id, name, category FROM campusone_cug.user_types
  `);
  console.log('All user_types:', cats);

  await conn.end();
}

check().catch(console.error);
