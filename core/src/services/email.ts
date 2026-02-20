import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "noreply@openguardrails.com";
const PLATFORM_URL = process.env.PLATFORM_URL || "https://platform.openguardrails.com";
const DASHBOARD_URL = process.env.DASHBOARD_URL || PLATFORM_URL;

// SMTP_SECURE: "true" | "false" — defaults to true for port 465, false otherwise
const SMTP_SECURE = process.env.SMTP_SECURE !== undefined
  ? process.env.SMTP_SECURE === "true"
  : SMTP_PORT === 465;

const DEV_MODE = !SMTP_HOST;

const transporter = DEV_MODE
  ? null
  : nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

export async function sendVerificationEmail(params: {
  email: string;
  agentName: string;
  emailToken: string;
  apiKeyMasked: string;
}): Promise<void> {
  const verifyUrl = `${PLATFORM_URL}/api/v1/agents/verify-email/${params.emailToken}`;
  const coreLoginUrl = `${PLATFORM_URL}/login`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; color: #1e293b;">
      <h2 style="color: #1e293b;">Verify your OpenGuardrails account</h2>
      <p>Your agent <strong>${params.agentName}</strong> is registered and waiting for your approval.</p>
      <p>Click the button below to verify your email and activate your account:</p>
      <p>
        <a href="${verifyUrl}" style="
          display: inline-block;
          padding: 12px 24px;
          background-color: #2563eb;
          color: white;
          text-decoration: none;
          border-radius: 6px;
          font-weight: 600;
        ">Verify Email & Activate</a>
      </p>
      <p style="color: #6b7280; font-size: 14px;">
        Or copy this link:<br>
        <a href="${verifyUrl}">${verifyUrl}</a>
      </p>

      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">

      <h3 style="font-size: 15px; color: #334155;">Your credentials</h3>
      <table style="font-size: 13px; border-collapse: collapse; width: 100%; margin: 12px 0;">
        <tr>
          <td style="padding: 6px 10px; color: #64748b; white-space: nowrap;">Email</td>
          <td style="padding: 6px 10px; font-weight: 600;">${params.email}</td>
        </tr>
        <tr>
          <td style="padding: 6px 10px; color: #64748b; white-space: nowrap;">API Key</td>
          <td style="padding: 6px 10px;"><code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${params.apiKeyMasked}</code></td>
        </tr>
      </table>

      <h3 style="font-size: 15px; color: #334155; margin-top: 20px;">How to sign in</h3>

      <p style="font-size: 14px; margin-bottom: 4px;">
        <strong>Core</strong> &mdash; account, quota, billing
      </p>
      <p style="font-size: 13px; color: #475569; margin-bottom: 12px;">
        Go to <a href="${coreLoginUrl}">${coreLoginUrl}</a> and sign in with your email + API key.
      </p>

      <p style="font-size: 14px; margin-bottom: 4px;">
        <strong>Dashboard</strong> &mdash; detection results, agent monitoring
      </p>
      <p style="font-size: 13px; color: #475569; margin-bottom: 12px;">
        Go to <a href="${DASHBOARD_URL}">${DASHBOARD_URL}</a> and sign in with your email + API key.
      </p>

      <p style="font-size: 13px; color: #64748b; margin-top: 16px;">
        Both platforms use the same credentials. If you register more agents
        with the same email, they will all appear under one account.
      </p>

      <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">
        After verification you'll receive <strong>100,000 free</strong> security checks.
      </p>
    </div>
  `;

  if (DEV_MODE) {
    console.log(`\n[email] DEV MODE — would send verification email to ${params.email}`);
    console.log(`[email] Verify URL: ${verifyUrl}\n`);
    return;
  }

  await transporter!.sendMail({
    from: SMTP_FROM,
    to: params.email,
    subject: `Verify your OpenGuardrails account for ${params.agentName}`,
    html,
  });
}
