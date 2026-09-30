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

export type EnquiryListQuery = z.infer<typeof enquiryListQuerySchema>;
export type UpdateEnquiryInput = z.infer<typeof updateEnquirySchema>;
