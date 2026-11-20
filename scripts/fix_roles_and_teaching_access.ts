import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');

  console.log('--- 1. UNLINK SUN RICE CONVENT PROFILES FROM PBCOE ACCOUNTS ---');
  await conn.query(`
    UPDATE campusone_cug.member_profiles
    SET account_id = NULL
    WHERE id IN (1056, 1057, 1059)
  `);

  console.log('\n--- 2. CONFIGURE DEAN (PROFILE 1109) ROLES ---');
  await conn.query(`
    DELETE FROM campusone_cug.profile_roles
    WHERE profile_id = 1109 AND role_id = 8
  `);
  await conn.query(`
    INSERT IGNORE INTO campusone_cug.profile_roles (profile_id, role_id)
    VALUES (1109, 30), (1109, 2)
  `);

  console.log('\n--- 3. CONFIGURE COORDINATOR (PROFILE 1110) ROLES ---');
  await conn.query(`
    INSERT IGNORE INTO campusone_cug.profile_roles (profile_id, role_id)
    VALUES (1110, 8), (1110, 2)
  `);

  console.log('\n--- 4. ADD TEACHING SUBTASKS TO ROLES 30, 8, 28 ---');
  const targetRoles = [30, 8, 28];
  for (const roleId of targetRoles) {
    await conn.query(`
      INSERT IGNORE INTO campusone.role_task_assignments (role_id, task_id)
      VALUES (?, 25)
    `, [roleId]);

    for (const subTaskId of [61, 62, 63, 64, 65, 66]) {
      await conn.query(`
        INSERT IGNORE INTO campusone.role_tasks (role_id, sub_task_id)
        VALUES (?, ?)
      `, [roleId, subTaskId]);
    }
  }

  console.log('\n--- 5. ASSIGN CLASS TEACHER ASSIGNMENTS TO DEAN & COORDINATOR ---');
  const yearId = 6;
  const [secRows]: any = await conn.query(`
    SELECT s.id as section_id, s.class_id, s.name as sec_name, c.name as class_name
    FROM campusone_cug.sections s
    JOIN campusone_cug.classes c ON c.id = s.class_id
    WHERE s.institution_id = 6
    LIMIT 2
  `);
  console.log('Target sections:', secRows);

  const sec1 = secRows[0];
  const sec2 = secRows[1];

  await conn.query(`
    UPDATE campusone_cug.teacher_assignments
    SET ended_at = NOW()
    WHERE year_id = ? AND section_id IN (?, ?) AND kind = 'CLASS_TEACHER' AND ended_at IS NULL
  `, [yearId, sec1.section_id, sec2.section_id]);

  await conn.query(`
    INSERT INTO campusone_cug.teacher_assignments
      (public_id, institution_id, year_id, class_id, section_id, teacher_profile_id, kind, created_at)
    VALUES
      (UUID_TO_BIN(UUID()), 6, ?, ?, ?, 1109, 'CLASS_TEACHER', NOW())
  `, [yearId, sec1.class_id, sec1.section_id]);

  await conn.query(`
    INSERT INTO campusone_cug.teacher_assignments
      (public_id, institution_id, year_id, class_id, section_id, teacher_profile_id, kind, created_at)
    VALUES
      (UUID_TO_BIN(UUID()), 6, ?, ?, ?, 1110, 'CLASS_TEACHER', NOW())
  `, [yearId, sec2.class_id, sec2.section_id]);

  console.log(`Assigned Dean (1109) as CLASS_TEACHER to ${sec1.class_name} ${sec1.sec_name} (Section ID: ${sec1.section_id})`);
  console.log(`Assigned Coordinator (1110) as CLASS_TEACHER to ${sec2.class_name} ${sec2.sec_name} (Section ID: ${sec2.section_id})`);

  console.log('\n--- 6. ENSURE HELLO@123 PASSWORD ON ACCOUNTS ---');
  const hash = '$argon2id$v=19$m=19456,t=2,p=1$UL0+BHNvqFQFWZIFNSsK2Q$9bFee9m0D/pUXmdEWpKVi0h/xhzzzt853crd/YKQSy0'; // Hello@123
  await conn.query(`
    UPDATE campusone.account_credentials
    SET hash = ?, failed_attempts = 0, locked_until = NULL, must_change = 0
    WHERE account_id IN (1079, 1080, 1082, 1128, 1387) AND kind = 'PASSWORD'
  `, [hash]);
  console.log('Ensured Hello@123 on accounts 1079 (Dean), 1080 (Coordinator), 1082 (Kalpana), 1128 (Principal), 1387 (Rohit).');

  await conn.end();
}

main().catch(console.error);
