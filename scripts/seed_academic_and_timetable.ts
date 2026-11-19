import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';

function uuidToBin(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

async function main() {
  const conn = await mysql.createConnection('mysql://campusone_migrator:campusone123@127.0.0.1:3306/campusone');
  console.log('Connected to MySQL database.');

  const instId = 6;
  const yearId = 6;

  // =========================================================================
  // 1. Ensure MCA classes (70, 71) have subjects mapped in class_subjects
  // =========================================================================
  const mcaSubjects = [47, 48, 49, 50, 52, 53]; // DSA, DBMS, OS, Networks, OOP, AI
  for (const classId of [70, 71]) {
    for (const subId of mcaSubjects) {
      await conn.query(`
        INSERT IGNORE INTO campusone_cug.class_subjects (institution_id, class_id, subject_id)
        VALUES (?, ?, ?)
      `, [instId, classId, subId]);
    }
  }
  console.log('Mapped subjects for MCA classes (70, 71).');

  // =========================================================================
  // 2. Ensure all sections have a CLASS_TEACHER in teacher_assignments
  // =========================================================================
  const [allSections]: any = await conn.query(`
    SELECT s.id, s.class_id, s.name as sec_name, c.name as class_name
    FROM campusone_cug.sections s
    JOIN campusone_cug.classes c ON c.id = s.class_id
    WHERE s.institution_id = ?
    ORDER BY s.id
  `, [instId]);

  const [existingClassTeachers]: any = await conn.query(`
    SELECT section_id FROM campusone_cug.teacher_assignments 
    WHERE institution_id = ? AND kind = 'CLASS_TEACHER' AND ended_at IS NULL
  `, [instId]);
  const coveredSectionIds = new Set(existingClassTeachers.map((r: any) => r.section_id));

  // Faculty pool for remaining sections:
  const backupTeachers = [1232, 1112, 1113, 1118, 1115, 1230, 1231, 1229];
  let bIdx = 0;

  for (const s of allSections) {
    if (!coveredSectionIds.has(s.id)) {
      const teacherProfileId = backupTeachers[bIdx % backupTeachers.length];
      bIdx++;
      const pubId = uuidToBin(uuidv4());
      await conn.query(`
        INSERT INTO campusone_cug.teacher_assignments
          (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, section_id, subject_id, created_at)
        VALUES
          (?, ?, ?, 'CLASS_TEACHER', ?, ?, ?, NULL, NOW())
      `, [pubId, instId, yearId, teacherProfileId, s.class_id, s.id]);
      console.log(`Assigned Class Teacher (profile ${teacherProfileId}) to section ${s.id} (${s.class_name} ${s.sec_name})`);
    }
  }

  // =========================================================================
  // 3. Ensure 100% SUBJECT_TEACHER coverage for all (section, subject) pairs
  // =========================================================================
  const [secSubjects]: any = await conn.query(`
    SELECT s.id as section_id, s.class_id, cs.subject_id, sub.code, sub.name as subject_name
    FROM campusone_cug.sections s
    JOIN campusone_cug.classes c ON c.id = s.class_id
    JOIN campusone_cug.class_subjects cs ON cs.class_id = c.id
    JOIN campusone_cug.subjects sub ON sub.id = cs.subject_id
    WHERE s.institution_id = ?
    ORDER BY s.id, cs.subject_id
  `, [instId]);

  const [existingSubTeachers]: any = await conn.query(`
    SELECT section_id, subject_id FROM campusone_cug.teacher_assignments
    WHERE institution_id = ? AND kind = 'SUBJECT_TEACHER' AND ended_at IS NULL
  `, [instId]);
  const coveredSubSet = new Set(existingSubTeachers.map((r: any) => `${r.section_id}:${r.subject_id}`));

  // Teachers by subject prefix:
  const deptTeachers: Record<string, number[]> = {
    'CS': [1112, 1116, 1229, 1232], // Kalpana, Sneha, Amit C, Rajesh
    'IT': [1230, 1231, 1229],       // Priya, Rahul, Amit C
    'AD': [1113, 1117],             // Sachin, Amit S
    'ME': [1115, 1119],             // Sanjay, Nilesh
    'EE': [1233, 1234],             // Praveen, Swati
    'EC': [1114, 1118],             // Tanmay, Pooja
    'CV': [1235, 1236],             // Ritesh, Vaibhav
  };

  let newAssignedCount = 0;
  for (const ss of secSubjects) {
    const key = `${ss.section_id}:${ss.subject_id}`;
    if (!coveredSubSet.has(key)) {
      const pfx = ss.code.substring(0, 2);
      const pool = deptTeachers[pfx] || deptTeachers['CS'];
      const teacherProfileId = pool[(ss.section_id + ss.subject_id) % pool.length];
      const pubId = uuidToBin(uuidv4());
      
      await conn.query(`
        INSERT INTO campusone_cug.teacher_assignments
          (public_id, institution_id, year_id, kind, teacher_profile_id, class_id, section_id, subject_id, created_at)
        VALUES
          (?, ?, ?, 'SUBJECT_TEACHER', ?, ?, ?, ?, NOW())
      `, [pubId, instId, yearId, teacherProfileId, ss.class_id, ss.section_id, ss.subject_id]);
      newAssignedCount++;
    }
  }
  console.log(`Added ${newAssignedCount} missing SUBJECT_TEACHER assignments. All (section, subject) pairs now covered!`);

  // =========================================================================
  // 4. Create Standard Periods for PBCOE in `periods` table
  // =========================================================================
  const [existingPeriods]: any = await conn.query('SELECT * FROM campusone_cug.periods WHERE institution_id = ? ORDER BY starts_at', [instId]);
  let periodList = existingPeriods;

  if (periodList.length === 0) {
    console.log('Creating standard college periods for PBCOE...');
    const periodDefs = [
      { name: 'Period 1', starts_at: '09:00:00', ends_at: '09:50:00', is_break: 0 },
      { name: 'Period 2', starts_at: '09:50:00', ends_at: '10:40:00', is_break: 0 },
      { name: 'Period 3', starts_at: '10:40:00', ends_at: '11:30:00', is_break: 0 },
      { name: 'Morning Break', starts_at: '11:30:00', ends_at: '11:45:00', is_break: 1 },
      { name: 'Period 4', starts_at: '11:45:00', ends_at: '12:35:00', is_break: 0 },
      { name: 'Period 5', starts_at: '12:35:00', ends_at: '13:25:00', is_break: 0 },
      { name: 'Lunch Break', starts_at: '13:25:00', ends_at: '14:15:00', is_break: 1 },
      { name: 'Period 6', starts_at: '14:15:00', ends_at: '15:05:00', is_break: 0 },
      { name: 'Period 7', starts_at: '15:05:00', ends_at: '15:55:00', is_break: 0 },
    ];

    for (const p of periodDefs) {
      const pubId = uuidToBin(uuidv4());
      await conn.query(`
        INSERT INTO campusone_cug.periods (public_id, institution_id, name, starts_at, ends_at, is_break)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [pubId, instId, p.name, p.starts_at, p.ends_at, p.is_break]);
    }

    const [createdPeriods]: any = await conn.query('SELECT * FROM campusone_cug.periods WHERE institution_id = ? ORDER BY starts_at', [instId]);
    periodList = createdPeriods;
    console.log(`Created ${periodList.length} periods for PBCOE.`);
  } else {
    console.log(`PBCOE already has ${periodList.length} periods.`);
  }

  const teachingPeriods = periodList.filter((p: any) => !p.is_break);
  console.log(`Teaching periods: ${teachingPeriods.length} (out of ${periodList.length} total periods)`);

  // =========================================================================
  // 5. Generate Weekly Timetables (timetable_slots) for all sections
  // =========================================================================
  // Clear any old slots for clean generation
  await conn.query('DELETE FROM campusone_cug.timetable_slots WHERE institution_id = ? AND year_id = ?', [instId, yearId]);

  // Fetch all live (section, subject, teacher) mappings
  const [activeMappings]: any = await conn.query(`
    SELECT ta.section_id, ta.subject_id, ta.teacher_profile_id
    FROM campusone_cug.teacher_assignments ta
    WHERE ta.institution_id = ? AND ta.year_id = ? AND ta.kind = 'SUBJECT_TEACHER' AND ta.ended_at IS NULL
  `, [instId, yearId]);

  const secToTeachers = new Map<number, { subject_id: number; teacher_profile_id: number }[]>();
  for (const m of activeMappings) {
    if (!secToTeachers.has(m.section_id)) secToTeachers.set(m.section_id, []);
    secToTeachers.get(m.section_id)!.push({ subject_id: m.subject_id, teacher_profile_id: m.teacher_profile_id });
  }

  // Days: 1 (Mon) to 6 (Sat)
  const days = [1, 2, 3, 4, 5, 6];
  const timetableRows: any[] = [];
  
  // Track teacher commitments to prevent clashes: key = `${day}:${period_id}:${teacher_profile_id}`
  const teacherBusy = new Set<string>();

  for (const s of allSections) {
    const list = secToTeachers.get(s.id);
    if (!list || list.length === 0) continue;

    let subIndex = 0;
    for (const day of days) {
      for (const pd of teachingPeriods) {
        // Find a subject and teacher for this slot where teacher is not busy
        let chosen: { subject_id: number; teacher_profile_id: number } | null = null;

        for (let attempt = 0; attempt < list.length; attempt++) {
          const candidate = list[(subIndex + attempt) % list.length];
          const clashKey = `${day}:${pd.id}:${candidate.teacher_profile_id}`;
          if (!teacherBusy.has(clashKey)) {
            chosen = candidate;
            subIndex = (subIndex + attempt + 1) % list.length;
            break;
          }
        }

        if (chosen) {
          const clashKey = `${day}:${pd.id}:${chosen.teacher_profile_id}`;
          teacherBusy.add(clashKey);
          timetableRows.push([
            instId,
            yearId,
            s.id,
            day,
            pd.id,
            chosen.subject_id,
            chosen.teacher_profile_id,
            null,
            new Date()
          ]);
        }
      }
    }
  }

  console.log(`Generated ${timetableRows.length} clash-free timetable slots across all sections.`);

  // Insert in batches of 1000
  for (let i = 0; i < timetableRows.length; i += 1000) {
    const chunk = timetableRows.slice(i, i + 1000);
    await conn.query(`
      INSERT INTO campusone_cug.timetable_slots
        (institution_id, year_id, section_id, day, period_id, subject_id, teacher_profile_id, updated_by, updated_at)
      VALUES ?
    `, [chunk]);
  }
  console.log('Saved all timetable slots to database.');

  // =========================================================================
  // 6. Generate Exams & Marks
  // =========================================================================
  // Check or create Exam Names
  const [existingExamNames]: any = await conn.query('SELECT * FROM campusone_cug.exam_names WHERE institution_id = ?', [instId]);
  let midSemExamNameId = existingExamNames.find((n: any) => n.name.includes('Mid-Semester'))?.id;
  let endSemExamNameId = existingExamNames.find((n: any) => n.name.includes('End-Semester'))?.id;

  if (!midSemExamNameId) {
    const pubId = uuidToBin(uuidv4());
    const [res]: any = await conn.query(`
      INSERT INTO campusone_cug.exam_names (public_id, institution_id, name, created_at)
      VALUES (?, ?, 'Mid-Semester Winter Examination 2026', NOW())
    `, [pubId, instId]);
    midSemExamNameId = res.insertId;
  }

  if (!endSemExamNameId) {
    const pubId = uuidToBin(uuidv4());
    const [res]: any = await conn.query(`
      INSERT INTO campusone_cug.exam_names (public_id, institution_id, name, created_at)
      VALUES (?, ?, 'End-Semester University Examination 2026', NOW())
    `, [pubId, instId]);
    endSemExamNameId = res.insertId;
  }
  console.log(`Exam Names active: Mid-Sem ID = ${midSemExamNameId}, End-Sem ID = ${endSemExamNameId}`);

  // Fetch all active sections with enrolled students
  const [sectionsWithStudents]: any = await conn.query(`
    SELECT DISTINCT s.id as section_id, s.class_id, c.name as class_name, s.name as sec_name
    FROM campusone_cug.sections s
    JOIN campusone_cug.classes c ON c.id = s.class_id
    JOIN campusone_cug.enrolments en ON en.section_id = s.id AND en.year_id = ?
    WHERE s.institution_id = ?
  `, [yearId, instId]);
  console.log(`Found ${sectionsWithStudents.length} sections with enrolled students.`);

  let totalExamsCreated = 0;
  let totalMarksCreated = 0;

  for (const s of sectionsWithStudents) {
    // Get subjects for this section's class
    const [subjects]: any = await conn.query(`
      SELECT cs.subject_id, sub.code, sub.name
      FROM campusone_cug.class_subjects cs
      JOIN campusone_cug.subjects sub ON sub.id = cs.subject_id
      WHERE cs.class_id = ? AND cs.institution_id = ?
    `, [s.class_id, instId]);

    // Get enrolled students
    const [students]: any = await conn.query(`
      SELECT student_profile_id FROM campusone_cug.enrolments
      WHERE section_id = ? AND year_id = ?
    `, [s.section_id, yearId]);

    let dayOffset = 0;
    for (const sub of subjects) {
      // --- 1. Mid-Sem Exam (Published, past October 2026) ---
      const midDate = new Date('2026-10-06T00:00:00Z');
      midDate.setUTCDate(midDate.getUTCDate() + (dayOffset % 12));
      const midDateStr = midDate.toISOString().substring(0, 10);
      const midPubId = uuidToBin(uuidv4());

      // Insert or get exam (omitting generated live_key)
      await conn.query(`
        INSERT INTO campusone_cug.exams
          (public_id, institution_id, year_id, exam_name_id, class_id, section_id, subject_id,
           exam_date, start_time, end_time, max_marks, pass_marks, published_at, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, '10:00:00', '12:00:00', 50, 20, '2026-11-01 10:00:00', NOW(), NOW())
        ON DUPLICATE KEY UPDATE published_at = VALUES(published_at)
      `, [midPubId, instId, yearId, midSemExamNameId, s.class_id, s.section_id, sub.subject_id, midDateStr]);

      const [midExamRow]: any = await conn.query(`
        SELECT id FROM campusone_cug.exams 
        WHERE year_id = ? AND exam_name_id = ? AND section_id = ? AND subject_id = ? AND withdrawn_at IS NULL
      `, [yearId, midSemExamNameId, s.section_id, sub.subject_id]);
      const examId = midExamRow[0]?.id;
      totalExamsCreated++;

      // Seed marks for all enrolled students
      if (examId && students.length > 0) {
        const markRows: any[] = [];
        for (const st of students) {
          const pseudo = (st.student_profile_id * 31 + sub.subject_id * 17) % 100;
          let score: number | null = null;
          let isAbsent = 0;

          if (pseudo < 3) {
            // 3% absent
            isAbsent = 1;
            score = null;
          } else if (pseudo < 8) {
            // 5% needing support (marks 14 to 19)
            score = 14 + (pseudo % 6);
          } else if (pseudo < 30) {
            // 22% average (marks 22 to 29)
            score = 22 + (pseudo % 8);
          } else if (pseudo < 75) {
            // 45% first class (marks 30 to 41)
            score = 30 + (pseudo % 12);
          } else {
            // 25% distinction / top performer (marks 42 to 49)
            score = 42 + (pseudo % 8);
          }

          markRows.push([
            instId,
            yearId,
            examId,
            st.student_profile_id,
            score,
            isAbsent,
            'VALID',
            null,
            '2026-10-25 14:00:00',
            null,
            '2026-10-28 16:00:00'
          ]);
        }

        // Insert marks in chunks
        for (let m = 0; m < markRows.length; m += 500) {
          const mChunk = markRows.slice(m, m + 500);
          await conn.query(`
            INSERT INTO campusone_cug.marks
              (institution_id, year_id, exam_id, student_profile_id, marks, is_absent, status, entered_by, entered_at, validated_by, validated_at)
            VALUES ?
            ON DUPLICATE KEY UPDATE marks = VALUES(marks), is_absent = VALUES(is_absent), status = VALUES(status)
          `, [mChunk]);
          totalMarksCreated += mChunk.length;
        }
      }

      // --- 2. Upcoming End-Sem Exam (Scheduled in next 14 days: 2026-11-23 to 2026-12-02) ---
      const upDate = new Date('2026-11-23T00:00:00Z');
      upDate.setUTCDate(upDate.getUTCDate() + (dayOffset % 9));
      const upDateStr = upDate.toISOString().substring(0, 10);
      const upPubId = uuidToBin(uuidv4());

      await conn.query(`
        INSERT INTO campusone_cug.exams
          (public_id, institution_id, year_id, exam_name_id, class_id, section_id, subject_id,
           exam_date, start_time, end_time, max_marks, pass_marks, published_at, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, '10:00:00', '13:00:00', 100, 40, NULL, NOW(), NOW())
        ON DUPLICATE KEY UPDATE exam_date = VALUES(exam_date)
      `, [upPubId, instId, yearId, endSemExamNameId, s.class_id, s.section_id, sub.subject_id, upDateStr]);
      totalExamsCreated++;

      dayOffset++;
    }
  }

  console.log(`Successfully created ${totalExamsCreated} exams and ${totalMarksCreated} student marks.`);

  // =========================================================================
  // 7. Verification Summary
  // =========================================================================
  const [classTeachersCount]: any = await conn.query(`
    SELECT COUNT(*) as count FROM campusone_cug.teacher_assignments
    WHERE institution_id = ? AND kind = 'CLASS_TEACHER' AND ended_at IS NULL
  `, [instId]);

  const [subTeachersCount]: any = await conn.query(`
    SELECT COUNT(*) as count FROM campusone_cug.teacher_assignments
    WHERE institution_id = ? AND kind = 'SUBJECT_TEACHER' AND ended_at IS NULL
  `, [instId]);

  const [slotCount]: any = await conn.query(`
    SELECT COUNT(*) as count, COUNT(DISTINCT section_id) as sections, COUNT(DISTINCT teacher_profile_id) as teachers
    FROM campusone_cug.timetable_slots
    WHERE institution_id = ? AND year_id = ?
  `, [instId, yearId]);

  const [examCount]: any = await conn.query(`
    SELECT COUNT(*) as count, COUNT(DISTINCT section_id) as sections
    FROM campusone_cug.exams
    WHERE institution_id = ? AND year_id = ?
  `, [instId, yearId]);

  const [markCount]: any = await conn.query(`
    SELECT COUNT(*) as count, AVG(marks) as avg_mark, SUM(is_absent) as absent_count
    FROM campusone_cug.marks
    WHERE institution_id = ? AND year_id = ?
  `, [instId, yearId]);

  console.log('\n=================== ACADEMIC SEEDING VERIFICATION ===================');
  console.log(`Active Class Teachers: ${classTeachersCount[0].count} / ${allSections.length} sections`);
  console.log(`Active Subject Teachers: ${subTeachersCount[0].count}`);
  console.log(`Timetable Slots: ${slotCount[0].count} across ${slotCount[0].sections} sections and ${slotCount[0].teachers} teachers`);
  console.log(`Total Exams: ${examCount[0].count} across ${examCount[0].sections} sections`);
  console.log(`Total Marks: ${markCount[0].count} (Avg Mark: ${Number(markCount[0].avg_mark).toFixed(2)}, Absentees: ${markCount[0].absent_count})`);
  console.log('=====================================================================');

  await conn.end();
}

main().catch(console.error);
