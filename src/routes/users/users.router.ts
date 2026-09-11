import { Router } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { hashPassword } from "../../lib/password.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  createUserSchema,
  userListQuerySchema,
  updateUserRoleSchema,
  resetUserPasswordSchema,
} from "./users.schemas.js";

export const usersRouter = Router();

// Shared projection for every user-management response below — never
// includes passwordHash or mfaSecret.
const userSelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  mfaEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

// POST /users — Admin-only user provisioning
usersRouter.post("/", requireAuth, requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const parseResult = createUserSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Validation failed",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { email, password, role } = parseResult.data;

    // Check if user already exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({
        status: "error",
        message: "A user with this email already exists",
      });
      return;
    }

    const passwordHash = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role,
        mfaEnabled: false,
      },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    res.status(201).json({
      status: "ok",
      user,
    });
  } catch (err) {
    next(err);
  }
});

// GET /users — Admin-only paginated user list
usersRouter.get("/", requireAuth, requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const parseResult = userListQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Invalid query parameters",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const { page, limit, role } = parseResult.data;
    const skip = (page - 1) * limit;
    const where = role ? { role } : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: userSelect,
      }),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    res.json({
      status: "ok",
      data: users,
      pagination: { page, limit, total, totalPages },
    });
  } catch (err) {
    next(err);
  }
});

// GET /users/:id — Admin-only single user detail
usersRouter.get("/:id", requireAuth, requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const id = req.params.id as string;

    const user = await prisma.user.findUnique({ where: { id }, select: userSelect });
    if (!user) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }

    res.json({ status: "ok", user });
  } catch (err) {
    next(err);
  }
});

// PATCH /users/:id/role — Admin-only role change
usersRouter.patch("/:id/role", requireAuth, requireRole(Role.ADMIN), async (req, res, next) => {
  try {
    const id = req.params.id as string;

    if (req.user!.userId === id) {
      res.status(400).json({ status: "error", message: "You cannot change your own role." });
      return;
    }

    const parseResult = updateUserRoleSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        status: "error",
        message: "Validation failed",
        errors: parseResult.error.flatten(),
      });
      return;
    }

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!existing) {
      res.status(404).json({ status: "error", message: "User not found" });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role: parseResult.data.role },
      select: userSelect,
    });

    res.json({ status: "ok", user });
  } catch (err) {
    next(err);
  }
});

// POST /users/:id/deactivate — Admin-only account deactivation.
// Blocks the account from logging in (enforced in POST /auth/login) and
// revokes all of the user's active refresh tokens so any live session is
// cut. Their current access token (short-lived, ~15 min) remains valid
// until natural expiry — the same tradeoff POST /:id/mfa/reset already
// makes below, rather than adding a DB lookup to every requireAuth call.
usersRouter.post(
  "/:id/deactivate",
  requireAuth,
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;

      if (req.user!.userId === id) {
        res.status(400).json({ status: "error", message: "You cannot deactivate your own account." });
        return;
      }

      const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!existing) {
        res.status(404).json({ status: "error", message: "User not found" });
        return;
      }

      const [user] = await prisma.$transaction([
        prisma.user.update({ where: { id }, data: { isActive: false }, select: userSelect }),
        prisma.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);

      res.json({ status: "ok", message: "User has been deactivated.", user });
    } catch (err) {
      next(err);
    }
  }
);

// POST /users/:id/reactivate — Admin-only account reactivation
usersRouter.post(
  "/:id/reactivate",
  requireAuth,
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;

      const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!existing) {
        res.status(404).json({ status: "error", message: "User not found" });
        return;
      }

      const user = await prisma.user.update({
        where: { id },
        data: { isActive: true },
        select: userSelect,
      });

      res.json({ status: "ok", message: "User has been reactivated.", user });
    } catch (err) {
      next(err);
    }
  }
);

// POST /users/:id/reset-password — Admin-only password reset.
// Mirrors POST / (create): the admin supplies the new password directly.
// Revokes all active refresh tokens so any live session must re-login with
// the new password.
usersRouter.post(
  "/:id/reset-password",
  requireAuth,
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;

      const parseResult = resetUserPasswordSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({
          status: "error",
          message: "Validation failed",
          errors: parseResult.error.flatten(),
        });
        return;
      }

      const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (!existing) {
        res.status(404).json({ status: "error", message: "User not found" });
        return;
      }

      const passwordHash = await hashPassword(parseResult.data.newPassword);

      const [user] = await prisma.$transaction([
        prisma.user.update({ where: { id }, data: { passwordHash }, select: userSelect }),
        prisma.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);

      res.json({ status: "ok", message: "Password has been reset.", user });
    } catch (err) {
      next(err);
    }
  }
);

// POST /users/:id/mfa/reset — Admin-only MFA reset.
// Clears the target user's mfaSecret/mfaEnabled and revokes all of their
// active refresh tokens, forcing a clean re-enrollment on next login. This
// is the only supported path for resetting an already-enrolled user's MFA;
// POST /auth/mfa/enroll refuses to touch an account that already has MFA
// enabled (see src/routes/auth/auth.router.ts).
usersRouter.post(
  "/:id/mfa/reset",
  requireAuth,
  requireRole(Role.ADMIN),
  async (req, res, next) => {
    try {
      const id = req.params.id as string;

      const existing = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, role: true, mfaEnabled: true },
      });

      if (!existing) {
        res.status(404).json({ status: "error", message: "User not found" });
        return;
      }

      const [user] = await prisma.$transaction([
        prisma.user.update({
          where: { id },
          data: { mfaEnabled: false, mfaSecret: null },
          select: { id: true, email: true, role: true, mfaEnabled: true },
        }),
        prisma.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);

      res.json({
        status: "ok",
        message: "MFA has been reset. The user must re-enroll on next login.",
        user,
      });
    } catch (err) {
      next(err);
    }
  }
);
