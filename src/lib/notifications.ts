// Outbound notification hooks. Called fire-and-forget from the route
// handlers, so a failure here never affects the visitor's response; the
// outcome is recorded on the enquiry row for the dashboard instead.
import { EmailStatus } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { getMailer } from "./mailer.js";

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Header values must be single-line or a crafted name could inject headers.
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/**
 * Emails the staff alert for an enquiry and records the outcome
 * (emailStatus / attempts / error) on its row. Never throws.
 */
export async function deliverEnquiryEmail(enquiryId: string): Promise<EmailStatus> {
  try {
    const enquiry = await prisma.enquiry.findUnique({
      where: { id: enquiryId },
      include: { itinerary: { select: { title: true } } },
    });
    if (!enquiry) return EmailStatus.FAILED;

    const mailer = getMailer();
    if (!mailer) {
      await prisma.enquiry.update({
        where: { id: enquiryId },
        data: { emailStatus: EmailStatus.SKIPPED, emailError: "Email not configured (EMAIL_* env vars missing)" },
      });
      return EmailStatus.SKIPPED;
    }

    const location = [enquiry.city, enquiry.country].filter(Boolean).join(", ");
    const rows: [string, string | null | undefined][] = [
      ["Name", enquiry.name],
      ["Email", enquiry.email],
      ["Phone / WhatsApp", enquiry.phone],
      ["Itinerary", enquiry.itinerary?.title],
      ["Party size", enquiry.partySize],
      ["Preferred dates", enquiry.preferredDates],
      ["Message", enquiry.message],
      ["Location", location],
      ["Submitted from", [enquiry.source, enquiry.pagePath].filter(Boolean).join(" ")],
      ["Received", enquiry.createdAt.toISOString()],
    ];
    const filled = rows.filter((r): r is [string, string] => Boolean(r[1]));

    const text = filled.map(([k, v]) => `${k}: ${v}`).join("\n");
    const html =
      `<h2>New enquiry from ${escapeHtml(enquiry.name)}</h2><table cellpadding="6">` +
      filled
        .map(([k, v]) => `<tr><td><strong>${k}</strong></td><td style="white-space:pre-wrap">${escapeHtml(v)}</td></tr>`)
        .join("") +
      "</table>";

    try {
      await mailer.sendMail({
        from: `"Macho Halisi enquiries" <${env.EMAIL_FOR_ENQUIRIES}>`,
        to: env.ENQUIRY_NOTIFY_TO,
        replyTo: oneLine(enquiry.email),
        subject: `New enquiry from ${oneLine(enquiry.name)} from Website`,
        text,
        html,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Enquiry email failed (${enquiryId}):`, message);
      await prisma.enquiry.update({
        where: { id: enquiryId },
        data: { emailStatus: EmailStatus.FAILED, emailAttempts: { increment: 1 }, emailError: message.slice(0, 1000) },
      });
      return EmailStatus.FAILED;
    }

    await prisma.enquiry.update({
      where: { id: enquiryId },
      data: { emailStatus: EmailStatus.SENT, emailAttempts: { increment: 1 }, emailSentAt: new Date(), emailError: null },
    });
    return EmailStatus.SENT;
  } catch (err) {
    console.error(`Enquiry email bookkeeping failed (${enquiryId}):`, err);
    return EmailStatus.FAILED;
  }
}
