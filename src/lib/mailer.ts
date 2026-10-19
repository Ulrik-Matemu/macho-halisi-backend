import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";

let transport: Transporter | null = null;
let warned = false;

// Lazily created so a missing config only matters when mail is actually sent.
export function getMailer(): Transporter | null {
  const user = env.EMAIL_FOR_ENQUIRIES;
  const pass = env.EMAIL_PASSWORD_FOR_ENQUIRIES;
  if (!user || !pass) {
    if (!warned) {
      warned = true;
      console.warn("Enquiry email disabled: EMAIL_FOR_ENQUIRIES / EMAIL_PASSWORD_FOR_ENQUIRIES not set");
    }
    return null;
  }

  transport ??= nodemailer.createTransport({
    host: env.EMAIL_SMTP_HOST,
    port: env.EMAIL_SMTP_PORT,
    secure: env.EMAIL_SMTP_PORT === 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return transport;
}
