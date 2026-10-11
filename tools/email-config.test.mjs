// Account email for a deploy (tools/email-config.mjs): off without
// EMAIL_FROM, otherwise the committed wrangler.jsonc plus the send_email
// binding restricted to that sender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEPLOY_CONFIG, emailFrom, withEmailBinding, wranglerArgs } from './email-config.mjs';

const WRANGLER = readFileSync(new URL('../apps/server/wrangler.jsonc', import.meta.url), 'utf8');

/** JSONC to a value: comments outside strings removed, trailing commas allowed. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (text.startsWith('//', i)) {
      i = text.indexOf('\n', i) - 1;
      if (i < 0) break;
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

test('email stays off without EMAIL_FROM (an unset repository variable is an empty string)', () => {
  assert.equal(emailFrom({}), null);
  assert.equal(emailFrom({ EMAIL_FROM: '' }), null);
  assert.equal(emailFrom({ EMAIL_FROM: '   ' }), null);
  assert.equal(emailFrom({ EMAIL_FROM: ' noreply@WEBRA.sherin.dev ' }), 'noreply@webra.sherin.dev');
  assert.throws(() => emailFrom({ EMAIL_FROM: 'webra.sherin.dev' }), /not an email address/);
  assert.throws(() => emailFrom({ EMAIL_FROM: 'noreply@localhost' }), /not an email address/);
});

test('the deploy configuration is wrangler.jsonc plus the binding, allowed one sender', () => {
  const committed = parseJsonc(WRANGLER);
  assert.equal(committed.send_email, undefined, 'never committed: it needs the Workers Paid plan');
  const deployed = parseJsonc(withEmailBinding(WRANGLER, 'noreply@webra.sherin.dev'));
  assert.deepEqual(deployed.send_email, [{ name: 'EMAIL', allowed_sender_addresses: ['noreply@webra.sherin.dev'] }]);
  const { send_email: _added, ...rest } = deployed;
  assert.deepEqual(rest, committed, 'everything else unchanged');
  assert.equal(JSON.stringify(deployed).includes('EMAIL_FROM'), false, 'the sender is a variable, set with --var');
  assert.throws(() => withEmailBinding(withEmailBinding(WRANGLER, 'a@example.com'), 'a@example.com'), /already has send_email/);
  assert.throws(() => withEmailBinding('// only a comment {\n', 'a@example.com'), /no top-level object/);
  assert.deepEqual(wranglerArgs('noreply@webra.sherin.dev'), ['--config', DEPLOY_CONFIG, '--var', 'EMAIL_FROM:noreply@webra.sherin.dev']);
});

test('the deploy workflow passes the arguments and ignores the generated file', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /EMAIL_FROM: \$\{\{ vars\.EMAIL_FROM \}\}/);
  assert.match(workflow, /node \.\.\/\.\.\/tools\/email-config\.mjs wrangler-args/);
  // The arguments go to wrangler as separate, quoted words.
  assert.match(workflow, /read -r -a email_args <<< "\$email"/);
  assert.match(workflow, /wrangler deploy \$vars "\$\{email_args\[@\]\}"/);
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.ok(ignore.split('\n').includes(`apps/server/${DEPLOY_CONFIG}`));
});
