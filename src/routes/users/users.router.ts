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
