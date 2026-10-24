/**
 * RingPe accounts for the people on an admission (client 2026-10-23). The student, the father, the
 * mother, the guardian and the local guardian each get one as soon as the form has their mobile
 * number — when it is submitted, or a submitted one changes — so nobody signs up themselves:
 *
 * - A mobile that already has an account is that person's: it is linked, and their own password
 *   stays. A mobile whose profiles are at another school gets no account here (one school per person).
 * - A new account takes the person's name, the e-mail, the Aadhaar number and the PAN the form has
 *   when no other account uses them; what is missing is asked at the first sign-in.
 * - A mobile changed or removed before the login details went out moves the account, or removes the
 *   unused one the admission made.
 * - The login details go out once, when the admission is approved (or the student is uploaded as an
 *   existing student): a one-time password, changed on the first sign-in (issueCredentials).
 *
 * The profiles at the school are made at approval; a profile kept for a mobile (contact_mobile) is
 * linked to its account as when someone signs up (BR-01).
 */
import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { AdmissionAccountPerson, Database } from '../models/ringpe_models';
import { accountRepository } from '../repositories/account.repository';
import { membersRepository } from '../repositories/members.repository';
import { lastFour, normaliseForIndex, type FieldCipher } from '../utils/fieldEncryption';
import { binToUuid, newPublicIdPair } from '../utils/idGenerator';
import { hashSecret } from '../utils/password';
import { PATTERNS } from '../utils/validators';

type Db = Kysely<Database> | Transaction<Database>;

/** One person on the form with what their account takes. */
export interface AdmissionPerson {
  readonly person: AdmissionAccountPerson;
  readonly firstName: string;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly mobile: string | null;
  readonly email: string | null;
  readonly gender: 'MALE' | 'FEMALE' | null;
  readonly dob: string | null;
  readonly aadhaar: string | null;
  readonly pan: string | null;
}

const upper = (v: string | null) => (v ? v.trim().toUpperCase() : null);

/** Whether an account is still unused: no profile, no password, no session. */
async function unused(db: Db, accountId: string) {
  const [profile, credential, session] = await Promise.all([
    db
      .selectFrom('member_profiles')
      .select('id')
      .where((eb) =>
        eb.or([eb('account_id', '=', accountId), eb('own_account_id', '=', accountId)]),
      )
      .executeTakeFirst(),
    db
      .selectFrom('account_credentials')
      .select('id')
      .where('account_id', '=', accountId)
      .executeTakeFirst(),
    db.selectFrom('sessions').select('id').where('account_id', '=', accountId).executeTakeFirst(),
  ]);
  return !profile && !credential && !session;
}

/** What the new account takes from the form: the e-mail and PAN only when no account uses them. */
async function details(db: Db, cipher: FieldCipher, publicId: string, p: AdmissionPerson) {
  const email = p.email?.trim().toLowerCase() || null;
  const pan = upper(p.pan);
  const aadhaar = p.aadhaar ? normaliseForIndex(p.aadhaar) : null;
  const emailFree = email && !(await accountRepository.emailInUse(db, email));
  const panFree = pan && !(await accountRepository.panInUse(db, cipher.blindIndex('pan', pan)));
  return {
    email: emailFree ? email : null,
    pan: panFree
      ? {
          enc: cipher.encrypt('pan', pan, `platform_accounts.pan:${publicId}`),
          bidx: cipher.blindIndex('pan', pan),
          last4: lastFour(pan),
        }
      : null,
    aadhaar: aadhaar
      ? {
          enc: cipher.encrypt('id_doc', aadhaar, `platform_accounts.id_doc:${publicId}`),
          bidx: cipher.blindIndex('id_doc', aadhaar),
          last4: lastFour(aadhaar),
        }
      : null,
  };
}

