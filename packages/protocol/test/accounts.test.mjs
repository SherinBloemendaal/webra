// Shared account validators (packages/protocol/src/accounts.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SITE_SETTINGS,
  emailKey,
  FieldError,
  flagsToMask,
  isReservedUsername,
  maskEmail,
  maskToFlags,
  mergeSiteSettings,
  normalizeSiteSettings,
  usernameKey,
  validDisplayName,
  validEmail,
  validFlags,
  validNewPassword,
  validUsername,
  validateSettingsDocument,
  UI_SCALE_LIMITS,
  GAME_SCALE_LIMITS,
  MUSIC_REPEAT_MODES,
} from '../src/index.js';

const throwsField = (fn, field) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof FieldError, String(e));
    if (field) assert.equal(e.field, field);
    return true;
  });

test('usernames: normalization, character rules, scripts, reserved names, folding', () => {
  assert.equal(validUsername('  Tanya   Adams '), 'Tanya Adams');
  assert.equal(validUsername('Ольга'), 'Ольга');
  assert.equal(validUsername('東京_99'), '東京_99');
  assert.equal(validUsername('école'), 'école', 'NFC');
  for (const bad of ['ab', 'x'.repeat(25), '_lead', 'a@b', 'bad!', 'rtl‮evil', 'zero​width', 'Pаypal', 'Admin', 'a.d.m.i.n', 'MOD', 42, null]) {
    throwsField(() => validUsername(bad), 'username');
  }
  assert.equal(usernameKey('ＴＡＮＹＡ'), usernameKey('tanya'));
  assert.equal(usernameKey('Straße'), 'straße');
  assert.equal(isReservedUsername('Web-RA'), true);
});

test('emails: shape, normalization, masking', () => {
  assert.equal(validEmail(' John.Doe+wra@Example.COM '), 'John.Doe+wra@example.com');
  assert.equal(emailKey('John@example.com'), 'john@example.com');
  for (const bad of ['plain', '@x.com', 'a@b', 'a@@b.com', 'a b@c.com', '.a@b.com', 'a..b@c.com', 'a@b..com', 'a@-b.com', 'ü@b.com', 'a@b.123', `${'x'.repeat(65)}@b.com`]) {
    throwsField(() => validEmail(bad), 'email');
  }
  assert.equal(maskEmail('tanya@example.com'), 't***@example.com');
  assert.equal(maskEmail(null), null);
});

test('passwords: length in code points, NFC, not the username or email, not common', () => {
  assert.equal(validNewPassword('a long pass phrase'), 'a long pass phrase');
  assert.equal(validNewPassword('😀😁😂🤣😃😄😅😆😉😊').length, 20, 'emoji count as one character each');
  throwsField(() => validNewPassword('😀😁😂🤣😃😄😅😆😉'), 'password');
  throwsField(() => validNewPassword('x'.repeat(129)), 'password');
  throwsField(() => validNewPassword('qwertyuiop'), 'password');
  throwsField(() => validNewPassword('aaaaaaaaaaaa'), 'password');
  throwsField(() => validNewPassword('LongUsername', { username: 'longusername' }), 'password');
  throwsField(() => validNewPassword('me@example.com', { email: 'ME@example.com' }, 'newPassword'), 'newPassword');
});

test('profile values and flags', () => {
  assert.equal(validDisplayName(' Tanya  A. '), 'Tanya A.');
  throwsField(() => validDisplayName(''), 'displayName');
  assert.deepEqual(validFlags(['content_autoinstall', 'content_autoinstall']), ['content_autoinstall']);
  throwsField(() => validFlags(['root']), 'flags');
  assert.deepEqual(maskToFlags(flagsToMask(['content_autoinstall'])), ['content_autoinstall']);
  assert.deepEqual(maskToFlags(0), []);
});

