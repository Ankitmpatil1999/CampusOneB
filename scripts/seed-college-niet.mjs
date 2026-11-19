// scripts/seed-college-niet.mjs
import mysql from 'mysql2/promise';
import { v7 as uuidv7, parse as uuidParse } from 'uuid';

const DB_URL = process.env.DATABASE_URL || 'mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone';
const PASSWORD_PLAIN = 'Hello@123';
const ARGON2_HASH = '$argon2id$v=19$m=19456,t=2,p=1$SyBDOcIx8JYRAcBO8vXFVA$DYwzWu23h/wuAXigDpCqy4N7OL5j9+BJ/klF3VoQ+xg';

const newPublicId = () => Buffer.from(uuidParse(uuidv7()));

async function seedCollege() {
  console.log('🚀 Seeding Nagpur Institute of Engineering & Technology (ID: 5)...');
  const conn = await mysql.createConnection(DB_URL);
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  try {
    const instId = 5;
    // 1. Activate Institution
    await conn.query('UPDATE campusone_cug.institutions SET status = "ACTIVE" WHERE id = ?', [instId]);
    console.log('✅ Institution activated');

    // Clean up partial data for instId 5
    await conn.query('DELETE FROM campusone_cug.timetable_slots WHERE institution_id = ?', [instId]);
    await conn.query('DELETE FROM campusone_cug.teacher_assignments WHERE institution_id = ?', [instId]);
    await conn.query('DELETE FROM campusone_cug.class_subjects WHERE institution_id = ?', [instId]);
    await conn.query('DELETE FROM campusone_cug.sections WHERE institution_id = ?', [instId]);
    await conn.query('DELETE FROM campusone_cug.classes WHERE institution_id = ?', [instId]);
    await conn.query('DELETE FROM campusone_cug.subjects WHERE institution_id = ?', [instId]);
    await conn.query('DELETE FROM campusone_cug.periods WHERE institution_id = ?', [instId]);
    await conn.query('DELETE FROM campusone_cug.enrolments WHERE institution_id = ?', [instId]);

    // 2. Academic Year
    let [years] = await conn.query('SELECT * FROM campusone_cug.academic_years WHERE institution_id = ? AND is_current = 1', [instId]);
    let yearId = years.length ? years[0].id : null;
    if (!yearId) {
      const pubId = newPublicId();
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.academic_years (public_id, institution_id, label, starts_on, ends_on, status, is_current, current_key) VALUES (?, ?, "2026-27", "2026-07-01", "2027-06-30", "OPEN", 1, ?)',
        [pubId, instId, instId]
      );
      yearId = res.insertId;
    }
    console.log(`✅ Current Academic Year ID: ${yearId} (2026-27)`);

    // 3. User Types & Departments
    const [uts] = await conn.query('SELECT id, name, category FROM campusone_cug.user_types WHERE institution_id = ?', [instId]);
    let staffUtId = uts.find(u => u.category === 'STAFF')?.id;
    let studentUtId = uts.find(u => u.category === 'STUDENT')?.id;

    const [deps] = await conn.query('SELECT id, name FROM campusone_cug.departments WHERE institution_id = ?', [instId]);
    let adminDeptId = deps.find(d => d.name.includes('Admin'))?.id;
    let cseDeptId = deps.find(d => d.name.includes('Computer Science'))?.id;
    let progDeptId = deps.find(d => d.name.includes('Degree'))?.id;

    // 4. College Periods (Lectures & Labs)
    const periods = [
      { name: 'Lecture 1', start: '09:00:00', end: '10:00:00', isBreak: 0 },
      { name: 'Lecture 2', start: '10:00:00', end: '11:00:00', isBreak: 0 },
      { name: 'Tea Break', start: '11:00:00', end: '11:15:00', isBreak: 1 },
      { name: 'Lecture 3', start: '11:15:00', end: '12:15:00', isBreak: 0 },
      { name: 'Lecture 4', start: '12:15:00', end: '13:15:00', isBreak: 0 },
      { name: 'Lunch Break', start: '13:15:00', end: '14:00:00', isBreak: 1 },
      { name: 'Lab Session / Practical', start: '14:00:00', end: '16:00:00', isBreak: 0 },
      { name: 'Library / Mentoring', start: '16:00:00', end: '17:00:00', isBreak: 0 },
    ];
    const periodMap = {};
    for (const p of periods) {
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.periods (public_id, institution_id, name, starts_at, ends_at, is_break) VALUES (?, ?, ?, ?, ?, ?)',
        [newPublicId(), instId, p.name, p.start, p.end, p.isBreak]
      );
      periodMap[p.name] = res.insertId;
    }
    console.log('✅ College Periods Created');

    // 5. Engineering & College Subjects
    const subjects = [
      { code: 'CS101', name: 'Engineering Mathematics I', colour: '#3B82F6' },
      { code: 'CS201', name: 'Data Structures & Algorithms', colour: '#10B981' },
      { code: 'CS202', name: 'Database Management Systems', colour: '#8B5CF6' },
      { code: 'CS301', name: 'Operating Systems & Architecture', colour: '#F59E0B' },
      { code: 'CS302', name: 'Computer Networks & Security', colour: '#EC4899' },
      { code: 'CS303', name: 'Software Engineering & Agile', colour: '#06B6D4' },
      { code: 'CS401', name: 'Cloud Computing & DevOps', colour: '#6366F1' },
    ];
    const subjectMap = {};
    for (const s of subjects) {
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.subjects (public_id, institution_id, code, name, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), instId, s.code, s.name, s.colour]
      );
      subjectMap[s.code] = res.insertId;
    }
    console.log('✅ College Subjects Created');

    // 6. Degree Programs & Classes
    const classes = [
      { name: 'B.Tech CSE - 1st Year (Sem 1 & 2)', sort: 1 },
      { name: 'B.Tech CSE - 2nd Year (Sem 3 & 4)', sort: 2 },
      { name: 'B.Tech CSE - 3rd Year (Sem 5 & 6)', sort: 3 },
      { name: 'B.Tech AI & Data Science - 1st Year', sort: 4 },
      { name: 'MBA - 1st Year (Sem 1)', sort: 5 },
    ];
    const classMap = {};
    const sectionMap = {};

    for (const c of classes) {
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.classes (public_id, institution_id, name, sort_order) VALUES (?, ?, ?, ?)',
        [newPublicId(), instId, c.name, c.sort]
      );
      const cId = res.insertId;
      classMap[c.name] = cId;

      // Link subjects
      for (const sCode of Object.keys(subjectMap)) {
        await conn.query('INSERT IGNORE INTO campusone_cug.class_subjects (institution_id, class_id, subject_id) VALUES (?, ?, ?)', [instId, cId, subjectMap[sCode]]);
      }

      // Sections (Div A & Div B)
      for (const sName of ['Section A', 'Section B']) {
        const [sRes] = await conn.query(
          'INSERT INTO campusone_cug.sections (public_id, institution_id, class_id, name, capacity) VALUES (?, ?, ?, ?, 60)',
          [newPublicId(), instId, cId, sName]
        );
        sectionMap[`${c.name}-${sName}`] = sRes.insertId;
      }
    }
    console.log('✅ College Degree Classes & Sections Created');

    // 7. Key Faculty & Professors
    const facultyMembers = [
      {
        email: 'arvind.dean@gmail.com',
        mobile: '9822991001',
        first: 'Dr. Arvind',
        last: 'Sharma',
        deptId: adminDeptId,
        roles: [1, 2] // Institution Admin & Principal / Dean
      },
      {
        email: 'hod.cse.niet@gmail.com',
        mobile: '9822991002',
        first: 'Prof. Snehal',
        last: 'Patil',
        deptId: cseDeptId,
        roles: [3] // Teacher / Faculty
      },
      {
        email: 'rajesh.kulkarni@gmail.com',
        mobile: '9822991003',
        first: 'Prof. Rajesh',
        last: 'Kulkarni',
        deptId: cseDeptId,
        roles: [3] // Teacher / Faculty
      },
      {
        email: 'neha.gupta@gmail.com',
        mobile: '9822991004',
        first: 'Prof. Neha',
        last: 'Gupta',
        deptId: cseDeptId,
        roles: [3] // Teacher / Faculty
      },
      {
        email: 'accounts.niet@gmail.com',
        mobile: '9822991005',
        first: 'Vikas',
        last: 'Joshi',
        deptId: adminDeptId,
        roles: [4] // Accounts & Finance
      }
    ];

    const facultyProfiles = {};
    for (const f of facultyMembers) {
      let [existing] = await conn.query('SELECT id FROM campusone.platform_accounts WHERE email = ?', [f.email]);
      let accId = existing.length ? existing[0].id : null;
      if (!accId) {
        const [res] = await conn.query(
          'INSERT INTO campusone.platform_accounts (public_id, mobile, email, first_name, last_name, status, kyc_level, txn_permission) VALUES (?, ?, ?, ?, ?, "ACTIVE", "MIN", 1)',
          [newPublicId(), f.mobile, f.email, f.first, f.last]
        );
        accId = res.insertId;
        await conn.query(
          'INSERT INTO campusone.account_credentials (account_id, kind, hash, must_change) VALUES (?, "PASSWORD", ?, 0)',
          [accId, ARGON2_HASH]
        );
      } else {
        await conn.query('UPDATE campusone.account_credentials SET hash = ?, failed_attempts = 0, locked_until = NULL, must_change = 0 WHERE account_id = ?', [ARGON2_HASH, accId]);
      }

      // Member profile
      let [mp] = await conn.query('SELECT id FROM campusone_cug.member_profiles WHERE institution_id = ? AND account_id = ?', [instId, accId]);
      let profId = mp.length ? mp[0].id : null;
      if (!profId) {
        const [res] = await conn.query(
          'INSERT INTO campusone_cug.member_profiles (public_id, institution_id, account_id, user_type_id, department_id, first_name, last_name, contact_mobile, contact_email, employee_no, status, txn_permission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "ACTIVE", 1)',
          [newPublicId(), instId, accId, staffUtId, f.deptId, f.first, f.last, f.mobile, f.email, `EMP-${accId}`]
        );
        profId = res.insertId;
      }
      for (const rId of f.roles) {
        await conn.query('INSERT IGNORE INTO campusone_cug.profile_roles (institution_id, profile_id, role_id) VALUES (?, ?, ?)', [instId, profId, rId]);
      }
      facultyProfiles[f.email] = profId;
    }
    console.log('✅ College Faculty & Dean Profiles Created');

    // 8. Assign Class Coordinators & Faculty to Subjects
    const cse1SectionA = sectionMap['B.Tech CSE - 1st Year (Sem 1 & 2)-Section A'];
    const cse2SectionA = sectionMap['B.Tech CSE - 2nd Year (Sem 3 & 4)-Section A'];

    // Class Coordinator (Class Teacher equivalent in college)
    await conn.query(
      'INSERT INTO campusone_cug.teacher_assignments (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, section_id, created_at) VALUES (?, ?, ?, "CLASS_TEACHER", ?, ?, ?, utc_timestamp(3))',
      [newPublicId(), instId, yearId, facultyProfiles['hod.cse.niet@gmail.com'], classMap['B.Tech CSE - 1st Year (Sem 1 & 2)'], cse1SectionA]
    );

    // Subject Professors
    await conn.query(
      'INSERT INTO campusone_cug.teacher_assignments (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, section_id, subject_id, created_at) VALUES (?, ?, ?, "SUBJECT_TEACHER", ?, ?, ?, ?, utc_timestamp(3))',
      [newPublicId(), instId, yearId, facultyProfiles['rajesh.kulkarni@gmail.com'], classMap['B.Tech CSE - 1st Year (Sem 1 & 2)'], cse1SectionA, subjectMap['CS201']]
    );
    await conn.query(
      'INSERT INTO campusone_cug.teacher_assignments (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, section_id, subject_id, created_at) VALUES (?, ?, ?, "SUBJECT_TEACHER", ?, ?, ?, ?, utc_timestamp(3))',
      [newPublicId(), instId, yearId, facultyProfiles['neha.gupta@gmail.com'], classMap['B.Tech CSE - 1st Year (Sem 1 & 2)'], cse1SectionA, subjectMap['CS202']]
    );
    console.log('✅ Faculty Class & Subject Assignments Created');

    // 9. Timetable Slots (day is integer: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri)
    const days = [1, 2, 3, 4, 5];
    for (const d of days) {
      await conn.query(
        'INSERT INTO campusone_cug.timetable_slots (institution_id, year_id, section_id, day, period_id, subject_id, teacher_profile_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, utc_timestamp(3))',
        [instId, yearId, cse1SectionA, d, periodMap['Lecture 1'], subjectMap['CS101'], facultyProfiles['rajesh.kulkarni@gmail.com']]
      );
      await conn.query(
        'INSERT INTO campusone_cug.timetable_slots (institution_id, year_id, section_id, day, period_id, subject_id, teacher_profile_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, utc_timestamp(3))',
        [instId, yearId, cse1SectionA, d, periodMap['Lecture 2'], subjectMap['CS201'], facultyProfiles['rajesh.kulkarni@gmail.com']]
      );
      await conn.query(
        'INSERT INTO campusone_cug.timetable_slots (institution_id, year_id, section_id, day, period_id, subject_id, teacher_profile_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, utc_timestamp(3))',
        [instId, yearId, cse1SectionA, d, periodMap['Lecture 3'], subjectMap['CS202'], facultyProfiles['neha.gupta@gmail.com']]
      );
      await conn.query(
        'INSERT INTO campusone_cug.timetable_slots (institution_id, year_id, section_id, day, period_id, subject_id, teacher_profile_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, utc_timestamp(3))',
        [instId, yearId, cse1SectionA, d, periodMap['Lab Session / Practical'], subjectMap['CS201'], facultyProfiles['hod.cse.niet@gmail.com']]
      );
    }
    console.log('✅ College Weekly Timetable Configured');

    // 10. Sample College Engineering Students
    const studentNames = [
      { first: 'Siddharth', last: 'Joshi', roll: 'BT26CSE001' },
      { first: 'Aayush', last: 'Sharma', roll: 'BT26CSE002' },
      { first: 'Rhea', last: 'Deshmukh', roll: 'BT26CSE003' },
      { first: 'Ananya', last: 'Patil', roll: 'BT26CSE004' },
      { first: 'Tanmay', last: 'Verma', roll: 'BT26CSE005' },
    ];

    for (let i = 0; i < studentNames.length; i++) {
      const s = studentNames[i];
      const sMobile = `982299200${i + 1}`;
      const sEmail = `student${i + 1}.niet@gmail.com`;

      const [res] = await conn.query(
        'INSERT INTO campusone.platform_accounts (public_id, mobile, email, first_name, last_name, status, kyc_level, txn_permission) VALUES (?, ?, ?, ?, ?, "ACTIVE", "MIN", 1)',
        [newPublicId(), sMobile, sEmail, s.first, s.last]
      );
      const accId = res.insertId;
      await conn.query(
        'INSERT INTO campusone.account_credentials (account_id, kind, hash, must_change) VALUES (?, "PASSWORD", ?, 0)',
        [accId, ARGON2_HASH]
      );

      const [mpRes] = await conn.query(
        'INSERT INTO campusone_cug.member_profiles (public_id, institution_id, account_id, user_type_id, department_id, first_name, last_name, gender, date_of_birth, contact_mobile, contact_email, admission_no, status, txn_permission) VALUES (?, ?, ?, ?, ?, ?, ?, "MALE", "2006-05-15", ?, ?, ?, "ACTIVE", 1)',
        [newPublicId(), instId, accId, studentUtId, progDeptId, s.first, s.last, sMobile, sEmail, s.roll]
      );
      const profId = mpRes.insertId;
      await conn.query('INSERT INTO campusone_cug.profile_roles (institution_id, profile_id, role_id) VALUES (?, ?, 8)', [instId, profId]);

      // Enrolment
      await conn.query(
        'INSERT INTO campusone_cug.enrolments (public_id, institution_id, student_profile_id, year_id, section_id, enrolled_on) VALUES (?, ?, ?, ?, ?, "2026-07-01")',
        [newPublicId(), instId, profId, yearId, cse1SectionA]
      );
    }
    console.log('✅ Sample Engineering Students Enrolled');

    console.log('\n🎉 ALL COLLEGE DATA SEEDED SUCCESSFULLY FOR NAGPUR INSTITUTE OF ENGINEERING & TECHNOLOGY!');
    console.log('Login credentials for Dean / Admin:');
    console.log('Email: arvind.dean@gmail.com');
    console.log('Password: Hello@123');
  } catch (err) {
    console.error('❌ Error seeding college:', err);
  } finally {
    await conn.end();
  }
}

seedCollege();
