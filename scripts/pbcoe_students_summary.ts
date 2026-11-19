import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const instId = 6; // PBCOE

  console.log('=== PBCOE STUDENTS BREAKDOWN BY DEPARTMENT ===');
  const [deptStats]: any = await conn.query(`
    SELECT 
      d.id as dept_id,
      d.name as department_name,
      COUNT(mp.id) as total_students
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    LEFT JOIN campusone_cug.departments d ON d.id = mp.department_id
    WHERE mp.institution_id = ? AND ut.category = 'STUDENT'
    GROUP BY d.id
    ORDER BY total_students DESC
  `, [instId]);
  console.table(deptStats);

  console.log('\n=== SAMPLE STUDENTS FROM EACH BRANCH ===');
  for (const dept of deptStats) {
    const [deptStudents]: any = await conn.query(`
      SELECT 
        mp.id AS profile_id,
        CONCAT(mp.first_name, ' ', mp.last_name) AS student_name,
        mp.gender,
        mp.admission_no,
        pa.email,
        pa.mobile
      FROM campusone_cug.member_profiles mp
      JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
      JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
      WHERE mp.institution_id = ? AND mp.department_id = ? AND ut.category = 'STUDENT'
      ORDER BY mp.id ASC
      LIMIT 8
    `, [instId, dept.dept_id]);
    
    console.log(`\n--- Department: ${dept.department_name} (Total: ${dept.total_students}) ---`);
    console.table(deptStudents);
  }

  await conn.end();
}

main().catch(console.error);
