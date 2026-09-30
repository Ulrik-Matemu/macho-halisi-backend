// Outbound notification hooks. Deliberately no-ops for now — enquiries are
// processed from the dashboard inbox only. When email lands (Resend/SMTP),
// implement it here so the route handlers don't need to change.

export interface NewEnquiryNotice {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export async function notifyNewEnquiry(_enquiry: NewEnquiryNotice): Promise<void> {
  // Intentionally empty — see module comment.
}
