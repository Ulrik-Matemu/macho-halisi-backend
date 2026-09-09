import pg from "pg";
import { env } from "../config/env.js";

export const pool = new pg.Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
});