test('settings document: every section optional, strict keys, free-form extra with limits', () => {
  assert.deepEqual(validateSettingsDocument({}), {});
  const doc = { game: { hotkeys: { 'group.select:1': ['1'] } }, extra: { a: [1, { b: null }] } };
  assert.deepEqual(validateSettingsDocument(doc), doc);
  throwsField(() => validateSettingsDocument({ game: { edgeScrollSpeed: NaN } }), 'settings.game.edgeScrollSpeed');
  throwsField(() => validateSettingsDocument({ game: { edgeScrollSpeed: '1' } }), 'settings.game.edgeScrollSpeed');
  throwsField(() => validateSettingsDocument({ audio: [] }), 'settings.audio');
  throwsField(() => validateSettingsDocument({ extra: { 'bad key': 1 } }), 'settings.extra');
  throwsField(() => validateSettingsDocument({ extra: { a: Array(65).fill(0) } }), 'settings.extra.a');
  throwsField(() => validateSettingsDocument({ lobby: { color: 8 } }), 'settings.lobby.color');
  throwsField(() => validateSettingsDocument({ game: { hotkeys: { a: ['Ctrl A'] } } }), 'settings.game.hotkeys.a[0]');
  throwsField(() => validateSettingsDocument({ content: { packs: [{ id: 'x\u0007', enabled: true }] } }), 'settings.content.packs[0].id');
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`a${i}`, []]));
  throwsField(() => validateSettingsDocument({ game: { hotkeys: many } }), 'settings.game.hotkeys');
});

test('settings document: UI and game scale take "auto" or a factor in their limits; music settings', () => {
  const doc = {
    game: { uiScale: 'auto', gameScale: 1.5 },
    audio: { musicOn: false, musicShuffle: true, musicRepeat: 'one' },
  };
  assert.deepEqual(validateSettingsDocument(doc), doc);
  for (const [key, limits] of [
    ['uiScale', UI_SCALE_LIMITS],
    ['gameScale', GAME_SCALE_LIMITS],
  ]) {
    assert.deepEqual(validateSettingsDocument({ game: { [key]: limits.min } }), { game: { [key]: limits.min } });
    assert.deepEqual(validateSettingsDocument({ game: { [key]: limits.max } }), { game: { [key]: limits.max } });
    for (const bad of [limits.min - 0.01, limits.max + 0.01, 'Auto', '1', null, NaN, Infinity, true]) {
      throwsField(() => validateSettingsDocument({ game: { [key]: bad } }), `settings.game.${key}`);
    }
  }
  assert.deepEqual(UI_SCALE_LIMITS, { min: 0.5, max: 2, step: 0.05 });
  assert.deepEqual(GAME_SCALE_LIMITS, { min: 0.5, max: 3, step: 0.05 });
  for (const mode of MUSIC_REPEAT_MODES) assert.doesNotThrow(() => validateSettingsDocument({ audio: { musicRepeat: mode } }));
  throwsField(() => validateSettingsDocument({ audio: { musicRepeat: 'never' } }), 'settings.audio.musicRepeat');
  throwsField(() => validateSettingsDocument({ audio: { musicOn: 1 } }), 'settings.audio.musicOn');
  throwsField(() => validateSettingsDocument({ audio: { musicShuffle: 'yes' } }), 'settings.audio.musicShuffle');
});

test('site settings: merge, validation, stored values over defaults', () => {
  const next = mergeSiteSettings(DEFAULT_SITE_SETTINGS, { login: { discord: false }, motd: '  Hello\r\nworld  ' });
  assert.equal(next.login.discord, false);
  assert.equal(next.login.password, true);
  assert.equal(next.motd, 'Hello\nworld');
  assert.equal(DEFAULT_SITE_SETTINGS.login.discord, true, 'defaults untouched');
  throwsField(() => mergeSiteSettings(DEFAULT_SITE_SETTINGS, { login: { sms: true } }), 'settings.login.sms');
  throwsField(() => mergeSiteSettings(DEFAULT_SITE_SETTINGS, { onlineRequiresAccount: 1 }), 'settings.onlineRequiresAccount');
  const stored = normalizeSiteSettings({ registration: { open: false, approvalRequired: 'x' }, obsolete: true });
  assert.equal(stored.registration.open, false);
  assert.equal(stored.registration.approvalRequired, true, 'bad stored values keep their default');
  assert.equal('obsolete' in stored, false);
});

test('settings documents refuse prototype keys everywhere', () => {
  for (const doc of [
    JSON.parse('{"extra":{"__proto__":{"x":1}}}'),
    { extra: { constructor: { prototype: { x: 1 } } } },
    { extra: { a: { prototype: 1 } } },
    { lobby: { lastOptions: { constructor: 1 } } },
    { game: { hotkeys: { constructor: ['A'] } } },
    JSON.parse('{"game":{"hotkeys":{"__proto__":["A"]}}}'),
    JSON.parse('{"__proto__":{"x":1}}'),
    { audio: JSON.parse('{"__proto__":{"master":1}}') },
  ]) {
    throwsField(() => validateSettingsDocument(doc));
  }
  assert.equal({}.x, undefined);
});
