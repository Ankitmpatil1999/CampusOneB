/**
 * Axis Bank Power E-coll (client 2026-10-12, "Updated Axis Bank APIs for Integration"; BNK-001…003):
 * the bank's token, validation and notification calls in its own request and answer format, as the
 * earlier application served them. Underneath, the same rules as WAL-012/013 (BankCreditsService):
 * the account must be ours and able to take money, a credit is posted once per UTR + transaction id
 * through the ledger, and a suspended wallet's credit is held.
 *
 * - Token: OAuth 2 client credentials on a Partner API client (back office); the bank's scope names
 *   map to ours (transaction_validation → va.validate, transaction_notification_posting → va.notify).
 *   A new token ends only the client's live tokens with the same scopes, since the bank asks for one
 *   token per scope.
 * - Validation: every call is logged with its answer. Notification: posted only after a successful
 *   validation of the same UTR + transaction id (setting `bank.axis.requireValidation`).
 * - The sender's account number is never stored or logged: only its last four digits.
 */
import type { Kysely } from 'kysely';
import {
  AXIS_BANK_RESPONSES,
  AXIS_BANK_SCOPES,
  LIMITS,
  type AxisBankResponse,
  type AxisBankScope,
} from '../config/registers';
import type { Database } from '../models/ringpe_models';
import { ipToBin } from '../utils/ip';
import type { BankCreditInput, BankCreditsService } from './bank-credits.service';
import type { PartnersService } from './partners.service';
import { defaultValues, type SettingValues, type SettingsService } from './settings.service';

/** The bank's call body (JSON or form fields); every value arrives as text. */
export type AxisBankCall = Record<string, unknown>;

export interface AxisAnswer {
  readonly Stts_flg: string;
  readonly Err_cd: string;
  readonly message: string;
  readonly error?: string;
}

const MODES = ['UPI', 'IMPS', 'NEFT', 'RTGS'] as const;
const MODE_LETTERS: Record<string, BankCreditInput['mode']> = {
  U: 'UPI',
  I: 'IMPS',
  N: 'NEFT',
  R: 'RTGS',
};

const str = (v: unknown) =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';

/** YYYY-MM-DD and a real date (no 2026-02-30), as the earlier application checked. */
export function isStrictDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

const answer = (r: AxisBankResponse): AxisAnswer => ({
  Stts_flg: r.flag,
  Err_cd: r.code,
  message: r.message,
  ...('error' in r ? { error: r.error } : {}),
});

interface Fields {
  readonly utr: string;
  readonly txnId: string;
  readonly vaNumber: string;
  readonly reqType: string;
  readonly reqDate: string;
  readonly amount: string;
  readonly mode: string;
  readonly senderAccount: string;
  readonly senderName: string;
  readonly senderIfsc: string;
}

const fieldsOf = (b: AxisBankCall): Fields => ({
  utr: str(b['UTR']),
  txnId: str(b['Tran_id']),
  vaNumber: str(b['Bene_acc_no']).toUpperCase(),
  reqType: str(b['Req_type']),
  reqDate: str(b['Req_date']),
  amount: str(b['Txn_amnt']),
  mode: str(b['Pmode']).toUpperCase(),
  senderAccount: str(b['Sndr_acnt']),
  senderName: str(b['Sndr_nm']),
  senderIfsc: str(b['Sndr_ifsc']).toUpperCase(),
});

/** Within the stored column sizes (a longer value is refused as invalid parameters). */
const fits = (f: Fields) =>
  f.utr.length <= 32 && f.txnId.length <= 40 && f.vaNumber.length <= 30 && f.amount.length <= 20;

const modeOf = (m: string): BankCreditInput['mode'] =>
  (MODES as readonly string[]).includes(m)
    ? (m as BankCreditInput['mode'])
    : (MODE_LETTERS[m] ?? (m ? 'OTHER' : undefined));

export class AxisBankService {
  constructor(
    private readonly deps: {
      readonly db: Kysely<Database>;
      readonly partners: PartnersService;
      readonly bankCredits: BankCreditsService;
      readonly settings?: SettingsService;
    },
  ) {}

