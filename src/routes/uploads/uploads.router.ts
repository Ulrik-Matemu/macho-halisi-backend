import { Router, RequestHandler } from "express";
import multer from "multer";
import { Role } from "@prisma/client";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { uploadImageBuffer } from "../../lib/cloudinary.js";

// ── Upload Configuration & Limits ──────────────────────────────
export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const CLOUDINARY_FOLDER = "macho-halisi/itineraries";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1, fields: 10 },
});

// The browser-supplied MIME type is only a claim. These check the file's
// leading bytes, so a renamed script or HTML file can't pass as an image.
const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function sniffImageType(buf: Buffer): string | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(buf, ascii("ftyp"), 4) && (startsWith(buf, ascii("avif"), 8) || startsWith(buf, ascii("avis"), 8))) return "image/avif";
  return null;
}

// Middleware to handle single file upload and validation
const handleSingleImageUpload: RequestHandler = (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({
          status: "error",
          message: `File size exceeds the 10MB maximum limit.`,
        });
        return;
      }
      res.status(400).json({
        status: "error",
        message: `Upload error: ${err.message}`,
      });
      return;
    } else if (err) {
      res.status(400).json({
        status: "error",
        message: err.message || "File upload failed",
      });
      return;
    }

    if (!req.file) {
      res.status(400).json({
        status: "error",
        message: 'No image file provided. Please attach a file with field name "image".',
      });
      return;
    }

    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
      res.status(400).json({
        status: "error",
        message: `Invalid file type "${req.file.mimetype}". Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
      });
      return;
    }

    if (!sniffImageType(req.file.buffer)) {
      res.status(400).json({
        status: "error",
        message: "The file's contents are not a valid JPEG, PNG, WebP or AVIF image.",
      });
      return;
    }

    next();
  });
};

export const uploadsRouter = Router();

// Require authentication for all upload routes
uploadsRouter.use(requireAuth);

// POST /uploads/image — Upload image to Cloudinary
uploadsRouter.post(
  "/image",
  requireRole(Role.ADMIN, Role.EDITOR, Role.AUTHOR),
  handleSingleImageUpload,
  async (req, res, next) => {
    try {
      const file = req.file!;
      const result = await uploadImageBuffer(file.buffer, CLOUDINARY_FOLDER);

      res.status(201).json({
        status: "ok",
        url: result.url,
        publicId: result.publicId,
      });
    } catch (err: any) {
      res.status(502).json({
        status: "error",
        message: `Cloudinary upload failed: ${err.message || "Unknown error"}`,
      });
    }
  }
);
