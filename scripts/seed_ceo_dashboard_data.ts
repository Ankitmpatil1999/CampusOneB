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
  console.log('--- SEEDING COMPREHENSIVE DATA FOR CEO DASHBOARD (PBCOE) ---');

  const instId = 6;
  const adminAccount = 'e3e60183-b541-4770-b8ec-f53e6b70ad06'; // Narendra Choudhari (Principal)
  const accountantAccount = '23377dc7-37c2-4680-bc78-6511a511636c'; // Shailesh Wankhede

  // =========================================================================
  // 1. PAYMENT ATTEMPTS (LAST 10 DAYS + THIS MONTH) -> For "Collections this month" & "Collections — last 10 days" chart
  // =========================================================================
  console.log('\n--- 1. SEEDING PAYMENT ATTEMPTS FOR LAST 10 DAYS (NOV 10 - NOV 19, 2026) ---');

  // Get student profile IDs to use as payers
  const [students]: any = await conn.query(`
    SELECT id FROM campusone_cug.member_profiles WHERE institution_id = ? AND user_type_id IN (
      SELECT id FROM campusone_cug.user_types WHERE category = 'STUDENT'
    ) LIMIT 200
  `, [instId]);
  const studentIds = students.map((s: any) => s.id);

  const channels = ['FEE', 'CANTEEN', 'EVENT', 'STORE', 'LIBRARY'];
  const channelAmounts: Record<string, number[]> = {
    FEE: [3500000, 6000000, 2000000, 1500000, 1000000],
    CANTEEN: [8000, 12000, 15000, 25000, 35000, 50000],
    EVENT: [35000, 50000, 60000, 100000],
    STORE: [15000, 30000, 45000, 75000, 120000],
    LIBRARY: [5000, 10000, 20000, 50000],
  };

  const dates = [
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
    '2026-11-13',
    '2026-11-14',
    '2026-11-15',
    '2026-11-16',
    '2026-11-17',
    '2026-11-18',
    '2026-11-19', // Today
  ];

  let totalAttempts = 0;
  let totalPaise = 0;
  const attemptInserts: any[] = [];

  for (let dIdx = 0; dIdx < dates.length; dIdx++) {
    const dStr = dates[dIdx];
    const txCount = (dIdx === 5) ? 12 : 25 + (dIdx * 3);

    for (let t = 0; t < txCount; t++) {
      const channel = channels[(t + dIdx) % channels.length];
      const amounts = channelAmounts[channel];
      const amountPaise = amounts[(t + dIdx * 2) % amounts.length];

      const hour = 9 + (t % 8);
      const min = (t * 7) % 60;
      const sec = (t * 13) % 60;
      const attemptedAt = new Date(`${dStr}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.000Z`);
      const completedAt = new Date(attemptedAt.getTime() + 1500);

      const ref = `TXN-PBCOE-NOV26-${dStr.replace(/-/g, '')}-${String(t + 1).padStart(4, '0')}-${randomUuid().slice(0, 4)}`;

      attemptInserts.push([
        uuidToBin(randomUuid()),
        instId,
        ref,
        channel,
        1, // mode
        'WALLET',
        studentIds[(t + dIdx) % studentIds.length], // payer_profile_id
        1880, // payee_profile_id (PBCOE Desk)
        null, // payer_wallet_id
        null, // payee_wallet_id
        amountPaise,
        'SUCCESS',
        null, null, null,
        `${channel} payment for PBCOE Campus`,
        randomUuid(), // idempotency_key
        attemptedAt,
        completedAt,
      ]);

      totalAttempts++;
      totalPaise += amountPaise;
    }
  }

  // Bulk insert in chunks
  const chunkSize = 100;
  for (let i = 0; i < attemptInserts.length; i += chunkSize) {
    const chunk = attemptInserts.slice(i, i + chunkSize);
    await conn.query(`
      INSERT IGNORE INTO campusone_cug.payment_attempts
        (public_id, institution_id, reference, channel, mode, instrument,
         payer_profile_id, payee_profile_id, payer_wallet_id, payee_wallet_id,
         amount_paise, status, failed_check, failure_code, failure_params, remarks,
         idempotency_key, attempted_at, completed_at)
      VALUES ?
    `, [chunk]);
  }

  console.log(`Seeded ${totalAttempts} successful payment attempts for Nov 10-19 totaling ₹${(totalPaise / 100).toLocaleString('en-IN')}.00!`);

  // =========================================================================
  // 2. SETTLEMENTS -> For "Settlements" Card & /console/settlements
  // =========================================================================
  console.log('\n--- 2. SEEDING SETTLEMENTS ---');

  await conn.query(`DELETE FROM campusone_cug.settlements WHERE institution_id = ?`, [instId]);

  const settlementsList = [
    {
      no: 'STL-PBCOE-2026-001',
      date: '2026-11-05',
      windowTo: '2026-11-04 23:59:59',
      status: 'APPROVED',
      lines: 142,
      merchants: 1,
      gross: 24500000, // ₹2,45,000
      fee: 490000,     // ₹4,900
      adjustments: 0,
      net: 24010000,   // ₹2,40,100
      utr: 'AXISCN002611050124',
      payoutAt: '2026-11-05 14:30:00',
    },
    {
      no: 'STL-PBCOE-2026-002',
      date: '2026-11-10',
      windowTo: '2026-11-09 23:59:59',
      status: 'APPROVED',
      lines: 98,
      merchants: 1,
      gross: 18560000, // ₹1,85,600
      fee: 371200,
      adjustments: 0,
      net: 18228800,
      utr: 'AXISCN002611100452',
      payoutAt: '2026-11-10 15:15:00',
    },
    {
      no: 'STL-PBCOE-2026-003',
      date: '2026-11-15',
      windowTo: '2026-11-14 23:59:59',
      status: 'APPROVED',
      lines: 175,
      merchants: 1,
      gross: 31240000, // ₹3,12,400
      fee: 624800,
      adjustments: 0,
      net: 30615200,
      utr: 'AXISCN002611150891',
      payoutAt: '2026-11-15 16:00:00',
    },
    {
      no: 'STL-PBCOE-2026-004',
      date: '2026-11-18',
      windowTo: '2026-11-17 23:59:59',
      status: 'APPROVAL_STAGE_1',
      lines: 64,
      merchants: 1,
      gross: 9480000, // ₹94,800
      fee: 189600,
      adjustments: 0,
      net: 9290400,
      utr: null,
      payoutAt: null,
    },
  ];

  for (const s of settlementsList) {
    const sUuid = randomUuid();
    await conn.query(`
      INSERT INTO campusone_cug.settlements
        (public_id, institution_id, settlement_no, settlement_date, window_to,
         status, line_count, merchant_count, gross_paise, fee_paise, adjustment_paise, net_paise,
         recollected_count, files, stage1_by, stage1_at, stage1_remarks,
         final_by, final_at, final_remarks, payout_utr, payout_paise, payout_at,
         row_version, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?,
         0, '[]', ?, ?, 'Verified by accounts team',
         ?, ?, 'Approved by Finance Committee', ?, ?, ?,
         1, NOW(), NOW())
    `, [
      uuidToBin(sUuid), instId, s.no, s.date, s.windowTo,
      s.status, s.lines, s.merchants, s.gross, s.fee, s.adjustments, s.net,
      uuidToBin(accountantAccount), s.date + ' 11:00:00',
      s.status === 'APPROVED' ? uuidToBin(adminAccount) : null,
      s.status === 'APPROVED' ? s.date + ' 13:30:00' : null,
      s.utr, s.net, s.payoutAt
    ]);
  }

  console.log(`Seeded ${settlementsList.length} settlements.`);

  // =========================================================================
  // 3. APPROVAL REQUESTS IN campusone.approval_requests
  // =========================================================================
  console.log('\n--- 3. VERIFYING APPROVAL REQUESTS IN campusone.approval_requests ---');

  const [existingApprovals]: any = await conn.query(`
    SELECT COUNT(*) as count, status FROM campusone.approval_requests WHERE institution_id = ? GROUP BY status
  `, [instId]);
  console.log('Existing approvals by status in PBCOE:', existingApprovals);

  // Add 2 more pending requests to make exactly 5 pending for the dashboard card!
  const [maxSeqRes]: any = await conn.query(`SELECT COALESCE(MAX(request_seq), 0) as max_seq FROM campusone.approval_requests WHERE institution_id = ?`, [instId]);
  let currentSeq = maxSeqRes[0].max_seq;

  const extraApprovals = [
    {
      module: 'EVENTS',
      action: 'CREATE',
      summary: 'Sanction budget approval of ₹1,50,000 for Technova 2026 National Symposium (Keynote speakers & prize money)',
      subjectType: 'event',
      payload: JSON.stringify({ eventName: 'Technova 2026', budgetPaise: 15000000, category: 'Technical' }),
      makerType: 'staff',
      status: 'PENDING',
    },
    {
      module: 'INFRASTRUCTURE',
      action: 'UPDATE',
      summary: 'Procurement of 30 High-Performance GPU Workstations for AI/ML Laboratory (₹18,50,000 tender approval)',
      subjectType: 'asset',
      payload: JSON.stringify({ item: 'Workstations', count: 30, amountPaise: 185000000, lab: 'AI-ML Lab' }),
      makerType: 'staff',
      status: 'PENDING',
    }
  ];

  for (const item of extraApprovals) {
    currentSeq++;
    await conn.query(`
      INSERT INTO campusone.approval_requests
        (public_id, request_seq, institution_id, module, action, summary, subject_type, payload,
         maker_type, maker_ref, status, checker_ref, remarks, decided_at, applied_directly, row_version, created_at, updated_at)
      VALUES
        (UUID_TO_BIN(UUID()), ?, ?, ?, ?, ?, ?, ?,
         ?, UUID_TO_BIN(?), ?, NULL, NULL, NULL, 0, 1, NOW(), NOW())
    `, [
      currentSeq,
      instId,
      item.module,
      item.action,
      item.summary,
      item.subjectType,
      item.payload,
      item.makerType,
      adminAccount,
      item.status
    ]);
  }

  console.log('Added extra pending requests to reach 5 pending approvals.');
  await conn.end();
  console.log('\n--- SUCCESS! ALL CEO DASHBOARD DATA SEEDED SUCCESSFULLY! ---');
}

main().catch(console.error);
