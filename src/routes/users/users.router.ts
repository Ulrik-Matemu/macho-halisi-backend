import { Router } from "express";
import { Role } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { hashPassword } from "../../lib/password.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { createUserSchema } from "./users.schemas.js";

export const usersRouter = Router();

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
