// scripts/seed-sun-rice-full.mjs
import mysql from 'mysql2/promise';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { v7 as uuidv7, parse as uuidParse } from 'uuid';

const DB_URL = process.env.DATABASE_URL || 'mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone';
const PASSWORD_PLAIN = 'Hello@123';
// Pre-computed Argon2id hash for Hello@123
const ARGON2_HASH = '$argon2id$v=19$m=19456,t=2,p=1$SyBDOcIx8JYRAcBO8vXFVA$DYwzWu23h/wuAXigDpCqy4N7OL5j9+BJ/klF3VoQ+xg';

const newPublicId = () => Buffer.from(uuidParse(uuidv7()));

// Realistic Indian first names & last names
const FIRST_NAMES_MALE = [
  'Aarav', 'Vihaan', 'Aditya', 'Reyansh', 'Arjun', 'Sai', 'Krishna', 'Ishaan', 'Shaurya', 'Atharv',
  'Aayush', 'Dhruv', 'Kabir', 'Rudra', 'Ananya', 'Rohan', 'Pranav', 'Om', 'Vedant', 'Samarth',
  'Yash', 'Siddharth', 'Tanmay', 'Soham', 'Harsh', 'Aryan', 'Tejas', 'Chinmay', 'Dev', 'Manav',
  'Shubham', 'Mayank', 'Gaurav', 'Nikhil', 'Ayush', 'Kartik', 'Vivek', 'Akshay', 'Jay', 'Deepak'
];

const FIRST_NAMES_FEMALE = [
  'Saanvi', 'Aanya', 'Aadhya', 'Aaradhya', 'Ananya', 'Pari', 'Diya', 'Riya', 'Avani', 'Isha',
  'Myra', 'Kavya', 'Navya', 'Khushi', 'Tanvi', 'Siya', 'Shanaya', 'Shruti', 'Anushka', 'Riddhi',
  'Siddhi', 'Sneha', 'Sakshi', 'Pooja', 'Neha', 'Prisha', 'Aditi', 'Gauri', 'Mugdha', 'Swara',
  'Sanika', 'Sayali', 'Vaishnavi', 'Shreya', 'Radha', 'Meera', 'Durga', 'Bhakti', 'Ruchira', 'Tanya'
];

const LAST_NAMES = [
  'Patil', 'Deshmukh', 'Kulkarni', 'Joshi', 'Sharma', 'Verma', 'Gupta', 'Shinde', 'Pawar', 'Chavan',
  'Wankhede', 'Bawankar', 'Meshram', 'Bisen', 'Gawande', 'Dhoke', 'Kohale', 'Rathod', 'Jadhav', 'Mahajan',
  'Tiwari', 'Pandey', 'Mishra', 'Yadav', 'Thakur', 'Bhatt', 'Nair', 'Menon', 'Rao', 'Reddy',
  'Agarwal', 'Shah', 'Mehta', 'Chopra', 'Malhotra', 'Kapoor', 'Singh', 'Dubey', 'Saxena', 'Sonwane'
];

