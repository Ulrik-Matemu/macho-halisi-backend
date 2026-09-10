import "dotenv/config";
import http from "node:http";
import { generateSync } from "otplib";
import { Role } from "@prisma/client";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { signMfaChallengeToken } from "../src/lib/tokens.js";

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
const TOTAL_TESTS = 16;

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
  console.log("🔐 Running end-to-end Authentication & Authorization verification suite...\n");

  const app = createApp();
  const server = http.createServer(app);

  // Bind to dynamic port to avoid conflicts
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const serverUrl = `http://localhost:${address.port}`;
  console.log(`📡 Temporary test server listening on ${serverUrl}\n`);

  const testEmail = `auth-test-${Date.now()}@test.local`;
  const rawPassword = "CorrectHorseBatteryStaple123!";
  let testUserId: string | null = null;

  try {
    // 0. Seed test user directly with mfaEnabled: false
    const passwordHash = await hashPassword(rawPassword);
    const user = await prisma.user.create({
      data: {
        email: testEmail,
        passwordHash,
        role: Role.AUTHOR,
        mfaEnabled: false,
      },
    });
    testUserId = user.id;
    console.log(`👤 Seeded test user: ${user.id} (${user.email}) with role: ${user.role}, mfaEnabled: false\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 1: Login with mfaEnabled = false -> mfa_enrollment_required
    // ──────────────────────────────────────────────────────────────────────────
    console.log("--- Test 1: Initial login requires MFA enrollment ---");
    const res1 = await makeRequest(serverUrl, "/auth/login", "POST", {}, {
      email: testEmail,
      password: rawPassword,
    });
    const pass1 =
      res1.status === 200 &&
      res1.data?.status === "mfa_enrollment_required" &&
      typeof res1.data?.challengeToken === "string";

    results.push({
      num: 1,
      name: "Unenrolled user login returns mfa_enrollment_required",
      passed: pass1,
      status: res1.status,
      expectedStatus: 200,
      details: `Received status: "${res1.data?.status}", challengeToken present: ${Boolean(res1.data?.challengeToken)}`,
    });
    console.log(pass1 ? "✅ Test 1 PASSED" : `❌ Test 1 FAILED: ${JSON.stringify(res1.data)}`);

    const enrollmentToken = res1.data?.challengeToken;

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 2: POST /auth/mfa/enroll with challenge token -> QR code + secret
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 2: Enroll MFA returns secret and QR code ---");
    const res2 = await makeRequest(
      serverUrl,
      "/auth/mfa/enroll",
      "POST",
      { Authorization: `Bearer ${enrollmentToken}` }
    );
    const pass2 =
      res2.status === 200 &&
      res2.data?.status === "ok" &&
      typeof res2.data?.secret === "string" &&
      typeof res2.data?.qrCodeDataUrl === "string" &&
      res2.data?.qrCodeDataUrl.startsWith("data:image/png;base64,");

    results.push({
      num: 2,
      name: "Enroll MFA returns secret and QR code data URL",
      passed: pass2,
      status: res2.status,
      expectedStatus: 200,
      details: `Secret length: ${res2.data?.secret?.length}, QR code format valid: ${res2.data?.qrCodeDataUrl?.startsWith("data:image/png;base64,")}`,
    });
    console.log(pass2 ? "✅ Test 2 PASSED" : `❌ Test 2 FAILED: ${JSON.stringify(res2.data)}`);

    const mfaSecret = res2.data?.secret;

    // Confirm the secret is stored encrypted, not in plaintext (Phase 1.4).
    const rawStoredSecret = (
      await prisma.user.findUnique({ where: { id: testUserId }, select: { mfaSecret: true } })
    )?.mfaSecret;
    const secretIsEncryptedAtRest = Boolean(rawStoredSecret) && rawStoredSecret !== mfaSecret && rawStoredSecret!.startsWith("v1:");
    console.log(
      secretIsEncryptedAtRest
        ? "   🔐 Confirmed: mfaSecret is stored encrypted at rest, not as plaintext."
        : `   ⚠️  WARNING: stored mfaSecret does not look encrypted (got: ${rawStoredSecret?.slice(0, 12)}...)`
    );

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 3: POST /auth/mfa/enroll/confirm with valid TOTP -> tokens + mfaEnabled true
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 3: Confirm enrollment with TOTP code ---");
    const enrollCode = generateSync({ secret: mfaSecret });
    const res3 = await makeRequest(
      serverUrl,
      "/auth/mfa/enroll/confirm",
      "POST",
      { Authorization: `Bearer ${enrollmentToken}` },
      { code: enrollCode }
    );

    const userAfterEnroll = await prisma.user.findUnique({ where: { id: testUserId } });
    const pass3 =
      res3.status === 200 &&
      res3.data?.status === "ok" &&
      typeof res3.data?.accessToken === "string" &&
      typeof res3.data?.refreshToken === "string" &&
      userAfterEnroll?.mfaEnabled === true;

    results.push({
      num: 3,
      name: "Confirm enrollment issues tokens and sets mfaEnabled=true",
      passed: pass3,
      status: res3.status,
      expectedStatus: 200,
      details: `Tokens received: ${Boolean(res3.data?.accessToken && res3.data?.refreshToken)}, DB mfaEnabled: ${userAfterEnroll?.mfaEnabled}`,
    });
    console.log(pass3 ? "✅ Test 3 PASSED" : `❌ Test 3 FAILED: ${JSON.stringify(res3.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 4: Login when mfaEnabled = true -> returns mfa_required
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 4: Subsequent login requires MFA code ---");
    const res4 = await makeRequest(serverUrl, "/auth/login", "POST", {}, {
      email: testEmail,
      password: rawPassword,
    });
    const pass4 =
      res4.status === 200 &&
      res4.data?.status === "mfa_required" &&
      typeof res4.data?.challengeToken === "string";

    results.push({
      num: 4,
      name: "Enrolled user login returns mfa_required with challengeToken",
      passed: pass4,
      status: res4.status,
      expectedStatus: 200,
      details: `Received status: "${res4.data?.status}", challengeToken present: ${Boolean(res4.data?.challengeToken)}`,
    });
    console.log(pass4 ? "✅ Test 4 PASSED" : `❌ Test 4 FAILED: ${JSON.stringify(res4.data)}`);

    const secondChallengeToken = res4.data?.challengeToken;

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 5: POST /auth/mfa/verify with TOTP code -> access + refresh tokens
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 5: Verify MFA challenge issues tokens ---");
    const verifyCode = generateSync({ secret: mfaSecret });
    const res5 = await makeRequest(serverUrl, "/auth/mfa/verify", "POST", {}, {
      challengeToken: secondChallengeToken,
      code: verifyCode,
    });
    const pass5 =
      res5.status === 200 &&
      res5.data?.status === "ok" &&
      typeof res5.data?.accessToken === "string" &&
      typeof res5.data?.refreshToken === "string";

    results.push({
      num: 5,
      name: "POST /auth/mfa/verify completes 2-step login and issues tokens",
      passed: pass5,
      status: res5.status,
      expectedStatus: 200,
      details: `Tokens received: accessToken=${Boolean(res5.data?.accessToken)}, refreshToken=${Boolean(res5.data?.refreshToken)}`,
    });
    console.log(pass5 ? "✅ Test 5 PASSED" : `❌ Test 5 FAILED: ${JSON.stringify(res5.data)}`);

    let currentAccessToken = res5.data?.accessToken;
    let currentRefreshToken = res5.data?.refreshToken;

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 6 (REGRESSION): the "mfa_required" challenge token issued to this
    // now-enrolled user must NOT be accepted by POST /auth/mfa/enroll. Before
    // the purpose-separation fix, /auth/login minted the same token "purpose"
    // regardless of enrollment state, so this exact call would succeed and
    // silently overwrite the user's real MFA secret — a full 2FA bypass for
    // anyone holding just the password. secondChallengeToken is a signed JWT
    // (not single-use/consumed by Test 5), so it is still valid here.
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 6 (REGRESSION): mfa_challenge token rejected by /auth/mfa/enroll ---");
    const res6 = await makeRequest(
      serverUrl,
      "/auth/mfa/enroll",
      "POST",
      { Authorization: `Bearer ${secondChallengeToken}` }
    );
    const pass6 = res6.status !== 200 && res6.data?.status === "error";

    results.push({
      num: 6,
      name: "REGRESSION: mfa_required challenge token cannot re-enroll an already-enrolled user",
      passed: pass6,
      status: res6.status,
      expectedStatus: 401,
      details: `Response: ${JSON.stringify(res6.data)}`,
    });
    console.log(pass6 ? "✅ Test 6 PASSED" : `❌ Test 6 FAILED (MFA BYPASS STILL POSSIBLE): ${JSON.stringify(res6.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 7 (DEFENSE IN DEPTH): even a correctly-purposed "mfa_enroll" token
    // must be rejected by /auth/mfa/enroll if the target user already has MFA
    // enabled. In normal operation /auth/login never mints such a token for an
    // enrolled user, so this simulates a forged/leaked token to prove the
    // explicit `user.mfaEnabled` guard inside the route itself also holds.
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 7 (DEFENSE IN DEPTH): forged mfa_enroll token rejected for enrolled user ---");
    const forgedEnrollToken = signMfaChallengeToken(testUserId, "mfa_enroll");
    const res7 = await makeRequest(
      serverUrl,
      "/auth/mfa/enroll",
      "POST",
      { Authorization: `Bearer ${forgedEnrollToken}` }
    );
    const pass7 = res7.status === 409 && res7.data?.status === "error";

    results.push({
      num: 7,
      name: "DEFENSE IN DEPTH: forged mfa_enroll token rejected with 409 for already-enrolled user",
      passed: pass7,
      status: res7.status,
      expectedStatus: 409,
      details: `Response: ${JSON.stringify(res7.data)}`,
    });
    console.log(pass7 ? "✅ Test 7 PASSED" : `❌ Test 7 FAILED: ${JSON.stringify(res7.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 8: GET /auth/me with valid access token -> returns user
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 8: Authenticated request to GET /auth/me ---");
    const res8 = await makeRequest(serverUrl, "/auth/me", "GET", {
      Authorization: `Bearer ${currentAccessToken}`,
    });
    const pass8 =
      res8.status === 200 &&
      res8.data?.status === "ok" &&
      res8.data?.user?.id === testUserId &&
      res8.data?.user?.email === testEmail &&
      res8.data?.user?.role === Role.AUTHOR;

    results.push({
      num: 8,
      name: "GET /auth/me successfully authenticates and returns user info",
      passed: pass8,
      status: res8.status,
      expectedStatus: 200,
      details: `Returned user: id=${res8.data?.user?.id}, email=${res8.data?.user?.email}, role=${res8.data?.user?.role}`,
    });
    console.log(pass8 ? "✅ Test 8 PASSED" : `❌ Test 8 FAILED: ${JSON.stringify(res8.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 9: GET /auth/me with NO token -> 401
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 9: GET /auth/me without token is rejected ---");
    const res9 = await makeRequest(serverUrl, "/auth/me", "GET");
    const pass9 = res9.status === 401 && res9.data?.status === "error";

    results.push({
      num: 9,
      name: "GET /auth/me without authorization header returns 401",
      passed: pass9,
      status: res9.status,
      expectedStatus: 401,
      details: `Response: ${JSON.stringify(res9.data)}`,
    });
    console.log(pass9 ? "✅ Test 9 PASSED" : `❌ Test 9 FAILED: ${JSON.stringify(res9.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 10: GET /auth/me with INVALID token -> 401
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 10: GET /auth/me with invalid token is rejected ---");
    const res10 = await makeRequest(serverUrl, "/auth/me", "GET", {
      Authorization: "Bearer invalid.token.value",
    });
    const pass10 = res10.status === 401 && res10.data?.status === "error";

    results.push({
      num: 10,
      name: "GET /auth/me with invalid/malformed token returns 401",
      passed: pass10,
      status: res10.status,
      expectedStatus: 401,
      details: `Response: ${JSON.stringify(res10.data)}`,
    });
    console.log(pass10 ? "✅ Test 10 PASSED" : `❌ Test 10 FAILED: ${JSON.stringify(res10.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 11: requireRole blocks non-Admin user from POST /users -> 403
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 11: requireRole blocks AUTHOR user from ADMIN-only /users route ---");
    const res11 = await makeRequest(
      serverUrl,
      "/users",
      "POST",
      { Authorization: `Bearer ${currentAccessToken}` },
      { email: "irrelevant@test.local", password: "irrelevant123", role: "VIEWER" }
    );
    const pass11 = res11.status === 403 && res11.data?.status === "error";

    results.push({
      num: 11,
      name: "requireRole blocks AUTHOR user from ADMIN-only route with 403",
      passed: pass11,
      status: res11.status,
      expectedStatus: 403,
      details: `Response: ${JSON.stringify(res11.data)}`,
    });
    console.log(pass11 ? "✅ Test 11 PASSED" : `❌ Test 11 FAILED: ${JSON.stringify(res11.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 12: POST /auth/refresh rotates the refresh token (issues BOTH a new
    // access token and a new refresh token, and revokes the presented one).
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 12: Refresh token rotates on use ---");
    const preRotationRefreshToken = currentRefreshToken;
    const res12 = await makeRequest(serverUrl, "/auth/refresh", "POST", {}, {
      refreshToken: preRotationRefreshToken,
    });
    const pass12 =
      res12.status === 200 &&
      res12.data?.status === "ok" &&
      typeof res12.data?.accessToken === "string" &&
      typeof res12.data?.refreshToken === "string" &&
      res12.data?.refreshToken !== preRotationRefreshToken;

    results.push({
      num: 12,
      name: "POST /auth/refresh rotates: returns a new access AND refresh token pair",
      passed: pass12,
      status: res12.status,
      expectedStatus: 200,
      details: `New accessToken: ${Boolean(res12.data?.accessToken)}, new refreshToken differs from presented one: ${res12.data?.refreshToken !== preRotationRefreshToken}`,
    });
    console.log(pass12 ? "✅ Test 12 PASSED" : `❌ Test 12 FAILED: ${JSON.stringify(res12.data)}`);

    if (res12.data?.accessToken) currentAccessToken = res12.data.accessToken;
    const rotatedRefreshToken = res12.data?.refreshToken;

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 13 (REGRESSION): replaying the pre-rotation refresh token (now
    // revoked by Test 12's rotation) must trigger reuse detection, not just a
    // generic "revoked" rejection.
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 13 (REGRESSION): replayed pre-rotation refresh token triggers reuse detection ---");
    const res13 = await makeRequest(serverUrl, "/auth/refresh", "POST", {}, {
      refreshToken: preRotationRefreshToken,
    });
    const pass13 = res13.status === 401 && res13.data?.status === "error";

    results.push({
      num: 13,
      name: "REGRESSION: replayed (already-rotated) refresh token is rejected with 401",
      passed: pass13,
      status: res13.status,
      expectedStatus: 401,
      details: `Response: ${JSON.stringify(res13.data)}`,
    });
    console.log(pass13 ? "✅ Test 13 PASSED" : `❌ Test 13 FAILED: ${JSON.stringify(res13.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 14 (REGRESSION): Test 13's reuse detection must have cascaded to
    // revoke every live token for the user — including the token Test 12's
    // rotation just issued, even though it was never itself replayed. This is
    // the actual security property: a stolen-and-replayed token invalidates
    // the whole session family, so the legitimate holder is also forced to
    // re-authenticate rather than the attacker quietly keeping access.
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 14 (REGRESSION): reuse detection cascades to revoke the whole token family ---");
    const res14 = await makeRequest(serverUrl, "/auth/refresh", "POST", {}, {
      refreshToken: rotatedRefreshToken,
    });
    const pass14 = res14.status === 401 && res14.data?.status === "error";

    results.push({
      num: 14,
      name: "REGRESSION: reuse detection revoked the entire token family, not just the replayed token",
      passed: pass14,
      status: res14.status,
      expectedStatus: 401,
      details: `Response: ${JSON.stringify(res14.data)}`,
    });
    console.log(pass14 ? "✅ Test 14 PASSED" : `❌ Test 14 FAILED: ${JSON.stringify(res14.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 15: POST /auth/logout revokes refresh token. The token family was
    // fully revoked by Test 14, so a fresh session is established first.
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 15: Logout revokes refresh token ---");
    const freshLoginRes = await makeRequest(serverUrl, "/auth/login", "POST", {}, {
      email: testEmail,
      password: rawPassword,
    });
    const freshVerifyRes = await makeRequest(serverUrl, "/auth/mfa/verify", "POST", {}, {
      challengeToken: freshLoginRes.data?.challengeToken,
      code: generateSync({ secret: mfaSecret }),
    });
    const logoutTargetRefreshToken = freshVerifyRes.data?.refreshToken;

    const res15 = await makeRequest(serverUrl, "/auth/logout", "POST", {}, {
      refreshToken: logoutTargetRefreshToken,
    });
    const pass15 =
      res15.status === 200 &&
      res15.data?.status === "ok" &&
      res15.data?.message === "Logged out";

    results.push({
      num: 15,
      name: "POST /auth/logout revokes refresh token",
      passed: pass15,
      status: res15.status,
      expectedStatus: 200,
      details: `Response message: "${res15.data?.message}"`,
    });
    console.log(pass15 ? "✅ Test 15 PASSED" : `❌ Test 15 FAILED: ${JSON.stringify(res15.data)}`);

    // ──────────────────────────────────────────────────────────────────────────
    // TEST 16: Subsequent /auth/refresh with the logged-out token -> 401
    // ──────────────────────────────────────────────────────────────────────────
    console.log("\n--- Test 16: Refresh with logged-out token is rejected ---");
    const res16 = await makeRequest(serverUrl, "/auth/refresh", "POST", {}, {
      refreshToken: logoutTargetRefreshToken,
    });
    const pass16 = res16.status === 401 && res16.data?.status === "error";

    results.push({
      num: 16,
      name: "POST /auth/refresh with logged-out token is rejected with 401",
      passed: pass16,
      status: res16.status,
      expectedStatus: 401,
      details: `Response: ${JSON.stringify(res16.data)}`,
    });
    console.log(pass16 ? "✅ Test 16 PASSED" : `❌ Test 16 FAILED: ${JSON.stringify(res16.data)}`);
  } catch (err: any) {
    console.error("❌ Unexpected test execution error:", err);
  } finally {
    console.log("\n🧹 Cleaning up test data & stopping test server...");
    if (testUserId) {
      await prisma.refreshToken.deleteMany({ where: { userId: testUserId } }).catch(() => {});
      await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log("✅ Cleanup complete — test user and tokens removed.\n");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Summary Report
  // ──────────────────────────────────────────────────────────────────────────
  console.log("==================================================");
  console.log("SUMMARY REPORT: AUTHENTICATION & RBAC TEST SUITE");
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
  if (allPassed && results.length === TOTAL_TESTS) {
    console.log(`🎉 ALL ${results.length}/${TOTAL_TESTS} AUTHENTICATION & RBAC TESTS PASSED`);
    console.log("--------------------------------------------------\n");
  } else {
    console.error(`🚨 TEST FAILURES DETECTED: Passed ${results.filter((r) => r.passed).length}/${results.length}`);
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
