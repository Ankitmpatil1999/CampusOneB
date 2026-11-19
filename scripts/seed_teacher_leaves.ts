import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

function uuidToBin(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

async function seedTeacherLeaves() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  
  const instId = 6;
  const yearId = 6; // 2026-2027

  // Manish Choudhari (Coordinator) account public_id
  const coordinatorPublicId = Buffer.from('01a1c199fa0a468c8912afa15d7d3222', 'hex');
  // Dean Dr. Pravin Patil profile_id
  const deanProfileId = 1109;

  // Clear any existing dummy leaves for inst 6 to ensure clean state
  await conn.query('DELETE FROM campusone_cug.staff_leaves WHERE institution_id = ?', [instId]);
  console.log('Cleared existing staff leaves for institution 6.');

  const leavesToInsert = [
    // ---------------------------------------------------------------------------------
    // Group 1: With Coordinator (Pending Review by Manish Choudhari)
    // ---------------------------------------------------------------------------------
    {
      profile_id: 1112, // Prof. Kalpana Bawankar (CSE)
      needs_coordinator: 1,
      leave_type: 'CASUAL',
      from_date: '2026-11-23',
      to_date: '2026-11-24',
      days: 2,
      reason: "Attending sister's wedding ceremony in Pune. Alternative lecture arrangement done with Prof. Sneha Verma.",
      coordinator_status: null,
      coordinator_by: null,
      coordinator_at: null,
      coordinator_remarks: null,
      final_status: null,
      final_by_profile_id: null,
      final_at: null,
      final_remarks: null,
      created_at: '2026-11-19 09:15:00',
    },
    {
      profile_id: 1230, // Prof. Priya Agrawal (IT)
      needs_coordinator: 1,
      leave_type: 'CASUAL',
      from_date: '2026-11-21',
      to_date: '2026-11-21',
      days: 1,
      reason: 'Urgent personal family matter at hometown.',
      coordinator_status: null,
      coordinator_by: null,
      coordinator_at: null,
      coordinator_remarks: null,
      final_status: null,
      final_by_profile_id: null,
      final_at: null,
      final_remarks: null,
      created_at: '2026-11-19 10:00:00',
    },
    {
      profile_id: 1114, // Prof. Tanmay Deokar (ECE)
      needs_coordinator: 1,
      leave_type: 'EARNED',
      from_date: '2026-11-25',
      to_date: '2026-11-27',
      days: 3,
      reason: 'Attending IEEE National Workshop on VLSI Circuit Design and Embedded Systems at IIT Bombay.',
      coordinator_status: null,
      coordinator_by: null,
      coordinator_at: null,
      coordinator_remarks: null,
      final_status: null,
      final_by_profile_id: null,
      final_at: null,
      final_remarks: null,
      created_at: '2026-11-19 10:30:00',
    },

    // ---------------------------------------------------------------------------------
    // Group 2: Waiting for Principal / Dean Decision (Recommended by Coordinator)
    // ---------------------------------------------------------------------------------
    {
      profile_id: 1116, // Prof. Sneha Verma (CSE)
      needs_coordinator: 1,
      leave_type: 'MEDICAL',
      from_date: '2026-11-20',
      to_date: '2026-11-22',
      days: 3,
      reason: 'Suffering from severe viral fever & throat infection. Doctor advised complete rest. Medical certificate attached.',
      coordinator_status: 'APPROVED',
      coordinator_by: coordinatorPublicId,
      coordinator_at: '2026-11-19 11:30:00',
      coordinator_remarks: 'Recommended for approval. CSE lab sessions rescheduled.',
      final_status: null,
      final_by_profile_id: null,
      final_at: null,
      final_remarks: null,
      created_at: '2026-11-19 08:45:00',
    },
    {
      profile_id: 1229, // Prof. Amit Choudhary (IT)
      needs_coordinator: 1,
      leave_type: 'EARNED',
      from_date: '2026-11-23',
      to_date: '2026-11-25',
      days: 3,
      reason: 'Paper presentation on AI & Deep Learning at AICTE Sponsored International Conference (Paper ID: ICET-2026-88).',
      coordinator_status: 'APPROVED',
      coordinator_by: coordinatorPublicId,
      coordinator_at: '2026-11-19 12:15:00',
      coordinator_remarks: 'Recommended. Official conference acceptance letter verified.',
      final_status: null,
      final_by_profile_id: null,
      final_at: null,
      final_remarks: null,
      created_at: '2026-11-19 09:00:00',
    },
    {
      profile_id: 1115, // Prof. Sanjay Mohani (Mechanical)
      needs_coordinator: 1,
      leave_type: 'CASUAL',
      from_date: '2026-11-20',
      to_date: '2026-11-21',
      days: 2,
      reason: 'Family function outstation in Wardha. Substitute classes arranged with Prof. Nilesh Raut.',
      coordinator_status: 'APPROVED',
      coordinator_by: coordinatorPublicId,
      coordinator_at: '2026-11-19 13:45:00',
      coordinator_remarks: 'Substitute lecture arrangement checked and verified. Recommended.',
      final_status: null,
      final_by_profile_id: null,
      final_at: null,
      final_remarks: null,
      created_at: '2026-11-19 10:15:00',
    },
    {
      profile_id: 1235, // Prof. Ritesh Patil (Civil)
      needs_coordinator: 0, // Directly reaches Dean/Principal
      leave_type: 'CASUAL',
      from_date: '2026-11-24',
      to_date: '2026-11-25',
      days: 2,
      reason: 'State University syllabus restructuring committee meeting as nominated departmental expert.',
      coordinator_status: null,
      coordinator_by: null,
      coordinator_at: null,
      coordinator_remarks: null,
      final_status: null,
      final_by_profile_id: null,
      final_at: null,
      final_remarks: null,
      created_at: '2026-11-19 11:00:00',
    },

    // ---------------------------------------------------------------------------------
    // Group 3: Decided / Approved by Dean (1 on leave today + 1 historical)
    // ---------------------------------------------------------------------------------
    {
      profile_id: 1113, // Prof. Sachin Upadhye (AI-DS)
      needs_coordinator: 1,
      leave_type: 'CASUAL',
      from_date: '2026-11-19', // Today!
      to_date: '2026-11-19',
      days: 1,
      reason: 'Routine medical consultation and dental appointment.',
      coordinator_status: 'APPROVED',
      coordinator_by: coordinatorPublicId,
      coordinator_at: '2026-11-18 10:30:00',
      coordinator_remarks: 'Recommended.',
      final_status: 'APPROVED',
      final_by_profile_id: deanProfileId,
      final_at: '2026-11-18 16:00:00',
      final_remarks: 'Approved by Dean Office.',
      created_at: '2026-11-18 09:00:00',
    },
    {
      profile_id: 1233, // Prof. Praveen Kothe (Electrical)
      needs_coordinator: 1,
      leave_type: 'CASUAL',
      from_date: '2026-11-10',
      to_date: '2026-11-11',
      days: 2,
      reason: 'Urgent domestic work and bank document verification.',
      coordinator_status: 'APPROVED',
      coordinator_by: coordinatorPublicId,
      coordinator_at: '2026-11-09 11:00:00',
      coordinator_remarks: 'Recommended.',
      final_status: 'APPROVED',
      final_by_profile_id: deanProfileId,
      final_at: '2026-11-09 15:30:00',
      final_remarks: 'Approved.',
      created_at: '2026-11-09 09:30:00',
    },
  ];

  for (const item of leavesToInsert) {
    const publicId = uuidToBin(randomUUID());
    await conn.query(
      `INSERT INTO campusone_cug.staff_leaves (
        public_id, institution_id, year_id, profile_id, needs_coordinator, leave_type,
        from_date, to_date, days, reason,
        coordinator_status, coordinator_by, coordinator_at, coordinator_remarks,
        final_status, final_by_profile_id, final_at, final_remarks,
        created_at, row_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        publicId,
        instId,
        yearId,
        item.profile_id,
        item.needs_coordinator,
        item.leave_type,
        item.from_date,
        item.to_date,
        item.days,
        item.reason,
        item.coordinator_status,
        item.coordinator_by,
        item.coordinator_at,
        item.coordinator_remarks,
        item.final_status,
        item.final_by_profile_id,
        item.final_at,
        item.final_remarks,
        item.created_at,
      ]
    );
  }

  console.log(`✅ Successfully inserted ${leavesToInsert.length} teacher leave requests into database.`);

  // Verify counts in DB
  const [counts]: any = await conn.query(`
    SELECT 
      SUM(final_status IS NULL AND coordinator_status IS NULL AND needs_coordinator = 1) AS with_coordinator,
      SUM(final_status IS NULL AND (coordinator_status = 'APPROVED' OR needs_coordinator = 0)) AS with_principal_or_dean,
      SUM(final_status = 'APPROVED') AS approved_leaves,
      SUM(final_status = 'APPROVED' AND from_date <= '2026-11-19' AND to_date >= '2026-11-19') AS on_leave_today
    FROM campusone_cug.staff_leaves
    WHERE institution_id = 6
  `);
  console.log('\n--- VERIFIED LEAVE STATS IN DB ---');
  console.table(counts);

  await conn.end();
}

seedTeacherLeaves().catch(console.error);