async function create(db: Db, cipher: FieldCipher, p: AdmissionPerson, mobile: string) {
  const pub = newPublicIdPair();
  const d = await details(db, cipher, pub.id, p);
  const made = await db
    .insertInto('platform_accounts')
    .values({
      public_id: pub.bin,
      mobile,
      email: d.email,
      first_name: upper(p.firstName) ?? '',
      middle_name: upper(p.middleName),
      last_name: upper(p.lastName),
      gender: p.gender,
      dob: p.dob,
      pan_enc: d.pan?.enc ?? null,
      pan_bidx: d.pan?.bidx ?? null,
      pan_last4: d.pan?.last4 ?? null,
      id_doc_type: d.aadhaar ? 'AADHAAR' : null,
      id_doc_enc: d.aadhaar?.enc ?? null,
      id_doc_bidx: d.aadhaar?.bidx ?? null,
      id_doc_last4: d.aadhaar?.last4 ?? null,
      preferred_lang: 'en',
      created_by: pub.bin,
      updated_by: pub.bin,
    })
    .executeTakeFirstOrThrow();
  const accountId = String(made.insertId);
  // The school's profiles kept for this mobile are now this account's (BR-01).
  await membersRepository.linkByMobile(db, accountId, mobile);
  return accountId;
}

/** The details the form has now on an account the admission made, not yet in anyone's hands. */
async function refresh(db: Db, cipher: FieldCipher, accountId: string, p: AdmissionPerson) {
  const a = await db
    .selectFrom('platform_accounts')
    .select(['public_id', 'email', 'pan_bidx', 'id_doc_enc'])
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();
  const d = await details(db, cipher, binToUuid(a.public_id), p);
  await db
    .updateTable('platform_accounts')
    .set({
      first_name: upper(p.firstName) ?? '',
      middle_name: upper(p.middleName),
      last_name: upper(p.lastName),
      gender: p.gender,
      dob: p.dob,
      ...(!a.email && d.email ? { email: d.email } : {}),
      ...(!a.pan_bidx && d.pan
        ? { pan_enc: d.pan.enc, pan_bidx: d.pan.bidx, pan_last4: d.pan.last4 }
        : {}),
      ...(!a.id_doc_enc && d.aadhaar
        ? {
            id_doc_type: 'AADHAAR',
            id_doc_enc: d.aadhaar.enc,
            id_doc_bidx: d.aadhaar.bidx,
            id_doc_last4: d.aadhaar.last4,
          }
        : {}),
      row_version: sql<number>`row_version + 1`,
    })
    .where('id', '=', accountId)
    .execute();
}

/**
 * The accounts of the people on an application, as the form has them now (client 2026-10-23). Never
 * refuses the form: a person whose account can't be made is left without one, and asked to sign up
 * or helped by the school.
 */
export async function syncAdmissionAccounts(
  db: Db,
  cipher: FieldCipher,
  a: {
    readonly institutionId: string;
    readonly applicationRowId: string;
    readonly people: readonly AdmissionPerson[];
  },
) {
  const links = await db
    .selectFrom('admission_accounts')
    .selectAll()
    .where('application_id', '=', a.applicationRowId)
    .execute();
  const at = new Date();
  /** The account the admission made, removed while no one has it yet. */
  const drop = async (link: (typeof links)[number]) => {
    await db.deleteFrom('admission_accounts').where('id', '=', link.id).execute();
    if (Number(link.created) && !link.credentials_sent_at && (await unused(db, link.account_id))) {
      await db.deleteFrom('platform_accounts').where('id', '=', link.account_id).execute();
    }
  };
  for (const link of links) {
    const p = a.people.find((x) => x.person === link.person);
    if (!p?.mobile || !PATTERNS.mobile.test(p.mobile)) await drop(link);
  }
  for (const p of a.people) {
    const mobile = p.mobile?.trim() ?? '';
    // A RingPe account is keyed on an Indian mobile number.
    if (!PATTERNS.mobile.test(mobile)) continue;
    try {
      const link = links.find((l) => l.person === p.person);
      if (link) {
        const linked = await db
          .selectFrom('platform_accounts')
          .select('mobile')
          .where('id', '=', link.account_id)
          .executeTakeFirst();
        const ours = Number(link.created) === 1 && !link.credentials_sent_at;
        if (linked?.mobile === mobile) {
          if (ours) await refresh(db, cipher, link.account_id, p);
          continue;
        }
        // A new number: an unused account the admission made moves to it when it is free.
        if (
          ours &&
          !(await accountRepository.findByMobile(db, mobile)) &&
          (await unused(db, link.account_id))
        ) {
          await db
            .updateTable('platform_accounts')
            .set({ mobile, row_version: sql<number>`row_version + 1` })
            .where('id', '=', link.account_id)
            .execute();
          await refresh(db, cipher, link.account_id, p);
          await membersRepository.linkByMobile(db, link.account_id, mobile);
          continue;
        }
        await drop(link);
      }
      const existing = await accountRepository.findByMobile(db, mobile);
      if (existing) {
        // One school per person: a mobile at another school gets no account here.
        const elsewhere = (await membersRepository.profilesOfMobile(db, mobile)).some(
          (x) => String(x.institution_id) !== String(a.institutionId),
        );
        if (elsewhere) continue;
      }
      const accountId = existing ? String(existing.id) : await create(db, cipher, p, mobile);
      await db
        .insertInto('admission_accounts')
        .values({
          application_id: a.applicationRowId,
          person: p.person,
          account_id: accountId,
          created: existing ? 0 : 1,
          created_at: at,
          updated_at: at,
        })
        .execute();
    } catch {
      // Best effort: the form is never refused for an account (another one may have taken a
      // number meanwhile); the next save or the approval tries again.
    }
  }
  await linkStudentLogin(db, a.applicationRowId);
}

