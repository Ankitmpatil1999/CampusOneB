import mysql from 'mysql2/promise';
import crypto from 'crypto';

function uuidToBin(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function randomUuid(): string {
  return crypto.randomUUID();
}

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  console.log('--- SEEDING STUDENT LEAVES FOR ALL TEACHERS & CLASSES IN PBCOE ---');

  const instId = 6;
  const yearId = 6;

  // 1. Clear old student leaves for PBCOE
  await conn.query('DELETE FROM campusone_cug.student_leaves WHERE institution_id = ?', [instId]);
  console.log('Cleared old student leaves for PBCOE.');

  // 2. Fetch all sections with active class teachers and enrolled students
  const [sections]: any = await conn.query(`
    SELECT s.id as section_id, s.name as sec_name, c.name as class_name,
           ta.teacher_profile_id, mp.first_name as teacher_first, mp.last_name as teacher_last
    FROM campusone_cug.sections s
    JOIN campusone_cug.classes c ON c.id = s.class_id
    JOIN campusone_cug.teacher_assignments ta ON ta.section_id = s.id AND ta.kind = 'CLASS_TEACHER' AND ta.year_id = ? AND ta.ended_at IS NULL
    JOIN campusone_cug.member_profiles mp ON mp.id = ta.teacher_profile_id
    WHERE c.institution_id = ?
    ORDER BY s.id
  `, [yearId, instId]);

  console.log(`Found ${sections.length} active class teacher section assignments.`);

  // 3. Fallback account for applied_by
  const [parentAccs]: any = await conn.query(`
    SELECT pa.public_id, pa.first_name, pa.last_name
    FROM campusone.platform_accounts pa
    WHERE pa.email LIKE '%pbcoe%' OR pa.email LIKE '%campusone%'
    LIMIT 20
  `);

  const reasons = [
    {
      reason: 'Suffering from acute viral fever and throat infection, doctor advised complete bed rest for 3 days.',
      days: 3,
      fromOffset: 1, // 2026-11-20
      status: 'PENDING'
    },
    {
      reason: "Attending elder sister's wedding ceremony in Pune with family members.",
      days: 4,
      fromOffset: 4, // 2026-11-23
      status: 'PENDING'
    },
    {
      reason: 'Selected to represent PBCOE in the RTMNU Inter-Collegiate Badminton Tournament at Subhedar Hall.',
      days: 2,
      fromOffset: 2, // 2026-11-21
      status: 'PENDING'
    },
    {
      reason: 'Family emergency: Grandfather critically ill and admitted to hospital in Amravati.',
      days: 3,
      fromOffset: 0, // 2026-11-19
      status: 'PENDING'
    },
    {
      reason: 'Severe food poisoning and dehydration, under medical supervision with IV drips.',
      days: 2,
      fromOffset: -9, // 2026-11-10
      status: 'APPROVED',
      remarks: 'Approved. Get well soon and submit medical certificate upon resumption.'
    },
    {
      reason: 'Participated in State-level Smart India Hackathon zonal round held at COEP Pune.',
      days: 3,
      fromOffset: -14, // 2026-11-05
      status: 'APPROVED',
      remarks: 'Approved on college duty quota. Certificates verified with HOD.'
    },
    {
      reason: 'Dental surgery and root canal procedure scheduled at Government Dental College Nagpur.',
      days: 1,
      fromOffset: -7, // 2026-11-12
      status: 'APPROVED',
      remarks: 'Approved for 1 day as per clinic appointment slip.'
    },
    {
      reason: 'Home town travel for passport document verification and biometric appointment at RPO Nagpur.',
      days: 1,
      fromOffset: -12, // 2026-11-07
      status: 'APPROVED',
      remarks: 'Approved. Complete missed experiments during remedial practical slot.'
    },
    {
      reason: 'Personal outing with friends to Tadoba Tiger Reserve over extended weekend.',
      days: 2,
      fromOffset: -10, // 2026-11-09
      status: 'REJECTED',
      remarks: 'Attendance is currently below mandatory 75% university rule. Casual leave rejected.'
    },
    {
      reason: 'Requesting leave during ongoing mid-semester sessional examinations for family function.',
      days: 2,
      fromOffset: -5, // 2026-11-14
      status: 'REJECTED',
      remarks: 'Leave cannot be granted during mid-term examination week as per academic policy.'
    }
  ];

  let totalLeavesSeeded = 0;

  for (const sec of sections) {
    const [students]: any = await conn.query(`
      SELECT e.student_profile_id, mp.first_name, mp.last_name, mp.admission_no, mp.account_id, pa.public_id as acc_pub_id
      FROM campusone_cug.enrolments e
      JOIN campusone_cug.member_profiles mp ON mp.id = e.student_profile_id
      LEFT JOIN campusone.platform_accounts pa ON pa.id = mp.account_id
      WHERE e.section_id = ? AND e.year_id = ?
      ORDER BY mp.first_name, mp.last_name
    `, [sec.section_id, yearId]);

    if (students.length === 0) continue;

    // Decide how many leaves to seed for this section:
    // For Sneha Verma (127), seed 10 leaves!
    // For Dean (125), Coordinator (126), HOD CSE (128), IT (134, 135), seed 6-8 leaves!
    // For other classes, seed 3-5 leaves!
    let countToSeed = 5;
    if (sec.section_id === 127) countToSeed = 10;
    else if ([125, 126, 128, 134, 135].includes(sec.section_id)) countToSeed = 8;
    else if (students.length < 5) countToSeed = Math.min(students.length, 3);

    for (let i = 0; i < countToSeed; i++) {
      const student = students[i % students.length];
      const r = reasons[i % reasons.length];

      // Calculate dates around 2026-11-19
      const baseDate = new Date(2026, 10, 19); // November 19, 2026
      const fromDateObj = new Date(baseDate.getTime() + r.fromOffset * 86400000);
      const toDateObj = new Date(fromDateObj.getTime() + (r.days - 1) * 86400000);

      const fromDateStr = fromDateObj.toISOString().split('T')[0];
      const toDateStr = toDateObj.toISOString().split('T')[0];

      const appliedBy = student.acc_pub_id || parentAccs[i % parentAccs.length].public_id;
      const appliedAtObj = new Date(fromDateObj.getTime() - 2 * 86400000); // 2 days before leave

      const decidedBy = r.status !== 'PENDING' ? sec.teacher_profile_id : null;
      const decidedAt = r.status !== 'PENDING' ? new Date(fromDateObj.getTime() - 1 * 86400000) : null;
      const remarks = r.status !== 'PENDING' ? r.remarks : null;

      await conn.query(`
        INSERT INTO campusone_cug.student_leaves
          (public_id, institution_id, year_id, student_profile_id, section_id,
           from_date, to_date, school_days, reason, file_id, applied_by,
           status, decided_by_profile_id, decided_at, remarks, created_at, row_version)
        VALUES
          (UUID_TO_BIN(UUID()), ?, ?, ?, ?,
           ?, ?, ?, ?, NULL, ?,
           ?, ?, ?, ?, ?, 1)
      `, [
        instId, yearId, student.student_profile_id, sec.section_id,
        fromDateStr, toDateStr, r.days, r.reason, appliedBy,
        r.status, decidedBy, decidedAt, remarks, appliedAtObj
      ]);

      totalLeavesSeeded++;
    }

    console.log(`Seeded ${countToSeed} leaves for Section ${sec.section_id} (${sec.class_name}) - Class Teacher: ${sec.teacher_first} ${sec.teacher_last}`);
  }

  console.log(`\n--- ALL STUDENT LEAVES SEEDED SUCCESSFULLY! Total: ${totalLeavesSeeded} ---`);
  await conn.end();
}

main().catch(console.error);
