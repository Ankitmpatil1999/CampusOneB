import mysql from 'mysql2/promise';

async function test() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  const [cols]: any = await conn.query(`DESCRIBE campusone_cug.departments`);
  console.log('Departments schema:', cols.map((c: any) => c.Field));
  
  const [rows]: any = await conn.query(`
    SELECT 
      d.id,
      d.name,
      COUNT(DISTINCT CASE WHEN ut.category = 'STUDENT' THEN mp.id END) as student_count,
      COUNT(DISTINCT CASE WHEN ut.category IN ('TEACHER', 'PRINCIPAL', 'DEAN', 'COORDINATOR') THEN mp.id END) as faculty_count
    FROM campusone_cug.departments d
    LEFT JOIN campusone_cug.member_profiles mp ON mp.department_id = d.id AND mp.status != 'INACTIVE' AND mp.institution_id = 6
    LEFT JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE d.institution_id = 6
    GROUP BY d.id, d.name
    HAVING student_count > 0 OR faculty_count > 0
    ORDER BY student_count DESC, faculty_count DESC
  `);
  console.log('--- PBCOE DEPARTMENTS BREAKDOWN ---');
  console.table(rows);
  await conn.end();
}

test().catch(console.error);
