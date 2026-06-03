// Email notifications via Resend's REST API.
// If RESEND_API_KEY is unset, sendEmail() is a no-op (logged once) so local dev still works.

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Yomitan-Lite <onboarding@resend.dev>";
const APP_URL = process.env.APP_URL || "https://yomitan.ley-labs.com";

let warnedMissingKey = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Fire-and-forget: returns immediately; the actual POST runs on the event loop.
 *  Errors are logged, never thrown to the caller. */
export function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    if (!warnedMissingKey) {
      console.warn("[notifier] RESEND_API_KEY not set — emails disabled.");
      warnedMissingKey = true;
    }
    return;
  }
  // Run async without blocking the caller. Use queueMicrotask so the HTTP
  // response is sent before the network call begins.
  queueMicrotask(async () => {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          text,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[notifier] Resend failed (${res.status}): ${body}`);
      }
    } catch (e) {
      console.error("[notifier] Resend threw:", e);
    }
  });
}

export function notifyDeckAssigned({ studentEmail, studentName, teacherName, teacherEmail, deckName }) {
  const studentLabel = studentName || studentEmail;
  const teacherLabel = teacherName || teacherEmail;
  const safeDeck = escapeHtml(deckName);
  const safeTeacher = escapeHtml(teacherLabel);

  const subject = `New deck assigned: ${deckName}`;
  const text =
    `Hi ${studentLabel},\n\n` +
    `${teacherLabel} has assigned you a new deck: "${deckName}".\n\n` +
    `Open Yomitan-Lite to start studying: ${APP_URL}\n\n` +
    `— Yomitan-Lite\n`;
  const html =
    `<p>Hi ${escapeHtml(studentLabel)},</p>` +
    `<p><strong>${safeTeacher}</strong> has assigned you a new deck: <strong>${safeDeck}</strong>.</p>` +
    `<p><a href="${APP_URL}">Open Yomitan-Lite</a> to start studying.</p>` +
    `<p style="color:#888;font-size:0.85em">— Yomitan-Lite</p>`;

  sendEmail({ to: studentEmail, subject, html, text });
}

export function notifyQuizCompleted({
  teacherEmail,
  studentName,
  studentEmail,
  deckName,
  readingScore,
  meaningScore,
  total,
}) {
  const studentLabel = studentName || studentEmail;
  const readingPct = Math.round((readingScore / total) * 100);
  const meaningPct = Math.round((meaningScore / total) * 100);
  const safeStudent = escapeHtml(studentLabel);
  const safeDeck = escapeHtml(deckName);

  const subject = `${studentLabel} completed "${deckName}"`;
  const text =
    `${studentLabel} finished the quiz for "${deckName}".\n\n` +
    `Reading: ${readingScore}/${total} (${readingPct}%)\n` +
    `Meaning: ${meaningScore}/${total} (${meaningPct}%)\n\n` +
    `View their progress: ${APP_URL}\n\n` +
    `— Yomitan-Lite\n`;
  const html =
    `<p><strong>${safeStudent}</strong> finished the quiz for <strong>${safeDeck}</strong>.</p>` +
    `<table style="border-collapse:collapse;font-size:0.95em">` +
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Reading</td><td><strong>${readingScore} / ${total}</strong> (${readingPct}%)</td></tr>` +
      `<tr><td style="padding:4px 12px 4px 0;color:#666">Meaning</td><td><strong>${meaningScore} / ${total}</strong> (${meaningPct}%)</td></tr>` +
    `</table>` +
    `<p><a href="${APP_URL}">View their progress</a>.</p>` +
    `<p style="color:#888;font-size:0.85em">— Yomitan-Lite</p>`;

  sendEmail({ to: teacherEmail, subject, html, text });
}
