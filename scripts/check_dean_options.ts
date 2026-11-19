import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  console.log('=== PBCOE USER TYPES (institution_id = 6) ===');
  const [uts]: any = await conn.query("SELECT id, name, category, status FROM campusone_cug.user_types WHERE institution_id = 6");
  console.table(uts);

  console.log('=== INSTITUTION ROLES ===');
  const [roles]: any = await conn.query("SELECT id, code, name, scope, status FROM campusone.roles WHERE scope = 'INSTITUTION'");
  console.table(roles);

  console.log('=== MANAGEMENT / LEADERSHIP IN PBCOE ===');
  const [mgmt]: any = await conn.query(`
    SELECT mp.id, CONCAT(mp.first_name, ' ', mp.last_name) as name, pa.email, r.name as role_name, ut.name as user_type_name
    FROM campusone_cug.member_profiles mp
    JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    JOIN campusone_cug.profile_roles pr ON pr.profile_id = mp.id
    JOIN campusone.roles r ON r.id = pr.role_id
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = 6 AND r.code IN ('CEO', 'PRINCIPAL', 'DEAN', 'MANAGEMENT', 'INSTITUTION_ADMIN', 'ACADEMIC_COORDINATOR', 'HOD')
  `);
  console.table(mgmt);

  await conn.end();
}

main().catch(console.error);
