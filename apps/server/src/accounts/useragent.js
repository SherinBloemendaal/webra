// A short, coarse summary of a User-Agent header ("Firefox on Linux") for
// session lists. Only the summary is stored, never the header itself.

const BROWSERS = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrome\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
  [/\bnode\b|\bundici\b/i, 'Node.js'],
  [/\bcurl\//, 'curl'],
];

const SYSTEMS = [
  [/\bAndroid\b/, 'Android'],
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export function summarizeUserAgent(header) {
  const ua = typeof header === 'string' ? header.slice(0, 512) : '';
  if (!ua) return 'Unknown device';
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Browser';
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
