/**
 * The Axis Bank Power E-coll calls (BNK-001…003; client 2026-10-12), in the bank's own field names.
 * Documentation only: the service reads the fields itself so a malformed call still gets the bank's
 * answer format rather than a problem document.
 */
import { z } from 'zod';

export const axisTokenRequestSchema = z
  .object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string(),
    client_secret: z.string(),
    scope: z
      .string()
      .describe(
        'transaction_validation, transaction_notification_posting, or both (space-separated)',
      ),
  })
  .meta({ id: 'AxisTokenRequest' });

export const axisTokenResponseSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z
      .number()
      .int()
      .describe('Seconds (setting auth.partner.tokenMinutes; 15 minutes)'),
    expires_at: z.string(),
    scope: z.string(),
  })
  .meta({ id: 'AxisTokenResponse' });

export const axisCallSchema = z
  .object({
    UTR: z.string().max(32),
    Bene_acc_no: z
      .string()
      .max(30)
      .describe('The virtual account number (corporate code + wallet number)'),
    Req_type: z.string().describe('"Validation" or "notification"'),
    Req_date: z.string().describe('YYYY-MM-DD'),
    Txn_amnt: z.string().describe('Rupees, e.g. "4999.00"'),
    Pmode: z.string().optional().describe('NEFT, RTGS, IMPS, UPI'),
    Sndr_acnt: z.string().optional().describe('Only the last four digits are kept'),
    Sndr_nm: z.string().optional(),
    Sndr_ifsc: z.string().optional(),
    Corp_code: z.string().optional(),
    Tran_id: z.string().max(40),
  })
  .meta({ id: 'AxisBankCall' });

export const axisAnswerSchema = z
  .object({
    Stts_flg: z.string().describe('S success · F failure · N refused (address, token, scope)'),
    Err_cd: z
      .string()
      .describe(
        '000 success · 001 authentication failed · 002 invalid VAN / duplicate UTR · 003 invalid request · 004 invalid VAN (notify) · 006 invalid date · 999 server error',
      ),
    message: z.string(),
    error: z.string().optional(),
  })
  .meta({ id: 'AxisBankAnswer' });
