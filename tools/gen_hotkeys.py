#!/usr/bin/env python3
"""Generate apps/game/js/openra-hotkeys.js: OpenRA's Red Alert hotkey defaults.

Input (OpenRA, GPL-3.0, copied into data/source/hotkeys, see data/CATALOG.md):
- mods/common/hotkeys/{game,observer,production-common,supportpowers,
  viewport,chat,control-groups}.yaml and mods/ra/hotkeys.yaml (ra.yaml):
  every hotkey definition with its default key, types and contexts, in the
  order mods/ra/mod.yaml loads them (the editor's hotkeys are left out: WebRA's
  map editor is a separate page).
- mods/common/fluent/hotkeys.ftl and mods/ra/fluent/hotkeys.ftl
  (ra-hotkeys.ftl): the descriptions shown in OpenRA's hotkey settings.

Output, for apps/game/js/hotkeys.js and the actions that register with it:
- OPENRA_HOTKEYS[name] = { key, description, types, contexts, readonly }:
  `key` is OpenRA's default as a WebRA combo ("Ctrl+X", "NumpadEnter",
  "F1"), or null when OpenRA has none. The macOS "Meta" variants of the
  control group keys are the same combos (WebRA counts Cmd as Ctrl).
- HOTKEY_GROUPS: the sections of OpenRA's hotkey settings
  (mods/common/chrome/settings-hotkeys.yaml HotkeyGroups, names from
  mods/common/fluent/chrome.ftl), each with the hotkey types it shows.

Run: python3 tools/gen_hotkeys.py (CI checks the output is up to date).
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'source', 'hotkeys')
OUT = os.path.join(ROOT, 'apps', 'game', 'js', 'openra-hotkeys.js')
OPENRA_COMMIT = 'b6fc03fcfaef1277592bbd4cbc7d44dd85219902'

# mods/ra/mod.yaml Hotkeys, without common|hotkeys/editor.yaml.
FILES = ['game', 'observer', 'production-common', 'supportpowers', 'viewport', 'chat', 'control-groups', 'ra']

# settings-hotkeys.yaml HotkeyGroups (editor commands left out), with the
# chrome.ftl names of their headers.
GROUPS = [
    ('Game Commands', ['OrderGenerator', 'World', 'Menu']),
    ('Viewport Commands', ['Viewport']),
    ('Observer / Replay Commands', ['Observer', 'Replay']),
    ('Unit Commands', ['Unit']),
    ('Unit Stance Commands', ['Stance']),
    ('Production Commands', ['Production', 'ProductionSlot']),
    ('Support Power Commands', ['SupportPower']),
    ('Music Commands', ['Music']),
    ('Chat Commands', ['Chat']),
    ('Control Groups', ['ControlGroups']),
]

# OpenRA key names (OpenRA.Game/Input/Keycode.cs) to WebRA key names (js/hotkeys.js keyName).
KEYS = {
    'SPACE': 'Space', 'HOME': 'Home', 'PAUSE': 'Pause', 'COMMA': ',', 'PERIOD': '.',
    'KP_ENTER': 'NumpadEnter', 'RETURN': 'Enter', 'TAB': 'Tab',
    'UP': 'ArrowUp', 'DOWN': 'ArrowDown', 'LEFT': 'ArrowLeft', 'RIGHT': 'ArrowRight',
    'LEFTBRACKET': '[', 'RIGHTBRACKET': ']', 'EQUALS': '=', 'MINUS': '-',
    'AUDIOSTOP': 'MediaStop', 'AUDIOPLAY': 'MediaPlayPause', 'AUDIOPREV': 'MediaTrackPrevious', 'AUDIONEXT': 'MediaTrackNext',
}
MODIFIERS = {'ctrl': 'Ctrl', 'alt': 'Alt', 'shift': 'Shift', 'meta': 'Ctrl'}


def parse_yaml(text):
    """OpenRA MiniYaml hotkey definitions: name -> {value, fields}."""
    out = {}
    current = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        depth = len(line) - len(line.lstrip('\t'))
        key, _, value = line.strip().partition(':')
        if depth == 0:
            current = {'value': value.strip(), 'fields': {}}
            out[key.strip()] = current
        elif depth == 1:
            current['fields'][key.strip()] = value.strip()
    return out


def parse_ftl(text):
    out = {}
    for line in text.splitlines():
        m = re.match(r'^([a-z0-9-]+) = (.+)$', line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def combo(value):
    """'X Ctrl' -> 'Ctrl+X', 'EQUALS Alt, Shift' -> 'Alt+Shift+=', '' -> None."""
    if not value:
        return None
    parts = value.split(' ', 1)
    key = parts[0].strip()
    mods = [m.strip().lower() for m in parts[1].split(',')] if len(parts) > 1 else []
    up = key.upper()
    if re.fullmatch(r'[A-Z]', up):
        name = up
    elif re.fullmatch(r'F([1-9]|1[0-2])', up):
        name = up
    elif up.startswith('NUMBER_'):
        name = up[len('NUMBER_'):]
    elif up in KEYS:
        name = KEYS[up]
    else:
        sys.exit(f'unknown OpenRA key {key!r}')
    for m in mods:
        if m not in MODIFIERS:
            sys.exit(f'unknown OpenRA modifier {m!r}')
    order = [n for n in ['Ctrl', 'Alt', 'Shift'] if n in {MODIFIERS[m] for m in mods}]
    return '+'.join(order + [name])


def main():
    ftl = {}
    for name in ['hotkeys.ftl', 'ra-hotkeys.ftl']:
        with open(os.path.join(SRC, name), encoding='utf-8') as fh:
            ftl.update(parse_ftl(fh.read()))
    hotkeys = {}
    for f in FILES:
        with open(os.path.join(SRC, f + '.yaml'), encoding='utf-8') as fh:
            for name, d in parse_yaml(fh.read()).items():
                fields = d['fields']
                desc = fields.get('Description', '')
                hotkeys[name] = {
                    'key': combo(d['value']),
                    'description': ftl.get(desc, desc),
                    'types': [t.strip() for t in fields.get('Types', '').split(',') if t.strip()],
                    'contexts': [c.strip() for c in fields.get('Contexts', '').split(',') if c.strip()],
                    'readonly': fields.get('Readonly', '').lower() == 'true',
                }
    types = {t for h in hotkeys.values() for t in h['types']}
    grouped = {t for _, ts in GROUPS for t in ts}
    missing = types - grouped
    if missing:
        sys.exit(f'hotkey types without a group: {sorted(missing)}')
    lines = [
        '// Generated by tools/gen_hotkeys.py from data/source/hotkeys (OpenRA mods/common/hotkeys and',
        f'// mods/ra/hotkeys.yaml at commit {OPENRA_COMMIT}, GPL-3.0). Do not edit.',
        '',
        f"export const OPENRA_COMMIT = '{OPENRA_COMMIT}';",
        '',
        '/** OpenRA hotkey name -> { key (WebRA combo or null), description, types, contexts, readonly }. */',
        'export const OPENRA_HOTKEYS = Object.freeze({',
    ]
    for name, h in hotkeys.items():
        lines.append(f'  {name}: Object.freeze({json.dumps(h, ensure_ascii=False)}),')
    lines += [
        '});',
        '',
        "/** Sections of OpenRA's hotkey settings and the hotkey types each shows. */",
        'export const HOTKEY_GROUPS = Object.freeze([',
    ]
    for label, ts in GROUPS:
        lines.append(f'  Object.freeze({json.dumps({"label": label, "types": ts})}),')
    lines += ['  ]);', '']
    lines[-2] = ']);'
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    print(f'wrote {OUT}: {len(hotkeys)} hotkeys')


if __name__ == '__main__':
    main()
