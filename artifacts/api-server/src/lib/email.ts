import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { logger } from "./logger";
import { getOrCreateAdminConfig } from "./mintConfig";
import { decryptSecret } from "./cryptoVault";

/**
 * Outbound email via Mailgun SMTP.
 *
 * Configuration resolution order (per field):
 *   1. admin_config row (editable in the admin dashboard, password stored
 *      AES-256-GCM encrypted via cryptoVault)
 *   2. env secrets MAILGUN_SMTP_USER / MAILGUN_SMTP_PASS / OPERATOR_EMAIL
 *
 * The transporter is cached and invalidated whenever settings change
 * (resetEmailTransporter is called by the admin email-settings route).
 */

export interface EmailConfig {
  user: string | null;
  pass: string | null;
  operatorEmail: string | null;
  /** Where each field came from — for the admin UI's "using secret" hint. */
  sources: { user: "db" | "env" | null; pass: "db" | "env" | null; operatorEmail: "db" | "env" | null };
}

let _transporter: Transporter | null = null;
let _transporterKey: string | null = null;
let _warned = false;

/** Resolve the effective email configuration (DB overrides env). */
export async function getEmailConfig(): Promise<EmailConfig> {
  const config = await getOrCreateAdminConfig();

  let dbPass: string | null = null;
  if (config.smtpPassEncrypted) {
    try {
      dbPass = decryptSecret(config.smtpPassEncrypted);
    } catch (err) {
      logger.error({ err }, "Failed to decrypt stored SMTP password — falling back to env secret");
    }
  }

  const user = config.smtpUser ?? process.env["MAILGUN_SMTP_USER"] ?? null;
  const pass = dbPass ?? process.env["MAILGUN_SMTP_PASS"] ?? null;
  const operatorEmail = config.operatorEmail ?? process.env["OPERATOR_EMAIL"] ?? null;

  return {
    user,
    pass,
    operatorEmail,
    sources: {
      user: config.smtpUser ? "db" : process.env["MAILGUN_SMTP_USER"] ? "env" : null,
      pass: dbPass ? "db" : process.env["MAILGUN_SMTP_PASS"] ? "env" : null,
      operatorEmail: config.operatorEmail ? "db" : process.env["OPERATOR_EMAIL"] ? "env" : null,
    },
  };
}

/** Drop the cached transporter so the next send picks up new settings. */
export function resetEmailTransporter(): void {
  _transporter = null;
  _transporterKey = null;
  _warned = false;
}

async function getTransporter(): Promise<Transporter | null> {
  const { user, pass } = await getEmailConfig();

  if (!user || !pass) {
    if (!_warned) {
      _warned = true;
      logger.warn(
        "SMTP user or password is not configured (admin settings or env) — outbound email is disabled",
      );
    }
    return null;
  }

  // Key the cache on the credentials so a settings change takes effect even
  // if resetEmailTransporter was missed.
  const key = `${user}\u0000${pass}`;
  if (!_transporter || _transporterKey !== key) {
    _transporter = nodemailer.createTransport({
      host: "smtp.mailgun.org",
      port: 587,
      secure: false, // STARTTLS
      auth: { user, pass },
    });
    _transporterKey = key;
  }

  return _transporter;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an outbound email via Mailgun SMTP.
 *
 * No-ops (with a warn log) when SMTP is not configured — callers should
 * not crash or surface an error to end-users in that case.
 *
 * @returns true if the message was accepted, false if email is not configured.
 * @throws if the SMTP relay rejects the message.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  const transporter = await getTransporter();
  if (!transporter) {
    logger.warn({ to: opts.to, subject: opts.subject }, "sendEmail: SMTP not configured; skipping");
    return false;
  }

  const from = `lekmint.cash <noreply@lekmint.cash>`;

  await transporter.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
  });

  logger.info({ to: opts.to, subject: opts.subject }, "Email sent via Mailgun SMTP");
  return true;
}

/**
 * Log whether SMTP is configured. Called at startup so the operator
 * knows immediately if email alerts will work.
 */
export async function logSmtpStatus(): Promise<void> {
  try {
    const { user, pass, operatorEmail } = await getEmailConfig();
    if (user && pass) {
      logger.info(
        { operatorEmail: operatorEmail ?? "(not set)" },
        "SMTP configured — outbound email enabled via Mailgun",
      );
      if (!operatorEmail) {
        logger.warn("Operator email is not set — alert emails have no destination");
      }
    } else {
      logger.warn("SMTP user or password missing — outbound email is DISABLED");
    }
  } catch (err) {
    logger.warn({ err }, "Could not check SMTP configuration at startup");
  }
}
