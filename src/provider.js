import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http';
import { WebError } from '@deepseek-ai/dsh-web';

export const DEFAULT_LIMITS = Object.freeze({
  maxResponseBytes: 5000000,
  maxBodyChars: 100000,
  timeoutMs: 30000,
  maxRedirects: 5,
  userAgent: 'dsh-rule-proxy/0.1.0',
});

export function limitsFor(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const key of ['maxResponseBytes', 'maxBodyChars', 'timeoutMs']) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0 || limits[key] > 2147483647) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isInteger(limits.maxRedirects) || limits.maxRedirects < 0 || limits.maxRedirects > 20) throw new Error('Invalid maxRedirects');
  if (typeof limits.userAgent !== 'string' || /[\r\n]/.test(limits.userAgent)) throw new Error('Invalid userAgent');
  return limits;
}

export class RuleFetchProvider extends HttpFetchProvider {
  id = 'rule-proxy';
  constructor(transport, limits = {}, source = 'web-fetch') {
    super(limitsFor(limits));
    this.transport = transport;
    this.source = source;
  }
  async requestOnce(url, signal) {
    try {
      return await this.transport.request(url, {
        'user-agent': this.limits.userAgent,
        accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
      }, signal, { source: this.source });
    } catch (error) {
      if (error instanceof WebError) throw error;
      if (signal.aborted) throw new WebError('Tool request aborted', 'WEB_ABORTED');
      throw new WebError('Tool request failed', 'WEB_PROVIDER_ERROR');
    }
  }
}