async function seed() {
  console.log('🚀 Starting Full Seeding for Sun Rice Convent...');
  const conn = await mysql.createConnection(DB_URL);
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');

  try {
    // 1. Verify Sun Rice Convent
    const [insts] = await conn.query('SELECT * FROM campusone_cug.institutions WHERE id = 4');
    if (!insts.length) throw new Error('Sun Rice Convent (id 4) not found!');
    const inst = insts[0];
    console.log(`✅ Institution Found: ${inst.name} (ID: ${inst.id}, Identifier: ${inst.identifier})`);

    // Ensure status is ACTIVE
    await conn.query('UPDATE campusone_cug.institutions SET status = "ACTIVE" WHERE id = 4');
    await conn.query('UPDATE campusone.subscriptions SET status = "ACTIVE" WHERE institution_id = 4');

    // 2. Academic Year
    let [years] = await conn.query('SELECT * FROM campusone_cug.academic_years WHERE institution_id = 4 AND is_current = 1');
    let yearId = years.length ? years[0].id : null;
    if (!yearId) {
      const pubId = newPublicId();
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.academic_years (public_id, institution_id, label, starts_on, ends_on, status, is_current, current_key) VALUES (?, 4, "2026-27", "2026-04-01", "2027-03-31", "OPEN", 1, 4)',
        [pubId]
      );
      yearId = res.insertId;
    }
    console.log(`✅ Current Academic Year ID: ${yearId} (2026-27)`);

    // 3. User Types & Departments
    console.log('📦 Setting up User Types & Departments...');
    const userTypesToEnsure = [
      { name: 'Staff', category: 'STAFF' },
      { name: 'Student', category: 'STUDENT' },
      { name: 'Teacher', category: 'TEACHER' },
      { name: 'Principal', category: 'PRINCIPAL' },
      { name: 'Transport Crew', category: 'CREW' },
      { name: 'Parent', category: 'PARENT' },
    ];
    const userTypeMap = {};
    for (const ut of userTypesToEnsure) {
      const [existing] = await conn.query('SELECT id FROM campusone_cug.user_types WHERE institution_id = 4 AND name = ?', [ut.name]);
      if (existing.length) {
        userTypeMap[ut.name] = existing[0].id;
      } else {
        const [res] = await conn.query('INSERT INTO campusone_cug.user_types (public_id, institution_id, name, category, status) VALUES (?, 4, ?, ?, "ACTIVE")', [newPublicId(), ut.name, ut.category]);
        userTypeMap[ut.name] = res.insertId;
      }
    }

    const deptsToEnsure = [
      { name: 'Administration', ut: 'Staff' },
      { name: 'Academics', ut: 'Staff' },
      { name: 'Primary Wing', ut: 'Teacher' },
      { name: 'Secondary Wing', ut: 'Teacher' },
      { name: 'Accounts & Finance', ut: 'Staff' },
      { name: 'Transport & Fleet', ut: 'Transport Crew' },
      { name: 'Students Wing', ut: 'Student' }
    ];
    const deptMap = {};
    for (const d of deptsToEnsure) {
      const [existing] = await conn.query('SELECT id FROM campusone_cug.departments WHERE institution_id = 4 AND name = ?', [d.name]);
      if (existing.length) {
        deptMap[d.name] = existing[0].id;
      } else {
        const utId = userTypeMap[d.ut] || userTypeMap['Staff'];
        const [res] = await conn.query('INSERT INTO campusone_cug.departments (public_id, institution_id, user_type_id, name) VALUES (?, 4, ?, ?)', [newPublicId(), utId, d.name]);
        deptMap[d.name] = res.insertId;
      }
    }

    // 4. Periods (Bell Schedule: 8 Periods + 2 Breaks)
    console.log('⏰ Configuring Bell Schedule & Periods...');
    await conn.query('DELETE FROM campusone_cug.periods WHERE institution_id = 4');
    const periodsConfig = [
      { name: 'Period 1', starts_at: '08:30:00', ends_at: '09:15:00', is_break: 0 },
      { name: 'Period 2', starts_at: '09:15:00', ends_at: '10:00:00', is_break: 0 },
      { name: 'Period 3', starts_at: '10:00:00', ends_at: '10:45:00', is_break: 0 },
      { name: 'Short Break', starts_at: '10:45:00', ends_at: '11:00:00', is_break: 1 },
      { name: 'Period 4', starts_at: '11:00:00', ends_at: '11:45:00', is_break: 0 },
      { name: 'Period 5', starts_at: '11:45:00', ends_at: '12:30:00', is_break: 0 },
      { name: 'Lunch Break', starts_at: '12:30:00', ends_at: '13:10:00', is_break: 1 },
      { name: 'Period 6', starts_at: '13:10:00', ends_at: '13:50:00', is_break: 0 },
      { name: 'Period 7', starts_at: '13:50:00', ends_at: '14:30:00', is_break: 0 },
      { name: 'Period 8', starts_at: '14:30:00', ends_at: '15:10:00', is_break: 0 },
    ];
    const periodIds = [];
    const teachingPeriodIds = [];
    for (const p of periodsConfig) {
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.periods (public_id, institution_id, name, starts_at, ends_at, is_break) VALUES (?, 4, ?, ?, ?, ?)',
        [newPublicId(), p.name, p.starts_at, p.ends_at, p.is_break]
      );
      periodIds.push(res.insertId);
      if (!p.is_break) teachingPeriodIds.push(res.insertId);
    }

    // 5. Subjects
    console.log('📚 Setting up 8 Standard Subjects...');
    await conn.query('DELETE FROM campusone_cug.class_subjects WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.subjects WHERE institution_id = 4');
    const subjectsConfig = [
      { code: 'ENG', name: 'English', colour: '#2563EB' },
      { code: 'HIN', name: 'Hindi', colour: '#DC2626' },
      { code: 'MAR', name: 'Marathi', colour: '#D97706' },
      { code: 'MATH', name: 'Mathematics', colour: '#059669' },
      { code: 'SCI', name: 'Science & EVS', colour: '#0891B2' },
      { code: 'SST', name: 'Social Studies', colour: '#7C3AED' },
      { code: 'COMP', name: 'Computer Science', colour: '#DB2777' },
      { code: 'PE', name: 'Physical Education', colour: '#0D9488' },
    ];
    const subjectMap = {};
    const subjectIds = [];
    for (const s of subjectsConfig) {
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.subjects (public_id, institution_id, code, name, colour, created_at, updated_at) VALUES (?, 4, ?, ?, ?, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), s.code, s.name, s.colour]
      );
      subjectMap[s.code] = res.insertId;
      subjectIds.push(res.insertId);
    }

    // 6. 13 Classes & 26 Sections (Nursery to 10th Standard)
    console.log('🏫 Creating 13 Classes (Nursery to Class 10) & 26 Sections (A & B)...');
    // Clear old classes/sections for institution 4
    await conn.query('DELETE FROM campusone_cug.sections WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.classes WHERE institution_id = 4');

    const classNames = [
      'Nursery', 'LKG', 'UKG',
      'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5',
      'Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10'
    ];
    const classList = []; // { id, name, order, sections: [ { id, name } ] }

    for (let i = 0; i < classNames.length; i++) {
      const cName = classNames[i];
      const sortOrder = i + 1;
      const [cRes] = await conn.query(
        'INSERT INTO campusone_cug.classes (public_id, institution_id, name, sort_order) VALUES (?, 4, ?, ?)',
        [newPublicId(), cName, sortOrder]
      );
      const cId = cRes.insertId;

      // Map subjects to class
      for (const sId of subjectIds) {
        await conn.query('INSERT INTO campusone_cug.class_subjects (institution_id, class_id, subject_id) VALUES (4, ?, ?)', [cId, sId]);
      }

      // Add Section A and Section B
      const sections = [];
      for (const sLetter of ['A', 'B']) {
        const [sRes] = await conn.query(
          'INSERT INTO campusone_cug.sections (public_id, institution_id, class_id, name, capacity) VALUES (?, 4, ?, ?, 45)',
          [newPublicId(), cId, sLetter]
        );
        sections.push({ id: sRes.insertId, name: sLetter });
      }

      classList.push({ id: cId, name: cName, order: sortOrder, sections });
    }

    // Helper to create Account + Credential + MemberProfile + Role
    const allExportAccounts = []; // To collect for Excel export

    async function createAccountWithRole({
      mobile, email, firstName, lastName, userTypeId, deptId, roleCode, employeeNo, details
    }) {
      // 1. Platform Account
      let accountId;
      const [existingAccts] = await conn.query('SELECT id FROM campusone.platform_accounts WHERE email = ? OR mobile = ?', [email, mobile]);
      if (existingAccts.length) {
        accountId = existingAccts[0].id;
        await conn.query('UPDATE campusone.platform_accounts SET public_id = ?, email = ?, mobile = ?, first_name = ?, last_name = ?, status = "ACTIVE" WHERE id = ?',
          [newPublicId(), email, mobile, firstName, lastName, accountId]
        );
      } else {
        const [res] = await conn.query(
          'INSERT INTO campusone.platform_accounts (public_id, mobile, email, first_name, last_name, status, kyc_level, txn_permission) VALUES (?, ?, ?, ?, ?, "ACTIVE", "MIN", 1)',
          [newPublicId(), mobile, email, firstName, lastName]
        );
        accountId = res.insertId;
      }

      // 2. Credential (Password Hello@123)
      const [existingCreds] = await conn.query('SELECT id FROM campusone.account_credentials WHERE account_id = ? AND kind = "PASSWORD"', [accountId]);
      if (existingCreds.length) {
        await conn.query('UPDATE campusone.account_credentials SET hash = ?, must_change = 0 WHERE id = ?', [ARGON2_HASH, existingCreds[0].id]);
      } else {
        await conn.query(
          'INSERT INTO campusone.account_credentials (account_id, kind, hash, must_change) VALUES (?, "PASSWORD", ?, 0)',
          [accountId, ARGON2_HASH]
        );
      }

      // 3. Member Profile
      let profileId;
      const [existingProf] = await conn.query('SELECT id FROM campusone_cug.member_profiles WHERE institution_id = 4 AND account_id = ?', [accountId]);
      if (existingProf.length) {
        profileId = existingProf[0].id;
        await conn.query(
          'UPDATE campusone_cug.member_profiles SET public_id = ?, first_name = ?, last_name = ?, contact_mobile = ?, contact_email = ?, employee_no = ?, user_type_id = ?, department_id = ?, status = "ACTIVE" WHERE id = ?',
          [newPublicId(), firstName, lastName, mobile, email, employeeNo || null, userTypeId, deptId || null, profileId]
        );
      } else {
        const [res] = await conn.query(
          'INSERT INTO campusone_cug.member_profiles (public_id, institution_id, account_id, user_type_id, department_id, first_name, last_name, contact_mobile, contact_email, employee_no, status, txn_permission) VALUES (?, 4, ?, ?, ?, ?, ?, ?, ?, ?, "ACTIVE", 1)',
          [newPublicId(), accountId, userTypeId, deptId || null, firstName, lastName, mobile, email, employeeNo || null]
        );
        profileId = res.insertId;
      }

      // 4. Role Mapping
      if (roleCode) {
        const [roleRows] = await conn.query('SELECT id FROM campusone.roles WHERE code = ?', [roleCode]);
        if (roleRows.length) {
          const rId = roleRows[0].id;
          const [hasRole] = await conn.query('SELECT * FROM campusone_cug.profile_roles WHERE institution_id = 4 AND profile_id = ? AND role_id = ?', [profileId, rId]);
          if (!hasRole.length) {
            await conn.query('INSERT INTO campusone_cug.profile_roles (institution_id, profile_id, role_id) VALUES (4, ?, ?)', [profileId, rId]);
          }
        }
      }

      allExportAccounts.push({
        Category: roleCode || 'STAFF',
        Role: roleCode || 'STAFF',
        Name: `${firstName} ${lastName || ''}`.trim(),
        Mobile: mobile,
        Email: email,
        Password: PASSWORD_PLAIN,
        Details: details || ''
      });

      return { accountId, profileId };
    }

    // 7. Key Staff Accounts
    console.log('👤 Creating Key Staff: Principal, 2 Coordinators, Accountant...');
    // A. Principal
    const principal = await createAccountWithRole({
      mobile: '9822100001',
      email: 'principal.sunrice@gmail.com',
      firstName: 'Dr. Rameshwar',
      lastName: 'Rao',
      userTypeId: userTypeMap['Principal'],
      deptId: deptMap['Administration'],
      roleCode: 'PRINCIPAL',
      employeeNo: 'EMP-PRIN-001',
      details: 'Head of Institution / Principal'
    });

    // B. Primary Coordinator (Nursery to Class 5)
    const coordPrimary = await createAccountWithRole({
      mobile: '9822100002',
      email: 'coord.primary.sunrice@gmail.com',
      firstName: 'Sunita',
      lastName: 'Deshmukh',
      userTypeId: userTypeMap['Staff'],
      deptId: deptMap['Primary Wing'],
      roleCode: 'ACADEMIC_COORDINATOR',
      employeeNo: 'EMP-COORD-001',
      details: 'Academic Coordinator (Nursery to Class 5)'
    });

    // C. Secondary Coordinator (Class 6 to Class 10)
    const coordSecondary = await createAccountWithRole({
      mobile: '9822100003',
      email: 'coord.secondary.sunrice@gmail.com',
      firstName: 'Prakash',
      lastName: 'Kulkarni',
      userTypeId: userTypeMap['Staff'],
      deptId: deptMap['Secondary Wing'],
      roleCode: 'ACADEMIC_COORDINATOR',
      employeeNo: 'EMP-COORD-002',
      details: 'Academic Coordinator (Class 6 to Class 10)'
    });

    // D. Accountant
    const accountant = await createAccountWithRole({
      mobile: '9822100004',
      email: 'accounts.sunrice@gmail.com',
      firstName: 'Vikas',
      lastName: 'Mahajan',
      userTypeId: userTypeMap['Staff'],
      deptId: deptMap['Accounts & Finance'],
      roleCode: 'ACCOUNTANT',
      employeeNo: 'EMP-ACCT-001',
      details: 'Chief Accountant & Fee In-charge'
    });

    // 8. 26 Teachers (Class Teachers for each of the 26 sections)
    console.log('👩‍🏫 Creating 26 Class & Subject Teachers...');
    await conn.query('DELETE FROM campusone_cug.teacher_assignments WHERE institution_id = 4');

    const teacherProfiles = [];
    const teacherNames = [
      ['Anjali', 'Sharma'], ['Meena', 'Verma'], ['Pooja', 'Chavan'], ['Deepa', 'Bisen'],
      ['Kavita', 'Meshram'], ['Snehal', 'Patil'], ['Rohini', 'Jadhav'], ['Shilpa', 'Wankhede'],
      ['Radhika', 'Gupta'], ['Priyanka', 'Thakur'], ['Madhuri', 'Bawankar'], ['Swati', 'Gawande'],
      ['Smita', 'Kohale'], ['Manisha', 'Rathod'], ['Aarti', 'Tiwari'], ['Neeta', 'Pandey'],
      ['Preeti', 'Mishra'], ['Sunanda', 'Dubey'], ['Pallavi', 'Saxena'], ['Gayatri', 'Sonwane'],
      ['Archana', 'Bhatt'], ['Nandini', 'Rao'], ['Aparna', 'Nair'], ['Jayashree', 'Menon'],
      ['Sadhana', 'Reddy'], ['Renuka', 'Agarwal']
    ];

    let secIdx = 0;
    for (let c of classList) {
      for (let s of c.sections) {
        const [fName, lName] = teacherNames[secIdx % teacherNames.length];
        const tNum = String(secIdx + 1).padStart(2, '0');
        const mobile = `98221000${10 + secIdx}`;
        const email = `teacher${tNum}.sunrice@gmail.com`;

        const teacher = await createAccountWithRole({
          mobile,
          email,
          firstName: fName,
          lastName: lName,
          userTypeId: userTypeMap['Teacher'],
          deptId: c.order <= 8 ? deptMap['Primary Wing'] : deptMap['Secondary Wing'],
          roleCode: 'TEACHER',
          employeeNo: `EMP-TCH-${tNum}`,
          details: `Class Teacher: ${c.name} - Section ${s.name}`
        });

        teacherProfiles.push({
          profileId: teacher.profileId,
          name: `${fName} ${lName}`,
          classId: c.id,
          sectionId: s.id,
          className: c.name,
          sectionName: s.name,
          mobile,
          email
        });

        // Assign as CLASS_TEACHER in teacher_assignments
        await conn.query(
          'INSERT INTO campusone_cug.teacher_assignments (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, section_id, created_at) VALUES (?, 4, ?, "CLASS_TEACHER", ?, ?, ?, utc_timestamp(3))',
          [newPublicId(), yearId, teacher.profileId, c.id, s.id]
        );

        // Assign subject teacher for core subjects
        for (const sCode of ['ENG', 'MATH', 'SCI']) {
          await conn.query(
            'INSERT INTO campusone_cug.teacher_assignments (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, section_id, subject_id, created_at) VALUES (?, 4, ?, "SUBJECT_TEACHER", ?, ?, ?, ?, utc_timestamp(3))',
            [newPublicId(), yearId, teacher.profileId, c.id, s.id, subjectMap[sCode]]
          );
        }

        secIdx++;
      }
    }

    // Assign Coordinators to their respective classes in teacher_assignments
    for (let c of classList) {
      if (c.order <= 8) {
        // Nursery to Class 5 -> Primary Coordinator
        await conn.query(
          'INSERT INTO campusone_cug.teacher_assignments (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, created_at) VALUES (?, 4, ?, "COORDINATOR", ?, ?, utc_timestamp(3))',
          [newPublicId(), yearId, coordPrimary.profileId, c.id]
        );
      } else {
        // Class 6 to Class 10 -> Secondary Coordinator
        await conn.query(
          'INSERT INTO campusone_cug.teacher_assignments (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, created_at) VALUES (?, 4, ?, "COORDINATOR", ?, ?, utc_timestamp(3))',
          [newPublicId(), yearId, coordSecondary.profileId, c.id]
        );
      }
    }

    // 9. Timetable Slots (Conflict-Free Scheduling across Mon-Sat)
    console.log('🗓️ Generating Conflict-Free Timetable Slots for all 26 Sections...');
    await conn.query('DELETE FROM campusone_cug.timetable_slots WHERE institution_id = 4');

    // For each section, day (1 to 6 = Mon to Sat), and period (8 teaching periods)
    // Rotate teachers to ensure no two sections have the same teacher at the same (day, period)
    const numTeachers = teacherProfiles.length; // 26
    let slotCount = 0;

    for (let sIdx = 0; sIdx < teacherProfiles.length; sIdx++) {
      const secInfo = teacherProfiles[sIdx];
      for (let day = 1; day <= 6; day++) {
        for (let pIdx = 0; pIdx < teachingPeriodIds.length; pIdx++) {
          const periodId = teachingPeriodIds[pIdx];
          // Deterministic collision-free formula for teacher assignment:
          // Teacher = (sIdx + day + pIdx) % numTeachers
          const assignedTeacherIdx = (sIdx + day * 3 + pIdx * 7) % numTeachers;
          const assignedTeacher = teacherProfiles[assignedTeacherIdx];
          const assignedSubjId = subjectIds[(sIdx + pIdx + day) % subjectIds.length];

          await conn.query(
            'INSERT INTO campusone_cug.timetable_slots (institution_id, year_id, section_id, day, period_id, subject_id, teacher_profile_id, updated_at) VALUES (4, ?, ?, ?, ?, ?, ?, utc_timestamp(3))',
            [yearId, secInfo.sectionId, day, periodId, assignedSubjId, assignedTeacher.profileId]
          );
          slotCount++;
        }
      }
    }
    console.log(`✅ Created ${slotCount} Timetable Slots!`);

    // 10. Transport Fleet: 10 Buses, 10 Drivers, 10 Attendants, 10 Routes, 20 Stops
    console.log('🚌 Configuring Transport Fleet: 10 Buses, 10 Drivers, 10 Attendants & Routes...');
    await conn.query('DELETE FROM campusone_cug.transport_allocations WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.transport_crew WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.transport_route_stops WHERE route_id IN (SELECT id FROM campusone_cug.transport_routes WHERE institution_id = 4)');
    await conn.query('DELETE FROM campusone_cug.transport_routes WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.transport_stops WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.transport_vehicles WHERE institution_id = 4');

    // 20 Stops across Nagpur
    const stopsData = [
      { name: 'Rameshwari Ring Road', landmark: 'Near Convent Gate', lat: 21.1124, lng: 79.0882 },
      { name: 'Manish Nagar T-Point', landmark: 'Opposite Domino\'s', lat: 21.0950, lng: 79.0820 },
      { name: 'Besa Square', landmark: 'Near Reliance Fresh', lat: 21.0821, lng: 79.0912 },
      { name: 'Medical Square', landmark: 'GMC Hospital Gate', lat: 21.1340, lng: 79.0980 },
      { name: 'Dhantoli Park', landmark: 'Near Yeshwant Stadium', lat: 21.1380, lng: 79.0850 },
      { name: 'Pratap Nagar Square', landmark: 'Near Orange City Hospital', lat: 21.1210, lng: 79.0560 },
      { name: 'Dharampeth Extension', landmark: 'Near Coffee House', lat: 21.1440, lng: 79.0620 },
      { name: 'Sadar Residency Road', landmark: 'Near Liberty Cinema', lat: 21.1610, lng: 79.0810 },
      { name: 'Wardhaman Nagar', landmark: 'Near Radheshyam Mandir', lat: 21.1480, lng: 79.1320 },
      { name: 'Ayodhya Nagar', landmark: 'Near Water Tank', lat: 21.1190, lng: 79.1150 },
      { name: 'Trimurti Nagar', landmark: 'NIT Garden', lat: 21.1150, lng: 79.0480 },
      { name: 'Jaitala Market', landmark: 'Near Jaitala Post Office', lat: 21.1010, lng: 79.0390 },
      { name: 'Narendra Nagar Flyover', landmark: 'Pillar No. 42', lat: 21.1080, lng: 79.0790 },
      { name: 'Somalwada Square', landmark: 'Wardha Road Corner', lat: 21.0990, lng: 79.0680 },
      { name: 'Khamla Market', landmark: 'Sindhi Hindi School Gate', lat: 21.1160, lng: 79.0650 },
      { name: 'Mankapur Sports Complex', landmark: 'Gate No. 2', lat: 21.1820, lng: 79.0840 },
      { name: 'Jaripatka Dayanand Park', landmark: 'Near Gurudwara', lat: 21.1890, lng: 79.0950 },
      { name: 'Gandhibagh Garden', landmark: 'Central Avenue', lat: 21.1520, lng: 79.1060 },
      { name: 'Mahal Gandhi Gate', landmark: 'Near Tilak Statue', lat: 21.1430, lng: 79.1120 },
      { name: 'Nandanvan Square', landmark: 'Near KDK College Road', lat: 21.1310, lng: 79.1350 }
    ];
    const stopIds = [];
    for (const st of stopsData) {
      const [res] = await conn.query(
        'INSERT INTO campusone_cug.transport_stops (public_id, institution_id, name, landmark, lat, lng, active, created_at, updated_at) VALUES (?, 4, ?, ?, ?, ?, 1, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), st.name, st.landmark, st.lat, st.lng]
      );
      stopIds.push(res.insertId);
    }

    // 10 Buses + Drivers + Attendants + Routes
    const driverNames = [
      'Suresh Rathod', 'Ganesh Jadhav', 'Manoj Wankhede', 'Rajesh Shinde', 'Dinesh Bisen',
      'Pravin Meshram', 'Nitin Bawankar', 'Sanjay Gawande', 'Ajay Dhoke', 'Kailash Kohale'
    ];
    const attendantNames = [
      'Rekha Uikey', 'Kavita Madavi', 'Shobha Tekam', 'Sunita Atram', 'Anita Gedam',
      'Sarita Pendam', 'Laxmi Kumre', 'Meena Parteti', 'Pooja Marskole', 'Usha Korwate'
    ];

    const vehicleIds = [];
    const morningRouteIds = [];
    const eveningRouteIds = [];

    for (let b = 1; b <= 10; b++) {
      const bPad = String(b).padStart(2, '0');
      const busName = `Bus ${bPad}`;
      const regNo = `MH-31-AP-10${bPad}`;

      // Insert Vehicle
      const [vRes] = await conn.query(
        'INSERT INTO campusone_cug.transport_vehicles (public_id, institution_id, name, registration, capacity, gps_enabled, active, created_at, updated_at) VALUES (?, 4, ?, ?, 45, 1, 1, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), busName, regNo]
      );
      const vId = vRes.insertId;
      vehicleIds.push(vId);

      // Driver
      const dName = driverNames[b - 1];
      const [dFirst, dLast] = dName.split(' ');
      const dMobile = `98221000${50 + b}`;
      const dEmail = `driver${bPad}.sunrice@gmail.com`;
      const driverAcc = await createAccountWithRole({
        mobile: dMobile,
        email: dEmail,
        firstName: dFirst,
        lastName: dLast,
        userTypeId: userTypeMap['Transport Crew'],
        deptId: deptMap['Transport & Fleet'],
        roleCode: null,
        employeeNo: `DRV-${bPad}`,
        details: `Bus Driver: ${busName} (${regNo})`
      });

      await conn.query(
        'INSERT INTO campusone_cug.transport_crew (public_id, institution_id, profile_id, role, licence_no, employee_ref, active, created_at, updated_at) VALUES (?, 4, ?, "DRIVER", ?, ?, 1, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), driverAcc.profileId, `MH31-2015-0010${bPad}`, `DRV-${bPad}`]
      );

      // Attendant
      const aName = attendantNames[b - 1];
      const [aFirst, aLast] = aName.split(' ');
      const aMobile = `98221000${60 + b}`;
      const aEmail = `attendant${bPad}.sunrice@gmail.com`;
      const attAcc = await createAccountWithRole({
        mobile: aMobile,
        email: aEmail,
        firstName: aFirst,
        lastName: aLast,
        userTypeId: userTypeMap['Transport Crew'],
        deptId: deptMap['Transport & Fleet'],
        roleCode: null,
        employeeNo: `ATT-${bPad}`,
        details: `Bus Attendant: ${busName} (${regNo})`
      });

      await conn.query(
        'INSERT INTO campusone_cug.transport_crew (public_id, institution_id, profile_id, role, licence_no, employee_ref, active, created_at, updated_at) VALUES (?, 4, ?, "ATTENDANT", ?, ?, 1, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), attAcc.profileId, `ATT31-2018-0010${bPad}`, `ATT-${bPad}`]
      );

      // Create Morning Route
      const [mRoute] = await conn.query(
        'INSERT INTO campusone_cug.transport_routes (public_id, institution_id, code, name, description, route_type, active, created_at, updated_at) VALUES (?, 4, ?, ?, ?, "MORNING", 1, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), `R-M${bPad}`, `Morning Route ${bPad} (${busName})`, `Servicing stops for ${busName}`]
      );
      morningRouteIds.push(mRoute.insertId);

      // Create Evening Route
      const [eRoute] = await conn.query(
        'INSERT INTO campusone_cug.transport_routes (public_id, institution_id, code, name, description, route_type, active, created_at, updated_at) VALUES (?, 4, ?, ?, ?, "EVENING", 1, utc_timestamp(3), utc_timestamp(3))',
        [newPublicId(), `R-E${bPad}`, `Evening Return Route ${bPad} (${busName})`, `Return trip for ${busName}`]
      );
      eveningRouteIds.push(eRoute.insertId);

      // Connect 4 stops per route
      for (let sIdx = 0; sIdx < 4; sIdx++) {
        const stopId = stopIds[(b * 2 + sIdx) % stopIds.length];
        const mTotalMin = 7 * 60 + 15 + sIdx * 12;
        const mArr = `${String(Math.floor(mTotalMin / 60)).padStart(2, '0')}:${String(mTotalMin % 60).padStart(2, '0')}:00`;
        const mDep = `${String(Math.floor((mTotalMin + 2) / 60)).padStart(2, '0')}:${String((mTotalMin + 2) % 60).padStart(2, '0')}:00`;

        const eTotalMin = 15 * 60 + 15 + sIdx * 12;
        const eArr = `${String(Math.floor(eTotalMin / 60)).padStart(2, '0')}:${String(eTotalMin % 60).padStart(2, '0')}:00`;
        const eDep = `${String(Math.floor((eTotalMin + 2) / 60)).padStart(2, '0')}:${String((eTotalMin + 2) % 60).padStart(2, '0')}:00`;

        await conn.query(
          'INSERT INTO campusone_cug.transport_route_stops (route_id, seq, stop_id, arrival, departure, distance_km) VALUES (?, ?, ?, ?, ?, ?)',
          [mRoute.insertId, sIdx + 1, stopId, mArr, mDep, 3.5 * (sIdx + 1)]
        );
        await conn.query(
          'INSERT INTO campusone_cug.transport_route_stops (route_id, seq, stop_id, arrival, departure, distance_km) VALUES (?, ?, ?, ?, ?, ?)',
          [eRoute.insertId, sIdx + 1, stopId, eArr, eDep, 3.5 * (sIdx + 1)]
        );
      }
    }

    // 11. 1,040 Students (40 students per Section x 26 Sections)
    console.log('🎓 Enrolling 1,040 Students (40 per Section across all 26 Sections)...');
    // Clear old enrolments for institution 4
    await conn.query('DELETE FROM campusone_cug.enrolments WHERE institution_id = 4');

    let studentGlobalSeq = 1;
    const studentProfileIds = [];

    for (let c of classList) {
      for (let s of c.sections) {
        for (let roll = 1; roll <= 40; roll++) {
          const isFemale = roll % 2 === 0;
          const fName = isFemale
            ? FIRST_NAMES_FEMALE[(studentGlobalSeq + roll) % FIRST_NAMES_FEMALE.length]
            : FIRST_NAMES_MALE[(studentGlobalSeq + roll) % FIRST_NAMES_MALE.length];
          const lName = LAST_NAMES[(studentGlobalSeq * 3 + roll) % LAST_NAMES.length];

          const seqPad = String(studentGlobalSeq).padStart(4, '0');
          const admNo = `SRC-2026-${seqPad}`;
          // Unique 10-digit mobile starting with 9
          const mobile = `9822${String(studentGlobalSeq).padStart(6, '0')}`;
          const email = `student${seqPad}.sunrice@gmail.com`;

          // Date of birth based on class order (Nursery = ~3yo, Class 10 = ~15yo)
          const birthYear = 2026 - (3 + c.order - 1);
          const dob = `${birthYear}-0${(roll % 9) + 1}-15`;

          // 1. Platform Account
          let accountId;
          const [existingAccts] = await conn.query('SELECT id FROM campusone.platform_accounts WHERE email = ? OR mobile = ?', [email, mobile]);
          if (existingAccts.length) {
            accountId = existingAccts[0].id;
            await conn.query('UPDATE campusone.platform_accounts SET public_id = ? WHERE id = ?', [newPublicId(), accountId]);
          } else {
            const [acctRes] = await conn.query(
              'INSERT INTO campusone.platform_accounts (public_id, mobile, email, first_name, last_name, status, kyc_level, txn_permission) VALUES (?, ?, ?, ?, ?, "ACTIVE", "MIN", 1)',
              [newPublicId(), mobile, email, fName, lName]
            );
            accountId = acctRes.insertId;
          }

          // 2. Credential (Password Hello@123)
          const [existingCreds] = await conn.query('SELECT id FROM campusone.account_credentials WHERE account_id = ? AND kind = "PASSWORD"', [accountId]);
          if (existingCreds.length) {
            await conn.query('UPDATE campusone.account_credentials SET hash = ?, must_change = 0 WHERE id = ?', [ARGON2_HASH, existingCreds[0].id]);
          } else {
            await conn.query(
              'INSERT INTO campusone.account_credentials (account_id, kind, hash, must_change) VALUES (?, "PASSWORD", ?, 0)',
              [accountId, ARGON2_HASH]
            );
          }

          // 3. Member Profile (trigger trg_member_profiles__wallets auto-creates wallet)
          let profileId;
          const [existingProf] = await conn.query('SELECT id FROM campusone_cug.member_profiles WHERE institution_id = 4 AND account_id = ?', [accountId]);
          if (existingProf.length) {
            profileId = existingProf[0].id;
            await conn.query('UPDATE campusone_cug.member_profiles SET public_id = ? WHERE id = ?', [newPublicId(), profileId]);
          } else {
            const [profRes] = await conn.query(
              'INSERT INTO campusone_cug.member_profiles (public_id, institution_id, account_id, user_type_id, department_id, first_name, last_name, gender, date_of_birth, contact_mobile, contact_email, admission_no, status, txn_permission) VALUES (?, 4, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "ACTIVE", 1)',
              [newPublicId(), accountId, userTypeMap['Student'], deptMap['Academics'], fName, lName, isFemale ? 'FEMALE' : 'MALE', dob, mobile, email, admNo]
            );
            profileId = profRes.insertId;
          }
          studentProfileIds.push(profileId);

          // 4. Role Mapping
          const [existingRoles] = await conn.query('SELECT role_id FROM campusone_cug.profile_roles WHERE institution_id = 4 AND profile_id = ? AND role_id = 8', [profileId]);
          if (!existingRoles.length) {
            await conn.query(
              'INSERT INTO campusone_cug.profile_roles (institution_id, profile_id, role_id) VALUES (4, ?, 8)', // Student role
              [profileId]
            );
          }

          // 5. Enrolment in Class Section
          await conn.query(
            'INSERT INTO campusone_cug.enrolments (public_id, institution_id, student_profile_id, year_id, section_id, enrolled_on) VALUES (?, 4, ?, ?, ?, "2026-04-01")',
            [newPublicId(), profileId, yearId, s.id]
          );

          // 6. Transport Bus Allocation (Distribute 1,040 students evenly across 10 buses)
          const busIdx = (studentGlobalSeq - 1) % 10;
          const assignedMRoute = morningRouteIds[busIdx];
          const assignedERoute = eveningRouteIds[busIdx];
          const assignedStop = stopIds[(studentGlobalSeq + busIdx) % stopIds.length];

          // Morning bus allocation
          await conn.query(
            'INSERT INTO campusone_cug.transport_allocations (public_id, institution_id, year_id, profile_id, route_id, stop_id, effective_from, effective_to, active, created_at) VALUES (?, 4, ?, ?, ?, ?, "2026-04-01", "2027-03-31", 1, utc_timestamp(3))',
            [newPublicId(), yearId, profileId, assignedMRoute, assignedStop]
          );

          // Evening bus allocation
          await conn.query(
            'INSERT INTO campusone_cug.transport_allocations (public_id, institution_id, year_id, profile_id, route_id, stop_id, effective_from, effective_to, active, created_at) VALUES (?, 4, ?, ?, ?, ?, "2026-04-01", "2027-03-31", 1, utc_timestamp(3))',
            [newPublicId(), yearId, profileId, assignedERoute, assignedStop]
          );

          // Record for export
          allExportAccounts.push({
            Category: 'STUDENT',
            Role: 'Student',
            Name: `${fName} ${lName}`,
            Mobile: mobile,
            Email: email,
            Password: PASSWORD_PLAIN,
            Details: `Class: ${c.name} - Sec ${s.name} | Roll No: ${roll} | Adm No: ${admNo} | Bus: Bus ${String(busIdx + 1).padStart(2, '0')}`
          });

          studentGlobalSeq++;
        }
      }
    }
    console.log(`✅ Successfully Enrolled ${studentGlobalSeq - 1} Students!`);

    // 12. Homework Assignments
    console.log('📝 Creating Homework Assignments...');
    await conn.query('DELETE FROM campusone_cug.homework_students WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.homework WHERE institution_id = 4');

    const homeworkSamples = [
      {
        title: 'Mathematics: Chapter 2 Exercises 2.1 to 2.4',
        instructions: 'Complete all algebraic formula questions in your homework notebook with step-by-step proofs.',
        code: 'MATH'
      },
      {
        title: 'Science: Draw and Label Plant Cell Structure',
        instructions: 'Refer to textbook Page 48. Draw neat diagram with labels and write functions of mitochondria.',
        code: 'SCI'
      },
      {
        title: 'English: Essay on "Smart Technology in Modern Schools"',
        instructions: 'Write a 250-word essay discussing the advantages of digital campus cards and online classrooms.',
        code: 'ENG'
      }
    ];

    for (let c of classList.slice(3)) { // Class 1 to Class 10
      for (let s of c.sections) {
        for (const hw of homeworkSamples) {
          const teacher = teacherProfiles.find(t => t.classId === c.id && t.sectionId === s.id) || teacherProfiles[0];
          const [hwRes] = await conn.query(
            'INSERT INTO campusone_cug.homework (public_id, institution_id, year_id, class_id, section_id, subject_id, teacher_profile_id, kind, title, instructions, due_at, whole_class, created_at, updated_at) VALUES (?, 4, ?, ?, ?, ?, ?, "HOMEWORK", ?, ?, DATE_ADD(NOW(), INTERVAL 3 DAY), 1, utc_timestamp(3), utc_timestamp(3))',
            [newPublicId(), yearId, c.id, s.id, subjectMap[hw.code], teacher.profileId, hw.title, hw.instructions]
          );
          const hwId = hwRes.insertId;

          // Fetch student profiles of this section to insert into homework_students
          const [enrolled] = await conn.query(
            'SELECT student_profile_id FROM campusone_cug.enrolments WHERE institution_id = 4 AND section_id = ? LIMIT 10',
            [s.id]
          );
          for (const st of enrolled) {
            await conn.query(
              'INSERT INTO campusone_cug.homework_students (homework_id, student_profile_id, institution_id, year_id, status, updated_at) VALUES (?, ?, 4, ?, "NEW", utc_timestamp(3))',
              [hwId, st.student_profile_id, yearId]
            );
          }
        }
      }
    }

    // 13. Exams & Marks (Mid-Term Examination 2026)
    console.log('📊 Setting up Mid-Term Exams & Marks...');
    await conn.query('DELETE FROM campusone_cug.marks WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.exams WHERE institution_id = 4');
    await conn.query('DELETE FROM campusone_cug.exam_names WHERE institution_id = 4');

    const [exNameRes] = await conn.query(
      'INSERT INTO campusone_cug.exam_names (public_id, institution_id, name, created_at) VALUES (?, 4, "Mid-Term Examination 2026", utc_timestamp(3))',
      [newPublicId()]
    );
    const examNameId = exNameRes.insertId;

    // Create exams for Classes 1 to 10
    for (let c of classList.slice(3, 8)) { // Sample classes for marks
      for (let s of c.sections) {
        for (const sCode of ['MATH', 'ENG', 'SCI']) {
          const [exRes] = await conn.query(
            'INSERT INTO campusone_cug.exams (public_id, institution_id, year_id, exam_name_id, class_id, section_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks, published_at, created_at, updated_at) VALUES (?, 4, ?, ?, ?, ?, ?, "2026-10-15", "09:00:00", "12:00:00", 100, 35, utc_timestamp(3), utc_timestamp(3), utc_timestamp(3))',
            [newPublicId(), yearId, examNameId, c.id, s.id, subjectMap[sCode]]
          );
          const examId = exRes.insertId;

          // Enter marks for students in this section
          const [enrolled] = await conn.query(
            'SELECT student_profile_id FROM campusone_cug.enrolments WHERE institution_id = 4 AND section_id = ?',
            [s.id]
          );
          for (let stIdx = 0; stIdx < enrolled.length; stIdx++) {
            const st = enrolled[stIdx];
            const marksVal = 55 + (stIdx * 7) % 43; // Score between 55 and 97
            await conn.query(
              'INSERT INTO campusone_cug.marks (institution_id, year_id, exam_id, student_profile_id, marks, is_absent, status, entered_at) VALUES (4, ?, ?, ?, ?, 0, "VALID", utc_timestamp(3))',
              [yearId, examId, st.student_profile_id, marksVal]
            );
          }
        }
      }
    }

    // 14. 1 Filled Admission Application
    console.log('📋 Creating Sample Admission Application (Aarav Sharma)...');
    await conn.query('DELETE FROM campusone_cug.admission_applications WHERE institution_id = 4');
    const class1 = classList.find(c => c.name === 'Class 1');
    await conn.query(
      `INSERT INTO campusone_cug.admission_applications (
        public_id, institution_id, application_no, source, status, year_id, class_id, section_id,
        mid_term, joining_date, first_name, middle_name, last_name, gender, dob,
        primary_name, primary_relation, primary_mobile, primary_email,
        data, step, payment_status, created_at, updated_at
      ) VALUES (
        ?, 4, "APP-SRC-2026-0001", "PUBLIC", "SUBMITTED", ?, ?, ?,
        0, "2026-06-15", "Aarav", "Rajesh", "Sharma", "MALE", "2020-05-12",
        "Rajesh Sharma", "FATHER", "9822199999", "rajesh.sharma.parent@gmail.com",
        JSON_OBJECT("previousSchool", "Little Angels Play School", "bloodGroup", "B+", "address", "Plot 45, Rameshwari, Nagpur"),
        1, "CONFIRMED", utc_timestamp(3), utc_timestamp(3)
      )`,
      [newPublicId(), yearId, class1.id, class1.sections[0].id]
    );

    // 15. Export Excel File (.xlsx) & CSV File
    console.log('📊 Generating Master Directory Excel & CSV Files...');
    const outDir = 'D:\\Personal Project\\CampusOne';
    const csvPath = path.join(outDir, 'Sun_Rice_Convent_Master_Directory.csv');
    const xlsxPath = path.join(outDir, 'Sun_Rice_Convent_Master_Directory.xlsx');

    // Create CSV
    const csvHeaders = ['S.No', 'Category', 'Role', 'Full Name', 'Mobile Number', 'Email Address', 'Default Password', 'Details / Class / Bus'];
    const csvRows = [csvHeaders.join(',')];

    allExportAccounts.forEach((acc, idx) => {
      const row = [
        idx + 1,
        `"${acc.Category}"`,
        `"${acc.Role}"`,
        `"${acc.Name}"`,
        `"${acc.Mobile}"`,
        `"${acc.Email}"`,
        `"${acc.Password}"`,
        `"${acc.Details}"`
      ];
      csvRows.push(row.join(','));
    });
    // Write UTF-8 BOM + CSV so Excel opens it with perfect characters
    fs.writeFileSync(csvPath, '\uFEFF' + csvRows.join('\n'), 'utf8');
    console.log(`✅ CSV File Written: ${csvPath}`);

    // Create Excel Workbook with multiple sheets
    const wb = XLSX.utils.book_new();

    // Sheet 1: Master All Accounts
    const wsAll = XLSX.utils.json_to_sheet(allExportAccounts);
    XLSX.utils.book_append_sheet(wb, wsAll, 'All Accounts');

    // Sheet 2: Staff & Administration
    const staffAccounts = allExportAccounts.filter(a => a.Category !== 'STUDENT');
    const wsStaff = XLSX.utils.json_to_sheet(staffAccounts);
    XLSX.utils.book_append_sheet(wb, wsStaff, 'Staff & Crew');

    // Sheet 3: Students
    const studentAccounts = allExportAccounts.filter(a => a.Category === 'STUDENT');
    const wsStudents = XLSX.utils.json_to_sheet(studentAccounts);
    XLSX.utils.book_append_sheet(wb, wsStudents, '1040 Students');

    XLSX.writeFile(wb, xlsxPath);
    console.log(`✅ Excel File Written: ${xlsxPath}`);

    console.log('\n🎉 ALL DONE! Sun Rice Convent is 100% Seeded with:');
    console.log(`- 13 Classes (Nursery to 10th) with Sections A & B (26 Sections)`);
    console.log(`- 1,040 Students (40 in each section) with live wallets & enrolments`);
    console.log(`- 26 Class Teachers + Subject Teachers`);
    console.log(`- 1 Principal, 2 Coordinators, 1 Accountant`);
    console.log(`- 10 Buses, 10 Drivers, 10 Attendants, 10 Morning & Evening Routes`);
    console.log(`- Timetable Slots for all sections, Homework & Mid-Term Exam Marks`);
    console.log(`- Common Password for all: ${PASSWORD_PLAIN}`);
    console.log(`- Master Directory exported to: ${xlsxPath}`);

  } catch (err) {
    console.error('❌ Error during seeding:', err);
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.end();
  }
}

seed();
