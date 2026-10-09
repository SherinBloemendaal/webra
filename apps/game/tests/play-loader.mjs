// Register play-hooks.mjs (import this before importing website scripts).
import { register } from 'node:module';

register('./play-hooks.mjs', import.meta.url);
