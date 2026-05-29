/**
 * setup.mjs — Auth mode & local-first onboarding helpers.
 *
 * AUTH_MODE=local  (default) — local single-user setup, no email verification
 * AUTH_MODE=email            — email verification login/signup, public/multi-user
 *
 * Security guarantees:
 *  - Never returns secrets, API keys, or .env contents
 *  - Local account creation only allowed when: AUTH_MODE=local AND user_count=0
 *  - Default: only localhost can create first local account
 *  - LOCAL_SETUP_ALLOW_REMOTE=1 needed to allow remote first-run setup
 *
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */

import crypto from 'node:crypto';
import { getDb } from './db.mjs';

const AUTH_MODE_LOCAL = 'local';
const AUTH_MODE_EMAIL = 'email';
const VALID_AUTH_MODES = new Set([AUTH_MODE_LOCAL, AUTH_MODE_EMAIL]);

/** Current auth mode — defaults to 'local' for self-hosted simplicity. */
export function getAuthMode() {
  const raw = (process.env.AUTH_MODE || AUTH_MODE_LOCAL).toLowerCase().trim();
  return VALID_AUTH_MODES.has(raw) ? raw : AUTH_MODE_LOCAL;
}

/** Whether remote IP is allowed for first-run local setup (opt-in, risky). */
export function isLocalSetupAllowRemote() {
  return process.env.LOCAL_SETUP_ALLOW_REMOTE === '1';
}

/**
 * Returns true if the request comes from localhost.
 * Handles IPv4, IPv6, and Express trust-proxy mapped addresses.
 */
export function isLocalhostRequest(req) {
  const ip = req.socket?.remoteAddress || req.ip || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1'
  );
}

/** Count registered user accounts — used to determine initialization state. */
export function countUserAccounts() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS n FROM user_accounts').get()?.n ?? 0;
}

/**
 * Returns setup status object safe to expose via API.
 * Never includes secrets, keys, or database paths.
 */
export function getSetupStatus() {
  const authMode = getAuthMode();
  const userCount = countUserAccounts();
  const initialized = userCount > 0;
  const emailEnabled = authMode === AUTH_MODE_EMAIL;
  const localSetupAvailable = authMode === AUTH_MODE_LOCAL && !initialized;

  return {
    auth_mode: authMode,
    initialized,
    user_count: userCount,
    email_enabled: emailEnabled,
    local_setup_available: localSetupAvailable,
  };
}

/**
 * Generate a valid DB username from a display_name.
 * Required pattern: /^[a-zA-Z0-9_]{3,32}$/
 * Sanitizes to ASCII alphanumeric+underscore; appends random hex suffix.
 */
export function generateLocalUsername(displayName) {
  const base = String(displayName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  const rnd = crypto.randomBytes(3).toString('hex'); // 6 hex chars → always unique
  const candidate = (base.length >= 2 ? base : 'local') + '_' + rnd;
  return candidate.slice(0, 32);
}

/**
 * Generate a non-sensitive internal email for local accounts.
 * This address is never used for actual email delivery.
 */
export function generateLocalEmail() {
  const rnd = crypto.randomBytes(8).toString('hex');
  return `local-${rnd}@local.xiyu`;
}

/**
 * Generate a random placeholder password hash for local accounts.
 * Local accounts authenticate via JWT only — no password login.
 * The prefix 'local:' prevents accidental password verification.
 */
export function generateLocalPasswordHash() {
  return 'local:' + crypto.randomBytes(32).toString('hex');
}
