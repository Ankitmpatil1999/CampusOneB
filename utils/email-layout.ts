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

/** Escaped text with https links made clickable and line breaks kept. */
function paragraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const html = esc(block)
        .replace(
          /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g,
          (u) => `<a href="${u}" style="color:#1f5eff;word-break:break-all">${u}</a>`,
        )
        .replace(/\n/g, '<br/>');
      return `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1d2433">${html}</p>`;
    })
    .join('');
}

/** Subjects for messages that don't give one, by purpose. */
const SUBJECTS: Readonly<Record<string, string>> = {
  'admission.link': 'Your admission application link',
  announcement: 'Announcement',
  'billing.invoice_issued': 'Your RingPe invoice',
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

export function emailHtml(m: { subject: string; text: string; sender: string }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(m.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f5fa;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fa;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e7f0">
<tr><td style="background:#1f5eff;padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.2px">${esc(m.sender)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;color:#0f1729">${esc(m.subject)}</h1>
${paragraphs(m.text)}
</td></tr>
<tr><td style="padding:14px 24px 20px;border-top:1px solid #eef1f6;font-size:12px;line-height:1.5;color:#6b7385">
Sent by ${esc(m.sender)} through RingPe. This is an automatic message; you can see it in the RingPe app too.
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}
