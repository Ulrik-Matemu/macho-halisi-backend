import { ErrorRequestHandler } from "express";
import { env } from "../config/env.js";
import { recordServerError } from "./requestMetrics.js";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const status =
    typeof err.status === "number" && err.status >= 400 && err.status < 600
      ? err.status
      : typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  if (status >= 500) {
    recordServerError(req, status, err.message || "Internal server error");
  }

  // 5xx messages come from code, the database or a library and can name
  // tables, columns or file paths; outside development only 4xx messages
  // (deliberately thrown, user-facing) reach the client. The detail is
  // kept in recordServerError above.
  const exposeMessage = status < 500 || env.NODE_ENV === "development";

  res.status(status).json({
    status: "error",
    message: exposeMessage ? err.message || "Internal server error" : "Internal server error",
    ...(env.NODE_ENV === "development" && { stack: err.stack }),
  });
};
