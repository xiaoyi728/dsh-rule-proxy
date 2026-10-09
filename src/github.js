import git from 'isomorphic-git';
import { RuleFetchProvider, limitsFor } from './provider.js';

export class GitHubTools {
  constructor(transport, limits = {}) {
    this.transport = transport;
    this.limits = limitsFor(limits);
    this.apiProvider = new RuleFetchProvider(transport, limits, 'github-api');
  }
  async api(path, signal) {
    const url = new URL(path, 'https://api.github.com');
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) throw new Error('Only public GitHub API URLs are supported');
    return this.apiProvider.fetch({ url: url.toString() }, signal);
  }
  async refs(repository, signal) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) throw new Error('Expected owner/repository');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Git request timeout')), this.limits.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const http = { request: async ({ url, method, headers, body }) => {
      const target = new URL(url);
      if (target.origin !== 'https://github.com' || target.username || target.password) throw new Error('Git endpoint is not github.com');
      if (method && method !== 'GET') throw new Error('Only read-only Git requests are supported');
      if (body) throw new Error('Unexpected Git request body');
      const request = await this.transport.request(target, headers, combined, { source: 'github-git' });
      try {
        if (request.response.status >= 300 && request.response.status < 400) throw new Error('Git redirects are not followed');
        const chunks = [];
        let total = 0;
        for await (const chunk of request.response.body ?? []) {
          total += chunk.length;
          if (total > this.limits.maxResponseBytes) throw new Error('Git response exceeds byte limit');
          chunks.push(chunk);
        }
        return { url: target.toString(), method: 'GET', statusCode: request.response.status,
          statusMessage: request.response.statusText, headers: Object.fromEntries(request.response.headers), body: chunks };
      } finally { await request.close(); }
    } };
    try {
      return await git.listServerRefs({ http, url: `https://github.com/${repository}.git` });
    } finally { clearTimeout(timer); }
  }
}