/**
 * The student's own login on the student's profile, once the admission made it (the family still
 * holds the profile, CR-04): the student reaches that profile only.
 */
export async function linkStudentLogin(db: Db, applicationRowId: string) {
  const app = await db
    .selectFrom('admission_applications')
    .select('member_profile_id')
    .where('id', '=', applicationRowId)
    .executeTakeFirst();
  if (!app?.member_profile_id) return;
  const link = await db
    .selectFrom('admission_accounts')
    .select('account_id')
    .where('application_id', '=', applicationRowId)
    .where('person', '=', 'STUDENT')
    .executeTakeFirst();
  await db
    .updateTable('member_profiles')
    .set({ own_account_id: link?.account_id ?? null })
    .where('id', '=', String(app.member_profile_id))
    .execute();
}

/** A one-time password: changed on the first sign-in. */
export const oneTimePassword = () =>
  `R${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8)}a@1`;

export interface IssuedLogin {
  readonly person: AdmissionAccountPerson;
  readonly name: string;
  readonly mobile: string;
  /** A one-time password for an account the admission made; null: the person's own account. */
  readonly password: string | null;
  readonly email: string | null;
}

/**
 * The login details of an application's accounts, once (at approval or upload): a one-time password
 * for each account the admission made, changed on the first sign-in; the others keep theirs.
 */
export async function issueCredentials(db: Db, applicationRowId: string): Promise<IssuedLogin[]> {
  const rows = await db
    .selectFrom('admission_accounts as aa')
    .innerJoin('platform_accounts as pa', 'pa.id', 'aa.account_id')
    .select([
      'aa.id',
      'aa.person',
      'aa.account_id',
      'aa.created',
      'aa.credentials_sent_at',
      'pa.first_name',
      'pa.last_name',
      'pa.mobile',
      'pa.email',
    ])
    .where('aa.application_id', '=', applicationRowId)
    .execute();
  const out: IssuedLogin[] = [];
  const at = new Date();
  for (const r of rows) {
    if (r.credentials_sent_at) continue;
    let password: string | null = null;
    if (Number(r.created)) {
      const has = await accountRepository.credential(db, r.account_id, 'PASSWORD');
      if (!has) {
        password = oneTimePassword();
        await db
          .insertInto('account_credentials')
          .values({
            account_id: r.account_id,
            kind: 'PASSWORD',
            hash: await hashSecret(password),
            must_change: 1,
          })
          .execute();
      }
    }
    await db
      .updateTable('admission_accounts')
      .set({ credentials_sent_at: at, updated_at: at })
      .where('id', '=', r.id)
      .execute();
    const name = [r.first_name, r.last_name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    out.push({ person: r.person, name, mobile: r.mobile, password, email: r.email });
  }
  return out;
}
