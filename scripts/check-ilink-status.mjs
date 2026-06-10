#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ENV_PATH = path.join(ROOT, '.env');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'bot.db');
// systemd service name — override via env var XIYU_SERVICE_NAME for your deployment.
// Defaults to a generic name; this script gracefully degrades when not running under systemd.
const SERVICE = process.env.XIYU_SERVICE_NAME || 'xiyu-ai.service';

function readEnvFile(file) {
  const env = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return env;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx);
    let value = trimmed.slice(idx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function status(value) {
  return value ? 'SET' : 'EMPTY';
}

function safeExec(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function serviceActive(journal) {
  const systemctlStatus = safeExec('systemctl', ['is-active', SERVICE]).trim();
  if (systemctlStatus) return systemctlStatus === 'active';
  const stateLines = journal
    .split(/\r?\n/)
    .filter(line => line.includes(`Started ${SERVICE}`) || line.includes(`Stopped ${SERVICE}`));
  const lastState = stateLines.at(-1) || '';
  if (lastState.includes(`Started ${SERVICE}`)) return true;
  if (lastState.includes(`Stopped ${SERVICE}`)) return false;
  return null;
}

function serviceEnvPath() {
  const unit = safeExec('systemctl', ['cat', SERVICE])
    || safeExec('cat', [`/etc/systemd/system/${SERVICE}`]);
  const match = unit.match(/^EnvironmentFile=(.+)$/m);
  return match?.[1]?.trim() || null;
}

function latestJournal() {
  return safeExec('journalctl', ['-u', SERVICE, '-n', '500', '--no-pager']);
}

function parseLastGetUpdates(journal) {
  const lines = journal.split(/\r?\n/).filter(line => line.includes('getupdates'));
  const line = lines.at(-1) || '';
  const err = line.match(/errcode=([-0-9]+)/);
  const errmsg = line.match(/errcode=[-0-9][^:]*:?\s*([^,，]+?)(?:，|$)/);
  const timestamp = line.match(/\[([0-9T:.-]+Z)\]/);
  if (!line) return { ok: null, errcode: null, errmsg: null, at: null };
  const errcode = err ? Number(err[1]) : null;
  return {
    ok: errcode === 0 || (errcode === null && !/错误|errcode|session timeout/i.test(line)),
    errcode,
    errmsg: errcode === -14 ? 'session timeout' : (errmsg?.[1]?.trim() || null),
    at: timestamp?.[1] || null,
  };
}

function parseLastSendMessage(journal) {
  const lines = journal.split(/\r?\n/).filter(line => line.includes('sendmessage'));
  const line = lines.at(-1) || '';
  const http = line.match(/HTTP=([0-9]+)/);
  const ret = line.match(/ret=([^ ]+)/);
  const errcode = line.match(/errcode=([^ ]+)/);
  const errmsg = line.match(/errmsg=(.+)$/);
  const timestamp = line.match(/\[([0-9T:.-]+Z)\]/);
  if (!line) return { ok: null, http_status: null, ret: null, errcode: null, errmsg: null, at: null };
  const retValue = ret?.[1] === 'null' ? null : ret?.[1] ?? null;
  const errcodeValue = errcode?.[1] === 'null' ? null : errcode?.[1] ?? null;
  return {
    ok: http?.[1] === '200' && (retValue === null || retValue === '0') && (errcodeValue === null || errcodeValue === '0'),
    http_status: http ? Number(http[1]) : null,
    ret: retValue,
    errcode: errcodeValue,
    errmsg: errmsg?.[1] || null,
    at: timestamp?.[1] || null,
  };
}

function readDbSnapshot() {
  const fallback = {
    last_inbound_message_at: null,
    last_inbound_message_text: null,
    poll_state: { bot_id: null, GET_UPDATES_BUF: 'EMPTY', updated_at: null },
  };
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const inbound = db.prepare(`
      SELECT content, created_at
      FROM wechat_messages
      WHERE direction = 'in'
      ORDER BY id DESC
      LIMIT 1
    `).get();
    const poll = db.prepare(`
      SELECT bot_id, length(buf) AS len, updated_at
      FROM poll_state
      ORDER BY updated_at DESC
      LIMIT 1
    `).get();
    db.close();
    return {
      last_inbound_message_at: inbound?.created_at || null,
      last_inbound_message_text: inbound?.content ? 'SET' : null,
      poll_state: {
        bot_id: poll?.bot_id ? 'SET' : null,
        GET_UPDATES_BUF: poll?.len > 0 ? 'SET' : 'EMPTY',
        updated_at: poll?.updated_at || null,
      },
    };
  } catch {
    return fallback;
  }
}

const envPath = serviceEnvPath() || ENV_PATH;
const env = readEnvFile(envPath);
const journal = latestJournal();
const db = readDbSnapshot();

const output = {
  service_active: serviceActive(journal),
  systemd_env_file: envPath,
  env: {
    ILINK_BASE_URL: status(env.ILINK_BASE_URL),
    ILINK_BOT_TOKEN: status(env.ILINK_BOT_TOKEN),
    ILINK_BOT_ID: status(env.ILINK_BOT_ID),
    ILINK_USER_ID: status(env.ILINK_USER_ID),
    GET_UPDATES_BUF: status(env.GET_UPDATES_BUF),
  },
  last_getupdates: parseLastGetUpdates(journal),
  last_inbound_message_at: db.last_inbound_message_at,
  last_inbound_message_text: db.last_inbound_message_text,
  poll_state: db.poll_state,
  last_sendmessage: parseLastSendMessage(journal),
};

console.log(JSON.stringify(output, null, 2));
