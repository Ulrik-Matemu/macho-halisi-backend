import { z } from "zod";
import { Role } from "@prisma/client";

export const createUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters long"),
  role: z.nativeEnum(Role, {
    message: "Role must be one of: ADMIN, EDITOR, AUTHOR, VIEWER",
  }),
});

export const userListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  role: z.nativeEnum(Role).optional(),
});

export const updateUserRoleSchema = z.object({
  role: z.nativeEnum(Role, {
    message: "Role must be one of: ADMIN, EDITOR, AUTHOR, VIEWER",
  }),
});

export const resetUserPasswordSchema = z.object({
  newPassword: z.string().min(8, "Password must be at least 8 characters long"),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UserListQuery = z.infer<typeof userListQuerySchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type ResetUserPasswordInput = z.infer<typeof resetUserPasswordSchema>;
