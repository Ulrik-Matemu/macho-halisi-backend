import "dotenv/config";
import http from "node:http";
import { generateSync } from "otplib";
import { Role } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { decryptMfaSecret } from "../src/lib/mfa.js";
import { seedAdmin } from "./seed-admin.js";

interface TestCaseResult {
  num: number;
  name: string;
  passed: boolean;
  status: number;
  expectedStatus: number;
  details: string;
  error?: string;
}

const results: TestCaseResult[] = [];

async function makeRequest(
  serverUrl: string,
  path: string,
  method: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; data: any; raw: string }> {
  const url = `${serverUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(url, options);
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, raw: text };
}

async function main() {
  console.log("👥 Running User Provisioning & Admin Bootstrap verification suite...\n");

  const app = createApp();
  const server = http.createServer(app);

  // Bind to dynamic port to avoid collisions
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`📡 Test server listening on ${serverUrl}\n`);

  const adminEmail = process.env.INITIAL_ADMIN_EMAIL || "admin@machohalisi.com";
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || "AdminPassword123!";
  const editorEmail = "editor@machohalisi.com";
  const editorPassword = "EditorPassword123!";

  let tempNonAdminUserId: string | null = null;
  let adminAccessToken: string | null = null;
  let adminMfaSecret: string | null = null;

  try {
    // ──────────────────────────────────────────────────────────────────────────
    // 1. BOOTSTRAP: Seed Initial Admin User
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 1. Executing Admin Bootstrap Seed ---");
    const seededAdmin = await seedAdmin();
    const adminInDb = await prisma.user.findUnique({ where: { email: adminEmail } });

    const passBootstrap =
      Boolean(adminInDb) &&
      adminInDb?.role === Role.ADMIN &&
      adminInDb?.email === adminEmail;

    results.push({
      num: 1,
      name: "Admin Bootstrap Seed creates persistent ADMIN user",
      passed: passBootstrap,
      status: passBootstrap ? 200 : 500,
      expectedStatus: 200,
      details: `Admin ID: ${adminInDb?.id}, Role: ${adminInDb?.role}, mfaEnabled: ${adminInDb?.mfaEnabled}`,
    });
    console.log(passBootstrap ? "✅ Bootstrap PASSED\n" : "❌ Bootstrap FAILED\n");

    // ──────────────────────────────────────────────────────────────────────────
    // 2. ADMIN MFA ENROLLMENT & TWO-STEP LOGIN
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 2. Admin Two-Step Authentication & MFA Enrollment ---");

    // Step A: Login -> mfa_enrollment_required or mfa_required
    const loginRes = await makeRequest(serverUrl, "/auth/login", "POST", {}, {
      email: adminEmail,
      password: adminPassword,
    });

    if (loginRes.data?.status === "mfa_enrollment_required") {
      console.log("Admin requires initial MFA enrollment...");
      const enrollmentToken = loginRes.data.challengeToken;

      // Enroll MFA
      const enrollRes = await makeRequest(serverUrl, "/auth/mfa/enroll", "POST", {
        Authorization: `Bearer ${enrollmentToken}`,
      });
      adminMfaSecret = enrollRes.data.secret;

      // Confirm enrollment
      const totpCode = generateSync({ secret: adminMfaSecret! });
      const confirmRes = await makeRequest(
        serverUrl,
        "/auth/mfa/enroll/confirm",
        "POST",
        { Authorization: `Bearer ${enrollmentToken}` },
        { code: totpCode }
      );

      adminAccessToken = confirmRes.data.accessToken;
      console.log("Admin successfully enrolled in MFA and received tokens.");
    } else if (loginRes.data?.status === "mfa_required") {
      console.log("Admin is already enrolled in MFA; performing 2-step verification...");
      const challengeToken = loginRes.data.challengeToken;

      const user = await prisma.user.findUnique({ where: { email: adminEmail } });
      adminMfaSecret = user?.mfaSecret ? decryptMfaSecret(user.mfaSecret) : null;

      const totpCode = generateSync({ secret: adminMfaSecret! });
      const verifyRes = await makeRequest(serverUrl, "/auth/mfa/verify", "POST", {}, {
        challengeToken,
        code: totpCode,
      });

      adminAccessToken = verifyRes.data.accessToken;
      console.log("Admin successfully completed 2-step MFA login.");
    }

    const passAdminAuth = typeof adminAccessToken === "string" && adminAccessToken.length > 0;
    results.push({
      num: 2,
      name: "Admin successfully completes Two-Step MFA login",
      passed: passAdminAuth,
      status: passAdminAuth ? 200 : 401,
      expectedStatus: 200,
      details: `Admin authenticated: ${passAdminAuth}, Token length: ${adminAccessToken?.length}`,
    });
    console.log(passAdminAuth ? "✅ Admin Authentication PASSED\n" : "❌ Admin Authentication FAILED\n");

    // ──────────────────────────────────────────────────────────────────────────
    // 3. PROVISIONING AS ADMIN: POST /users -> Creates EDITOR
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 3. Admin provisions an EDITOR user via POST /users ---");

    // Remove editor if pre-existing from previous run to ensure fresh test
    await prisma.user.deleteMany({ where: { email: editorEmail } });

    const createRes = await makeRequest(
      serverUrl,
      "/users",
      "POST",
      { Authorization: `Bearer ${adminAccessToken}` },
      {
        email: editorEmail,
        password: editorPassword,
        role: "EDITOR",
      }
    );

    const createdEditorInDb = await prisma.user.findUnique({ where: { email: editorEmail } });

    const passCreate =
      createRes.status === 201 &&
      createRes.data?.status === "ok" &&
      createRes.data?.user?.email === editorEmail &&
      createRes.data?.user?.role === "EDITOR" &&
      createRes.data?.user?.passwordHash === undefined &&
      createRes.data?.user?.mfaSecret === undefined &&
      createdEditorInDb !== null &&
      createdEditorInDb?.mfaEnabled === false;

    results.push({
      num: 3,
      name: "Authenticated Admin creates new EDITOR user via POST /users",
      passed: passCreate,
      status: createRes.status,
      expectedStatus: 201,
      details: `Created user ID: ${createRes.data?.user?.id}, Role: ${createRes.data?.user?.role}, DB mfaEnabled: ${createdEditorInDb?.mfaEnabled}, Password leaked: ${createRes.data?.user?.passwordHash !== undefined}`,
    });
    console.log(passCreate ? "✅ User Provisioning PASSED\n" : `❌ User Provisioning FAILED: ${JSON.stringify(createRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // 4. DUPLICATE EMAIL: POST /users with same email -> 409 Conflict
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 4. POST /users with duplicate email returns 409 Conflict ---");
    const duplicateRes = await makeRequest(
      serverUrl,
      "/users",
      "POST",
      { Authorization: `Bearer ${adminAccessToken}` },
      {
        email: editorEmail,
        password: "AnotherPassword123!",
        role: "EDITOR",
      }
    );

    const passDuplicate = duplicateRes.status === 409 && duplicateRes.data?.status === "error";
    results.push({
      num: 4,
      name: "Duplicate email registration rejected with 409 Conflict",
      passed: passDuplicate,
      status: duplicateRes.status,
      expectedStatus: 409,
      details: `Response: ${JSON.stringify(duplicateRes.data)}`,
    });
    console.log(passDuplicate ? "✅ Duplicate Email Check PASSED\n" : `❌ Duplicate Email Check FAILED: ${JSON.stringify(duplicateRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // 5. VALIDATION: POST /users with short password / invalid role -> 400
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 5. POST /users with invalid body returns 400 Bad Request ---");
    const validationRes = await makeRequest(
      serverUrl,
      "/users",
      "POST",
      { Authorization: `Bearer ${adminAccessToken}` },
      {
        email: "bad-user@machohalisi.com",
        password: "123", // too short (< 8)
        role: "SUPERUSER", // invalid enum
      }
    );

    const passValidation = validationRes.status === 400 && validationRes.data?.status === "error";
    results.push({
      num: 5,
      name: "Invalid password (<8 chars) or role rejected with 400 Bad Request",
      passed: passValidation,
      status: validationRes.status,
      expectedStatus: 400,
      details: `Errors: ${JSON.stringify(validationRes.data?.errors)}`,
    });
    console.log(passValidation ? "✅ Validation Guard PASSED\n" : `❌ Validation Guard FAILED: ${JSON.stringify(validationRes.data)}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // 6. UNAUTHENTICATED CALL: POST /users without auth -> 401
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 6. POST /users without auth header returns 401 Unauthorized ---");
    const noAuthRes = await makeRequest(serverUrl, "/users", "POST", {}, {
      email: "unauth@machohalisi.com",
      password: "SomePassword123!",
      role: "VIEWER",
    });

    const passNoAuth = noAuthRes.status === 401 && noAuthRes.data?.status === "error";
    results.push({
      num: 6,
      name: "POST /users without Authorization header returns 401",
      passed: passNoAuth,
      status: noAuthRes.status,
      expectedStatus: 401,
      details: `Response: ${JSON.stringify(noAuthRes.data)}`,
    });
    console.log(passNoAuth ? "✅ Unauthenticated Guard PASSED\n" : `❌ Unauthenticated Guard FAILED\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // 7. NON-ADMIN CALL: POST /users with non-Admin role -> 403 Forbidden
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- 7. POST /users called by non-Admin role returns 403 Forbidden ---");

    // Seed temporary non-admin user
    const tempNonAdminEmail = `temp-author-${Date.now()}@test.local`;
    const tempPassword = "TempPassword123!";
    const tempPasswordHash = await hashPassword(tempPassword);
    const tempUser = await prisma.user.create({
      data: {
        email: tempNonAdminEmail,
        passwordHash: tempPasswordHash,
        role: Role.AUTHOR,
        mfaEnabled: false,
      },
    });
    tempNonAdminUserId = tempUser.id;

    // Log in temp user & complete MFA enrollment
    const tempLoginRes = await makeRequest(serverUrl, "/auth/login", "POST", {}, {
      email: tempNonAdminEmail,
      password: tempPassword,
    });
    const tempEnrollRes = await makeRequest(serverUrl, "/auth/mfa/enroll", "POST", {
      Authorization: `Bearer ${tempLoginRes.data.challengeToken}`,
    });
    const tempCode = generateSync({ secret: tempEnrollRes.data.secret });
    const tempConfirmRes = await makeRequest(
      serverUrl,
      "/auth/mfa/enroll/confirm",
      "POST",
      { Authorization: `Bearer ${tempLoginRes.data.challengeToken}` },
      { code: tempCode }
    );
    const nonAdminAccessToken = tempConfirmRes.data.accessToken;

    // Attempt POST /users with AUTHOR role token
    const nonAdminRes = await makeRequest(
      serverUrl,
      "/users",
      "POST",
      { Authorization: `Bearer ${nonAdminAccessToken}` },
      {
        email: "forbidden@machohalisi.com",
        password: "ForbiddenPass123!",
        role: "VIEWER",
      }
    );

    const passNonAdmin = nonAdminRes.status === 403 && nonAdminRes.data?.status === "error";
    results.push({
      num: 7,
      name: "POST /users called by non-Admin role returns 403 Forbidden",
      passed: passNonAdmin,
      status: nonAdminRes.status,
      expectedStatus: 403,
      details: `Response: ${JSON.stringify(nonAdminRes.data)}`,
    });
    console.log(passNonAdmin ? "✅ RBAC 403 Guard PASSED\n" : `❌ RBAC 403 Guard FAILED\n`);

  } catch (err: any) {
    console.error("❌ Unexpected error during test execution:", err);
  } finally {
    console.log("🧹 Cleaning up temporary non-Admin test user...");
    if (tempNonAdminUserId) {
      await prisma.user.delete({ where: { id: tempNonAdminUserId } }).catch(() => {});
      console.log(`   Cleaned up temp test user: ${tempNonAdminUserId}`);
    }

    // Verify persistent accounts are preserved
    const finalAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
    const finalEditor = await prisma.user.findUnique({ where: { email: editorEmail } });
    console.log(`📌 Persistent accounts preserved in database:`);
    console.log(`   Admin:  ${finalAdmin?.email} (ID: ${finalAdmin?.id}, Role: ${finalAdmin?.role})`);
    console.log(`   Editor: ${finalEditor?.email} (ID: ${finalEditor?.id}, Role: ${finalEditor?.role})`);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("🛑 Test server closed.\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary Report
  // ──────────────────────────────────────────────────────────────────────────
  console.log("==================================================");
  console.log("SUMMARY REPORT: USER PROVISIONING & BOOTSTRAP");
  console.log("==================================================");

  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`\n${icon} [Test ${r.num}] ${r.name}`);
    console.log(`   - HTTP Status: ${r.status} (expected ${r.expectedStatus})`);
    console.log(`   - Details: ${r.details}`);
    if (r.error) {
      console.log(`   - Error: ${r.error}`);
    }
    if (!r.passed) {
      allPassed = false;
    }
  }

  console.log("\n--------------------------------------------------");
  if (allPassed && results.length === 7) {
    console.log(`🎉 ALL ${results.length}/7 USER PROVISIONING & BOOTSTRAP TESTS PASSED`);
    console.log("--------------------------------------------------\n");
  } else {
    console.error(`🚨 FAILURES DETECTED: Passed ${results.filter((r) => r.passed).length}/${results.length}`);
    console.log("--------------------------------------------------\n");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("Fatal error in test runner:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