  private async requireValidation() {
    const v: SettingValues = this.deps.settings
      ? await this.deps.settings.values()
      : defaultValues();
    const l = LIMITS.bankAxisRequireValidation;
    return Number(v[l.key] ?? l.value) === 1;
  }

  // --- BNK-001 ------------------------------------------------------------------------------------
  /** The bank's token call: HTTP status and body in the earlier application's format. */
  async token(body: AxisBankCall | undefined, ip: string | undefined) {
    if (!body || typeof body !== 'object') {
      return {
        status: 400,
        body: { status: false, message: 'Missing request body', Stts_flg: 'F', Err_cd: '001' },
      };
    }
    const grantType = str(body['grant_type']);
    const clientId = str(body['client_id']);
    const clientSecret = typeof body['client_secret'] === 'string' ? body['client_secret'] : '';
    const scope = str(body['scope']);
    if (!grantType || !clientId || !clientSecret || !scope) {
      return { status: 400, body: { message: 'Missing required fields' } };
    }
    const refused = (message: string) => ({
      status: 400,
      body: { status: false, statusCode: 400, message, data: null },
    });
    if (grantType !== 'client_credentials') return refused('INVALID_GRANT_TYPE');
    const asked = [...new Set(scope.split(/\s+/))].sort();
    if (asked.some((s) => !(s in AXIS_BANK_SCOPES))) return refused('INVALID_SCOPE');
    const ours = asked.map((s) => AXIS_BANK_SCOPES[s as AxisBankScope]);
    const out = await this.deps.partners.issueToken(
      { grantType, clientId, clientSecret, scope: ours.join(' ') },
      ip,
      'sameScopes',
    );
    if (!out.ok) {
      if (out.error === 'IP_NOT_ALLOWED') {
        return {
          status: 403,
          body: {
            status: false,
            Stts_flg: 'N',
            Err_cd: '001',
            message: 'Authentication failed',
            error: 'Access denied: IP not whitelisted',
          },
        };
      }
      return refused(
        out.error === 'invalid_scope'
          ? 'INVALID_SCOPE'
          : out.error === 'invalid_grant_type'
            ? 'INVALID_GRANT_TYPE'
            : 'INVALID_CLIENT',
      );
    }
    return {
      status: 200,
      body: {
        access_token: out.accessToken,
        token_type: 'Bearer',
        expires_in: out.expiresIn,
        expires_at: new Date(Date.now() + out.expiresIn * 1000).toISOString(),
        scope: asked.join(' '),
      },
    };
  }

  /** The bank's account number holds the corporate code; ours is read from the account itself. */
  private async creditInput(f: Fields): Promise<BankCreditInput> {
    const va = await this.deps.db
      .selectFrom('virtual_accounts')
      .select('corporate_code')
      .where('va_number', '=', f.vaNumber)
      .executeTakeFirst();
    const mode = modeOf(f.mode);
    const sender = {
      ...(f.senderName ? { name: f.senderName } : {}),
      ...(f.senderAccount ? { accountLast4: f.senderAccount.slice(-4) } : {}),
      ...(f.senderIfsc ? { ifsc: f.senderIfsc } : {}),
    };
    return {
      requestId: `${f.utr}:${f.txnId}`,
      // The account number is unique; its corporate code is read from it (Corp_code is informative).
      corporateCode: va?.corporate_code ?? f.vaNumber.slice(0, 4),
      vaNumber: f.vaNumber,
      amount: f.amount,
      utr: f.utr,
      bankTxnId: f.txnId,
      ...(mode ? { mode } : {}),
      ...(Object.keys(sender).length ? { sender } : {}),
    };
  }

