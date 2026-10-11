// Account email (Cloudflare Email Service) for a deploy (docs/deploy.md,
// "Email"), from the environment:
//
//   EMAIL_FROM  the sender address, on a domain onboarded to Email Sending
//               (the repository variable EMAIL_FROM). Unset or empty: email
//               stays off and the deploy is the plain wrangler.jsonc.
//
// Sending needs the Workers Paid plan, and a `send_email` binding in the
// committed wrangler.jsonc would fail every deploy (and `wrangler dev`) until
// the owner has upgraded. So the binding exists only in a configuration the
// deploy writes next to wrangler.jsonc when EMAIL_FROM is set:
//
//   cd apps/server && npx wrangler deploy $(node ../../tools/email-config.mjs wrangler-args)
//
// prints nothing without EMAIL_FROM, else writes apps/server/wrangler.deploy.jsonc
// (wrangler.jsonc plus the binding EMAIL, allowed to send from EMAIL_FROM
// only; git ignored) and prints `--config wrangler.deploy.jsonc --var EMAIL_FROM:<address>`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validEmail } from '../packages/protocol/src/accounts.js';

export const DEPLOY_CONFIG = 'wrangler.deploy.jsonc';

/** The sender of this deploy, or null when email stays off. Throws on a malformed address. */
export function emailFrom(env = process.env) {
  const raw = (env.EMAIL_FROM ?? '').trim();
  if (raw === '') return null;
  try {
    return validEmail(raw);
  } catch {
    throw new Error('EMAIL_FROM is not an email address (for example noreply@webra.sherin.dev)');
  }
}

/** Index of the `{` that opens the top-level object (comments before it are skipped), or -1. */
function topLevelBrace(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      if (end < 0) return -1;
      i = end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (text[i] === '{') {
      return i;
    } else if (!/\s/.test(text[i])) {
      return -1;
    }
  }
  return -1;
}

/**
 * wrangler.jsonc text with the send_email binding EMAIL restricted to
 * `from`, added as the first member of the top-level object (comments and
 * the rest stay as they are). Throws when the configuration already has a
 * send_email entry: then it was added by hand and this would duplicate it.
 */
export function withEmailBinding(configText, from) {
  if (/"send_email"\s*:/.test(configText)) throw new Error('wrangler.jsonc already has send_email; remove it (the deploy adds it from EMAIL_FROM)');
  const open = topLevelBrace(configText);
  if (open < 0) throw new Error('wrangler.jsonc has no top-level object');
  const binding = `\n  // Added by tools/email-config.mjs for this deploy (EMAIL_FROM): account email (src/accounts/email.js).\n  "send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ${JSON.stringify([from])} }],`;
  return `${configText.slice(0, open + 1)}${binding}${configText.slice(open + 1)}`;
}

/** wrangler deploy arguments for the written configuration and the sender variable. */
export function wranglerArgs(from) {
  return ['--config', DEPLOY_CONFIG, '--var', `EMAIL_FROM:${from}`];
}

function main(argv, env = process.env) {
  const [command] = argv;
  if (command !== 'wrangler-args') throw new Error('usage: node tools/email-config.mjs wrangler-args');
  const from = emailFrom(env);
  if (!from) return '';
  const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'server');
  writeFileSync(join(server, DEPLOY_CONFIG), withEmailBinding(readFileSync(join(server, 'wrangler.jsonc'), 'utf8'), from));
  return wranglerArgs(from).join(' ');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`email-config: ${err.message}`);
    process.exit(1);
  }
}
