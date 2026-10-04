import { z } from "zod";
import { EnquiryStatus } from "@prisma/client";

export const enquiryListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.nativeEnum(EnquiryStatus).optional(),
  q: z.string().trim().max(200).optional(),
});

export const updateEnquirySchema = z
  .object({
    status: z.nativeEnum(EnquiryStatus).optional(),
    staffNotes: z.string().trim().max(10_000).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.staffNotes !== undefined, {
    message: "Provide a status or staffNotes to update",
  });

export const enquiryIdSchema = z.string().uuid();

export const ENQUIRY_EXPORT_LIMIT = 5000;

// GET /enquiries/export — the inbox filters, or an explicit id list
// (comma-separated) when exporting a selection.
export const enquiryExportQuerySchema = z.object({
  status: z.nativeEnum(EnquiryStatus).optional(),
  q: z.string().trim().max(200).optional(),
  ids: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.string().uuid()).max(500).optional()),
});

export const bulkEnquirySchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    action: z.enum(["delete", "status"]),
    status: z.nativeEnum(EnquiryStatus).optional(),
  })
  .refine((v) => v.action !== "status" || v.status !== undefined, {
    message: "Provide a status for a status change",
    path: ["status"],
  });

export type EnquiryListQuery = z.infer<typeof enquiryListQuerySchema>;
export type UpdateEnquiryInput = z.infer<typeof updateEnquirySchema>;
export type BulkEnquiryInput = z.infer<typeof bulkEnquirySchema>;