  // --- BNK-002 ------------------------------------------------------------------------------------
  async validate(body: AxisBankCall, clientRowId: string, ip: string | undefined) {
    const f = fieldsOf(body ?? {});
    let out: AxisAnswer;
    let institutionId: string | null = null;
    try {
      if (
        !f.utr ||
        !f.vaNumber ||
        !f.reqDate ||
        !f.amount ||
        !f.txnId ||
        f.reqType.toLowerCase() !== 'validation' ||
        !fits(f)
      ) {
        out = answer(AXIS_BANK_RESPONSES.INVALID_PARAMS);
      } else if (f.vaNumber.length <= 4) {
        out = answer(AXIS_BANK_RESPONSES.INVALID_VAN);
      } else if (!isStrictDate(f.reqDate)) {
        out = answer(AXIS_BANK_RESPONSES.INVALID_DATE);
      } else {
        const r = await this.deps.bankCredits.validate(await this.creditInput(f));
        out = answer(
          r.code === '000'
            ? AXIS_BANK_RESPONSES.SUCCESS
            : r.code === '003'
              ? AXIS_BANK_RESPONSES.INVALID_PARAMS
              : r.code === '004'
                ? AXIS_BANK_RESPONSES.DUPLICATE_UTR
                : AXIS_BANK_RESPONSES.INCORRECT_VAN,
        );
        if (r.code === '000') {
          const va = await this.deps.db
            .selectFrom('virtual_accounts')
            .select('institution_id')
            .where('va_number', '=', f.vaNumber)
            .executeTakeFirst();
          institutionId = va ? String(va.institution_id) : null;
        }
      }
    } catch {
      out = answer(AXIS_BANK_RESPONSES.SERVER_ERROR);
    }
    await this.deps.db
      .insertInto('bank_va_validations')
      .values({
        api_client_id: clientRowId,
        institution_id: institutionId,
        utr: f.utr.slice(0, 32),
        bank_txn_id: f.txnId.slice(0, 40),
        va_number: f.vaNumber.slice(0, 32),
        amount_text: f.amount.slice(0, 20) || null,
        req_date: f.reqDate.slice(0, 20) || null,
        pay_mode: f.mode.slice(0, 20) || null,
        sender_name: f.senderName.slice(0, 120) || null,
        sender_account_last4: f.senderAccount.slice(-4) || null,
        sender_ifsc: f.senderIfsc.slice(0, 11) || null,
        status_flag: out.Stts_flg,
        response_code: out.Err_cd,
        ip_bin: ipToBin(ip),
      })
      .execute();
    return out;
  }

  // --- BNK-003 ------------------------------------------------------------------------------------
  async notify(body: AxisBankCall, clientRowId: string): Promise<AxisAnswer> {
    const f = fieldsOf(body ?? {});
    if (!f.utr || !f.txnId || !f.vaNumber || !f.amount || !f.reqType || !f.reqDate) {
      return answer(AXIS_BANK_RESPONSES.MISSING_FIELDS);
    }
    if (!isStrictDate(f.reqDate)) return answer(AXIS_BANK_RESPONSES.NOTIFY_INVALID_DATE);
    if (f.reqType.toLowerCase() !== 'notification') {
      return answer(AXIS_BANK_RESPONSES.INVALID_REQ_TYPE);
    }
    if (!fits(f)) return answer(AXIS_BANK_RESPONSES.INVALID_PARAMS);
    try {
      if (await this.requireValidation()) {
        const last = await this.deps.db
          .selectFrom('bank_va_validations')
          .select(['status_flag', 'response_code'])
          .where('utr', '=', f.utr)
          .where('bank_txn_id', '=', f.txnId)
          .where('va_number', '=', f.vaNumber)
          .where('status_flag', '=', 'S')
          .orderBy('id', 'desc')
          .executeTakeFirst();
        if (!last || last.response_code !== '000') {
          return answer(AXIS_BANK_RESPONSES.NOT_VALIDATED);
        }
      }
      const r = await this.deps.bankCredits.notify(await this.creditInput(f), clientRowId);
      if (r.replayed) return answer(AXIS_BANK_RESPONSES.DUPLICATE_UTR);
      return answer(
        r.code === '000'
          ? AXIS_BANK_RESPONSES.SUCCESS
          : r.code === '003'
            ? AXIS_BANK_RESPONSES.INVALID_PARAMS
            : AXIS_BANK_RESPONSES.NOTIFY_INVALID_VAN,
      );
    } catch (e) {
      // Two deliveries of one credit at once: the second meets the unique UTR + transaction id.
      if ((e as { errno?: number }).errno === 1062)
        return answer(AXIS_BANK_RESPONSES.DUPLICATE_UTR);
      return answer(AXIS_BANK_RESPONSES.NOTIFY_FAILED);
    }
  }
}
