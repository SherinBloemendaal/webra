// A small path router for the account and admin API: `:name` segments
// capture URL-decoded path parts; a path that matches with another method
// answers 405 with Allow.

import { HttpError } from '../http.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, options = {}) {
    const names = [];
    const re = new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ method, re, names, handler, options });
    return this;
  }

  /** { handler, params, options } for a request, null for an unknown path; throws 405. */
  match(method, path) {
    const allowed = [];
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method) {
        allowed.push(r.method);
        continue;
      }
      const params = {};
      try {
        r.names.forEach((n, i) => {
          params[n] = decodeURIComponent(m[i + 1]);
        });
      } catch {
        throw new HttpError(404, 'not_found', 'No such API endpoint.');
      }
      return { handler: r.handler, params, options: r.options };
    }
    if (allowed.length) throw new HttpError(405, 'bad_message', 'Method not allowed.', { allow: [...new Set(allowed)].join(', ') });
    return null;
  }
}
