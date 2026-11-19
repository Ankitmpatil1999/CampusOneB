import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const [pRoles]: any = await conn.query(`
    SELECT pr.profile_id, mp.first_name, mp.last_name, pr.role_id, r.name as role_name
    FROM campusone_cug.profile_roles pr
    JOIN campusone_cug.member_profiles mp ON mp.id = pr.profile_id
    JOIN campusone.roles r ON r.id = pr.role_id
    WHERE mp.institution_id = 6
    ORDER BY pr.profile_id
    LIMIT 20
  `);
  console.log('Sample profile roles in inst 6:');
  console.table(pRoles);

  const [kalpanaRoles]: any = await conn.query(`
    SELECT pr.*, r.name as role_name, r.code as role_code
    FROM campusone_cug.profile_roles pr
    JOIN campusone.roles r ON r.id = pr.role_id
    WHERE pr.profile_id = 1112
  `);
  console.log('Kalpana roles (profile 1112):', kalpanaRoles);

  // Check what role has code TEACHER
  const [teacherRole]: any = await conn.query("SELECT * FROM campusone.roles WHERE code = 'TEACHER' OR name LIKE '%Teacher%'");
  console.log('Teacher roles:', teacherRole);

  await conn.end();
}

main().catch(console.error);
