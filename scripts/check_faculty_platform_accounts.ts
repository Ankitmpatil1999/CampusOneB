import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [faculty]: any = await conn.query(`
    SELECT mp.id as profile_id, mp.first_name, mp.last_name, mp.account_id, pa.email, ac.id as cred_id, ac.hash
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    LEFT JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    LEFT JOIN campusone.account_credentials ac ON ac.account_id = mp.account_id AND ac.kind = 'PASSWORD'
    WHERE mp.institution_id = 6 AND ut.category IN ('TEACHER', 'COORDINATOR', 'DEAN', 'PRINCIPAL')
    ORDER BY mp.id
  `);
  console.log('Faculty credentials:');
  console.table(faculty.map((f: any) => ({
    profile: f.profile_id,
    name: `${f.first_name} ${f.last_name}`,
    email: f.email,
    hasCred: !!f.cred_id
  })));

  await conn.end();
}

main().catch(console.error);
