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
  console.log('--- SEEDING FEE RECORDS FOR ALL PBCOE ENROLLED STUDENTS (BATCHED) ---');

  const instId = 6;
  const yearId = 6;
  const versionId = 5;

  // Clean any partially inserted records from the interrupted run
  const [partial]: any = await conn.query(`
    SELECT fr.id FROM campusone_cug.fee_records fr
    LEFT JOIN campusone_cug.fee_record_heads frh ON frh.record_id = fr.id
    WHERE fr.institution_id = ? AND frh.record_id IS NULL
  `, [instId]);
  if (partial.length > 0) {
    const pIds = partial.map((p: any) => p.id);
    await conn.query(`DELETE FROM campusone_cug.fee_collections WHERE record_id IN (?)`, [pIds]);
    await conn.query(`DELETE FROM campusone_cug.fee_records WHERE id IN (?)`, [pIds]);
  }

  // Get enrolled students without fee records
  const [students]: any = await conn.query(`
    SELECT DISTINCT mp.id, mp.first_name, mp.last_name, mp.admission_no
    FROM campusone_cug.enrolments e
    JOIN campusone_cug.member_profiles mp ON mp.id = e.student_profile_id
    LEFT JOIN campusone_cug.fee_records fr ON fr.student_profile_id = mp.id AND fr.year_id = ?
    WHERE e.year_id = ? AND fr.id IS NULL
    ORDER BY mp.id
  `, [yearId, yearId]);

  console.log(`Found ${students.length} students without fee records to seed.`);

  if (students.length === 0) {
    console.log('All students already have fee records!');
    await conn.end();
    return;
  }

  // Get max existing receipt number
  const [maxRcpt]: any = await conn.query(`
    SELECT MAX(CAST(SUBSTRING(receipt_no, 14) AS UNSIGNED)) as max_num
    FROM campusone_cug.fee_collections
    WHERE institution_id = ? AND receipt_no LIKE 'REC-PBCOE-26-%'
  `, [instId]);
  let receiptSeq = (maxRcpt[0]?.max_num || 100) + 1;

  const inst1Heads = [
    { headId: 8, name: 'Tuition Fee', amount: 3500000 },
    { headId: 9, name: 'Development Fee', amount: 1000000 },
    { headId: 10, name: 'University & Exam Fee', amount: 500000 },
    { headId: 12, name: 'Lab & Workshop Fee', amount: 500000 },
    { headId: 13, name: 'Library & Digital Fee', amount: 300000 },
    { headId: 14, name: 'Sports & Gymkhana Fee', amount: 200000 },
  ]; // Total 6000000 (₹60,000)

  const inst2Heads = [
    { headId: 8, name: 'Tuition Fee', amount: 2000000 },
    { headId: 9, name: 'Development Fee', amount: 500000 },
    { headId: 10, name: 'University & Exam Fee', amount: 300000 },
    { headId: 12, name: 'Lab & Workshop Fee', amount: 400000 },
    { headId: 13, name: 'Library & Digital Fee', amount: 200000 },
    { headId: 14, name: 'Sports & Gymkhana Fee', amount: 100000 },
  ]; // Total 3500000 (₹35,000)

  const inst3Heads = [
    { headId: 8, name: 'Tuition Fee', amount: 1000000 },
    { headId: 9, name: 'Development Fee', amount: 400000 },
    { headId: 10, name: 'University & Exam Fee', amount: 300000 },
    { headId: 12, name: 'Lab & Workshop Fee', amount: 200000 },
    { headId: 13, name: 'Library & Digital Fee', amount: 100000 },
  ]; // Total 2000000 (₹20,000)

  // Process in chunks of 50 students
  const chunkSize = 50;
  for (let c = 0; c < students.length; c += chunkSize) {
    const chunk = students.slice(c, c + chunkSize);
    
    // Prepare fee records
    const recordInserts: any[] = [];
    const pendingPaidMap: any[] = [];

    for (let sIdx = 0; sIdx < chunk.length; sIdx++) {
      const globalIdx = c + sIdx;
      const s = chunk[sIdx];
      const isInst1Paid = (globalIdx % 10 !== 0); // 90% paid
      const isInst2Paid = isInst1Paid && (globalIdx % 3 !== 0); // ~60% paid
      const isInst1Overdue = !isInst1Paid && (globalIdx % 2 === 0);

      const r1Uuid = randomUuid();
      const r2Uuid = randomUuid();
      const r3Uuid = randomUuid();

      recordInserts.push([
        uuidToBin(r1Uuid), instId, yearId, s.id, 'STRUCTURE', versionId,
        1, '1st Term Admission Fee', '2026-07-10', 6000000, 0, 0,
        isInst1Paid ? 6000000 : 0,
        isInst1Paid ? 'PAID' : (isInst1Overdue ? 'OVERDUE' : 'DUE'),
        0, 1, new Date(), new Date()
      ]);
      pendingPaidMap.push({
        uuid: r1Uuid,
        student: s,
        seq: 1,
        paid: isInst1Paid,
        amount: 6000000,
        date: new Date(2026, 6, 10 + (globalIdx % 20), 10, 30, 0)
      });

      recordInserts.push([
        uuidToBin(r2Uuid), instId, yearId, s.id, 'STRUCTURE', versionId,
        2, '2nd Term Mid-Semester Fee', '2026-10-15', 3500000, 0, 0,
        isInst2Paid ? 3500000 : 0,
        isInst2Paid ? 'PAID' : 'DUE',
        0, 1, new Date(), new Date()
      ]);
      pendingPaidMap.push({
        uuid: r2Uuid,
        student: s,
        seq: 2,
        paid: isInst2Paid,
        amount: 3500000,
        date: new Date(2026, 9, 12 + (globalIdx % 15), 11, 45, 0)
      });

      recordInserts.push([
        uuidToBin(r3Uuid), instId, yearId, s.id, 'STRUCTURE', versionId,
        3, '3rd Term Exam & Final Fee', '2027-02-10', 2000000, 0, 0,
        0, 'DUE',
        0, 1, new Date(), new Date()
      ]);
      pendingPaidMap.push({
        uuid: r3Uuid,
        student: s,
        seq: 3,
        paid: false,
        amount: 2000000
      });
    }

    await conn.query(`
      INSERT INTO campusone_cug.fee_records
        (public_id, institution_id, year_id, student_profile_id, source, version_id,
         instalment_seq, label, due_date, amount_paise, late_fine_paise, fine_applied,
         paid_paise, status, financed, row_version, created_at, updated_at)
      VALUES ?
    `, [recordInserts]);

    // Query back the IDs by public_id
    const uuids = pendingPaidMap.map(p => uuidToBin(p.uuid));
    const [insertedRows]: any = await conn.query(`
      SELECT id, public_id FROM campusone_cug.fee_records WHERE public_id IN (?)
    `, [uuids]);
    const idMap = new Map<string, number>();
    for (const row of insertedRows) {
      idMap.set(row.public_id.toString('hex'), row.id);
    }

    // Now insert fee_record_heads and fee_collections
    const headInserts: any[] = [];
    const collectionInserts: any[] = [];
    const updateRecordsPaid: { id: number; paidDate: Date; receiptNo: string }[] = [];

    for (const p of pendingPaidMap) {
      const recId = idMap.get(uuidToBin(p.uuid).toString('hex'));
      if (!recId) continue;

      let heads = inst1Heads;
      if (p.seq === 2) heads = inst2Heads;
      if (p.seq === 3) heads = inst3Heads;

      for (const h of heads) {
        headInserts.push([recId, h.headId, h.name, h.amount]);
      }

      if (p.paid) {
        const receiptNo = `REC-PBCOE-26-${String(receiptSeq++).padStart(4, '0')}`;
        const mode = (receiptSeq % 3 === 0) ? 'CASH' : (receiptSeq % 7 === 0 ? 'WALLET' : 'ONLINE');
        
        collectionInserts.push([
          uuidToBin(randomUuid()),
          instId,
          recId,
          p.amount,
          0,
          'CONSOLE',
          mode,
          receiptNo,
          `${p.student.first_name} ${p.student.last_name}`,
          'COLLECTED',
          p.date
        ]);
        updateRecordsPaid.push({ id: recId, paidDate: p.date, receiptNo });
      }
    }

    if (headInserts.length > 0) {
      await conn.query(`
        INSERT INTO campusone_cug.fee_record_heads (record_id, head_id, name, amount_paise)
        VALUES ?
      `, [headInserts]);
    }

    if (collectionInserts.length > 0) {
      await conn.query(`
        INSERT INTO campusone_cug.fee_collections
          (public_id, institution_id, record_id, amount_paise, fine_paise, source, mode, receipt_no, paid_by, status, collected_at)
        VALUES ?
      `, [collectionInserts]);
    }

    for (const u of updateRecordsPaid) {
      await conn.query(`
        UPDATE campusone_cug.fee_records
        SET paid_at = ?, paid_reference = ?
        WHERE id = ?
      `, [u.paidDate, u.receiptNo, u.id]);
    }

    process.stdout.write(`Seeded ${Math.min(c + chunkSize, students.length)} / ${students.length} students...\r`);
  }

  console.log(`\nCOMPLETED! All PBCOE students now have full fee structures, instalments, heads, and payments!`);
  await conn.end();
}

main().catch(console.error);
