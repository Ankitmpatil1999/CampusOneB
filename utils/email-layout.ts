/**
 * The e-mail every RingPe message is sent in (client 2026-10-16): the subject as a heading, the text
 * (links made clickable), the school's name and a closing line, in the prototype's colours. Plain
 * text goes with it for mail apps that don't show HTML. Every value is escaped: names and bodies are
 * typed by people.
 */
const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const LINK = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g;
/** A highlighted detail: bold, in the brand blue, on a light chip (client 2026-10-26). */
const MARK =
  'font-weight:700;color:#1f5eff;background:#eef3ff;padding:1px 6px;border-radius:4px;white-space:nowrap';

/** Matches any of the details to highlight, longest first (escaped as the text is). */
function highlighter(details: readonly (string | null | undefined)[]) {
  const words = [...new Set(details.map((d) => d?.trim()).filter((d): d is string => !!d))]
    .map(esc)
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return words.length ? new RegExp(words.join('|'), 'g') : null;
}

/**
 * Escaped text with https links made clickable, the details highlighted (never inside a link) and
 * line breaks kept.
 */
function paragraphs(text: string, highlight: RegExp | null) {
  const mark = (s: string) =>
    highlight ? s.replace(highlight, (w) => `<strong style="${MARK}">${w}</strong>`) : s;
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const escaped = esc(block);
      let html = '';
      let from = 0;
      for (const m of escaped.matchAll(LINK)) {
        html += mark(escaped.slice(from, m.index));
        html += `<a href="${m[0]}" style="color:#1f5eff;word-break:break-all">${m[0]}</a>`;
        from = m.index + m[0].length;
      }
      html += mark(escaped.slice(from));
      return `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1d2433">${html.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');
}

/** Subjects for messages that don't give one, by purpose. */
const SUBJECTS: Readonly<Record<string, string>> = {
  'admission.approved': 'Your admission application is approved',
  'admission.link': 'Your admission application link',
  'admission.rejected': 'About your admission application',
  'admission.submitted': 'We have received your admission application',
  announcement: 'Announcement',
  'billing.invoice_issued': 'Your RingPe invoice',
  'fee.payLink': 'Your school fee payment link',
  'institution.lifecycle': 'Your institution on RingPe',
  'institution.registered': 'Welcome to RingPe',
  'merchant.qr_codes': 'Your RingPe QR codes',
  'staff.onboarded': 'Welcome to RingPe',
};

export function subjectFor(purpose: string, given?: string | null) {
  if (given?.trim()) return given.trim().slice(0, 200);
  if (purpose.startsWith('otp.')) return 'Your RingPe one-time code';
  if (purpose.startsWith('password_reset.')) return 'Reset your RingPe password';
  return SUBJECTS[purpose] ?? 'A message from RingPe';
}

/** The inline logo's content id (the e-mail carries the picture: a LAN address can't be fetched). */
export const LOGO_CID = 'school-logo@ringpe';

export function emailHtml(m: {
  subject: string;
  text: string;
  /** The school's name (else RingPe's): the heading band and the sign-off. */
  sender: string;
  highlight?: readonly (string | null | undefined)[];
  /** The school's logo goes with the e-mail as an inline picture. */
  withLogo?: boolean;
}) {
  const logo = m.withLogo
    ? `<img src="cid:${LOGO_CID}" alt="" width="40" height="40" style="display:block;width:40px;height:40px;object-fit:contain;border-radius:8px;background:#ffffff;padding:3px"/>`
    : '';
  const band = logo
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:12px;vertical-align:middle">${logo}</td><td style="vertical-align:middle;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px">${esc(m.sender)}</td></tr></table>`
    : esc(m.sender);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(m.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5fa;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e7f0">
<tr><td style="background:#1f5eff;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px">${band}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;color:#0f1729">${esc(m.subject)}</h1>
${paragraphs(m.text, highlighter(m.highlight ?? []))}
</td></tr>
<tr><td style="padding:14px 24px 20px;border-top:1px solid #eef1f6;font-size:12px;line-height:1.5;color:#6b7385">
Sent by ${esc(m.sender)}. This is an automatic message; you can see it in the RingPe app too.
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
