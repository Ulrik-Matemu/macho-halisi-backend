import { ErrorRequestHandler } from "express";
import { env } from "../config/env.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status =
    typeof err.status === "number" && err.status >= 400 && err.status < 600
      ? err.status
      : typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  res.status(status).json({
    status: "error",
    message: err.message || "Internal server error",
    ...(env.NODE_ENV === "development" && { stack: err.stack }),
  });
};
