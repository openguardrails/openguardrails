/** Telling the person: the channels a rule can send a message to. */
import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export interface Message {
  subject: string;
  text: string;
}

export type EmailChannel = NonNullable<NonNullable<Config["notify"]>["email"]>;

/** The SMTP password, from the config or from the environment variable it names. */
export function smtpPassword(email: EmailChannel, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return email.smtp.password ?? (email.smtp.passwordEnv ? env[email.smtp.passwordEnv] : undefined);
}

export async function sendEmail(email: EmailChannel, message: Message): Promise<void> {
  const password = smtpPassword(email);
  if (!password) throw new Error(`no SMTP password: set notify.email.smtp.password or the variable ${email.smtp.passwordEnv ?? "named by passwordEnv"}`);
  const transport = nodemailer.createTransport({
    host: email.smtp.host,
    port: email.smtp.port ?? 465,
    secure: email.smtp.secure ?? true,
    auth: { user: email.smtp.user, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({ from: email.from ?? email.smtp.user, to: email.to, subject: message.subject, text: message.text });
  } finally {
    transport.close();
  }
}

/** Sends to each named channel. A failure is reported, never thrown: a rule's alert must not end the run. */
export async function notify(config: Config, channels: string[], message: Message): Promise<string[]> {
  const failures: string[] = [];
  for (const channel of channels) {
    try {
      if (channel === "email" && config.notify?.email) await sendEmail(config.notify.email, message);
      else throw new Error(`no channel "${channel}" in notify`);
    } catch (error) {
      failures.push(`${channel}: ${(error as Error).message}`);
    }
  }
  return failures;
}
