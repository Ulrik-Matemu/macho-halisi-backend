import "dotenv/config";
import { notifyNewEnquiry } from "../src/lib/notifications.js";
import { getMailer } from "../src/lib/mailer.js";

const mailer = getMailer();
if (!mailer) {
  console.error("EMAIL_* env vars are not set");
  process.exit(1);
}
await mailer.verify();
console.log("SMTP connection + auth OK");
await notifyNewEnquiry({
  id: "test",
  name: "Test Guest",
  email: "guest@example.com",
  phone: "+255700000000",
  partySize: "2",
  preferredDates: "Next July",
  message: "Test message <b>escaped?</b>",
  itineraryTitle: "Sample safari",
  createdAt: new Date(),
});
console.log("Test enquiry email sent");
