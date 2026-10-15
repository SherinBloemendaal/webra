// Pure helpers of the website pages (no DOM), so tests can check them:
// the beta badge over the home page's hero and the tags of the changelog.

/**
 * The badge over the hero ("Closed beta · v0.16") and the words of the
 * sign-up buttons, from GET /api/site (registration.open,
 * registration.approvalRequired; docs/accounts-api.md 3) and version.json.
 * `text` is null when neither says anything; `signup` is null when signing
 * up is closed (the buttons then lead to the sign-in); `note` replaces the
 * line under "Ready, commander?" when there is something to add.
 */
export function betaBadge(site, info) {
  const version = typeof info?.version === 'string' && /^\d+\.\d+/.test(info.version) ? `v${info.version.split('.').slice(0, 2).join('.')}` : null;
  const reg = site && typeof site === 'object' && site.registration && typeof site.registration === 'object' ? site.registration : null;
  let stage = null;
  let kind = 'open';
  if (reg?.open === false) {
    stage = 'Sign-ups closed';
    kind = 'closed';
  } else if (reg?.approvalRequired === true) {
    stage = 'Closed beta';
    kind = 'closed';
  } else if (reg) stage = 'Open beta';
  const text = [stage, version].filter(Boolean).join(' · ') || null;
  const signup = reg?.open === false ? null : reg?.approvalRequired === true ? 'Request access' : 'Create account';
  const note =
    reg?.open === false
      ? 'Signing up is closed right now. Accounts that exist can still sign in.'
      : reg?.approvalRequired === true
        ? 'Sign up with a password, a passkey or Discord. An admin approves new accounts during the beta.'
        : null;
  return { text, kind, signup, note };
}

/**
 * The tag in front of a group of changelog entries (the Release notes
 * board: NEW, FIXED), from the section type tools/release-notes.mjs writes.
 * `kind` picks the tag's colour; the word is the signal.
 */
export function releaseTag(type, title) {
  if (type === 'features') return { text: 'New', kind: 'new' };
  if (type === 'fixes') return { text: 'Fixed', kind: 'fixed' };
  if (type === 'performance') return { text: 'Faster', kind: 'new' };
  if (/breaking/.test(type ?? '')) return { text: 'Breaking', kind: 'breaking' };
  if (type === 'reverts') return { text: 'Reverted', kind: 'fixed' };
  return { text: typeof title === 'string' && title.trim() ? title.trim() : 'Changes', kind: 'other' };
}
