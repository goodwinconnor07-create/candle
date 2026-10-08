/*
 * Sends the sign-in code. Resend's HTTP API, with the key as the Worker
 * secret RESEND_API_KEY and the sender as MAIL_FROM. MAIL_MOCK=1 (local
 * .dev.vars only) skips sending and hands the code back, for testing.
 */
export async function sendLoginCode(env, email, code) {
  if (env.MAIL_MOCK === '1') return { ok: true, mock: code };
  if (!env.RESEND_API_KEY) return { ok: false, why: 'signing in is not set up yet' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'Study Duel <onboarding@resend.dev>',
      to: [email],
      subject: code + ' is your Study Duel code',
      text: `Your Study Duel sign-in code is ${code}.\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.`,
      html: `<p>Your Study Duel sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for 10 minutes. If you didn't ask for it, you can ignore this email.</p>`,
    }),
  });
  return res.ok ? { ok: true } : { ok: false, why: "couldn't send the email. Check the address and try again" };
}
