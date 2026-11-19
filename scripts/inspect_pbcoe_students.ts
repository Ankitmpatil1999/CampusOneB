import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const instId = 6; // PBCOE

  console.log('--- 1. USER TYPES IN PBCOE ---');
  const [uts]: any = await conn.query('SELECT * FROM campusone_cug.user_types WHERE institution_id = ?', [instId]);
  console.table(uts);

  console.log('--- 2. STUDENT COUNT IN PBCOE ---');
  const [studentCount]: any = await conn.query(`
    SELECT COUNT(*) as total_students 
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    WHERE mp.institution_id = ? AND ut.category = 'STUDENT'
  `, [instId]);
  console.table(studentCount);

  console.log('--- 3. SAMPLE STUDENTS IN PBCOE (first 30) ---');
  const [students]: any = await conn.query(`
    SELECT 
      mp.id AS profile_id,
      mp.account_id,
      CONCAT(mp.first_name, ' ', mp.last_name) AS full_name,
      mp.gender,
      mp.admission_no,
      mp.employee_no,
      d.name AS department_name,
      pa.email,
      pa.mobile,
      mp.status AS profile_status,
      pa.status AS account_status,
      (SELECT kind FROM campusone.account_credentials WHERE account_id = mp.account_id LIMIT 1) as cred_kind
    FROM campusone_cug.member_profiles mp
    JOIN campusone_cug.user_types ut ON ut.id = mp.user_type_id
    LEFT JOIN campusone_cug.departments d ON d.id = mp.department_id
    LEFT JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
    WHERE mp.institution_id = ? AND ut.category = 'STUDENT'
    ORDER BY mp.id ASC
    LIMIT 30
  `, [instId]);
  console.table(students);

  console.log('--- 4. ENROLMENTS / CLASSES FOR STUDENTS ---');
  const [classes]: any = await conn.query(`
    SELECT c.id, c.name, sec.name as section_name, d.name as dept_name, COUNT(e.id) as student_count
    FROM campusone_cug.classes c
    LEFT JOIN campusone_cug.sections sec ON sec.class_id = c.id
    LEFT JOIN campusone_cug.departments d ON d.id = c.department_id
    LEFT JOIN campusone_cug.enrolments e ON e.class_id = c.id
    WHERE c.institution_id = ?
    GROUP BY c.id, sec.id
  `, [instId]);
  console.table(classes);

  await conn.end();
}

main().catch(console.error);
