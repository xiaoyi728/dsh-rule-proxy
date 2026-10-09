// Browser module consumed by the DSH module loader; no global network hooks.
//
// Configuration is read and written through the host's own endpoint rather
// than ctx.configForms: that service ships with
// @deepseek-ai/dsh-client-ui-settings, which a profile need not install, and
// dsh 0.2 removed the older ctx.settingsScope. The registration id MUST be the
// package name, because dsh-client-modules looks the factory up by row id.
window.__ModuleLoader__.load({
  id: 'dsh-rule-proxy',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useSyncExternalStore, useCallback, useRef } = React;
    const inject = ['slots'];
    const API_BASE = '/dsh-rule-proxy/api';

    function fetchJson(path, options) {
      return fetch(API_BASE + path, options)
        .then(res => res.json().catch(() => ({})))
        .catch(() => null);
    }

    // One module-level store: contributors live in different React trees and
    // must never observe different snapshots.
    let store = null;
    function proxyStore() {
      if (store !== null) return store;
      let snapshot = { status: 'loading', value: undefined, writable: false, error: '' };
      const listeners = new Set();
      let inflight = null;
      const same = (a, b) => a.status === b.status && a.writable === b.writable && a.error === b.error && JSON.stringify(a.value) === JSON.stringify(b.value);
      const emit = next => {
        if (same(snapshot, next)) return;
        snapshot = next;
        for (const listener of [...listeners]) listener();
      };
      const accept = data => {
        if (data === null || data.ok !== true || data.config === undefined) {
          emit({ status: 'unavailable', value: undefined, writable: false, error: (data && data.error) || '' });
          return;
        }
        emit({ status: 'ready', value: data.config, writable: data.writable !== false, error: '' });
      };
      const refresh = () => {
        if (inflight !== null) return inflight;
        inflight = fetchJson('/config').then(data => { inflight = null; accept(data); }, () => { inflight = null; });
        return inflight;
      };
      const set = patch => fetchJson('/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).then(data => {
        if (data === null || data.ok !== true) {
          const message = (data && data.error) || '配置写入失败';
          emit({ ...snapshot, error: message });
          throw new Error(message);
        }
        accept(data);
      }, error => { emit({ ...snapshot, error: '无法连接宿主配置接口' }); throw error; });
      store = { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, getSnapshot: () => snapshot, refresh, set };
      return store;
    }

    function useConfig(shared) {
      const subscribe = useCallback(fn => shared.subscribe(fn), [shared]);
      const getSnapshot = useCallback(() => shared.getSnapshot(), [shared]);
      const snapshot = useSyncExternalStore(subscribe, getSnapshot);
      useEffect(() => { shared.refresh(); }, [shared]);
      return snapshot;
    }

    // Structural validation mirroring the host RE2 engine, so an invalid rule
    // is refused here instead of failing plugin activation on the next boot.
    function validateRules(rules) {
      if (!Array.isArray(rules) || rules.length > 256) throw new Error('规则必须为数组且不超过 256 项');
      rules.forEach((rule, index) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).length !== 5 || !['include', 'type', 'title', 'pattern', 'active'].every(key => Object.hasOwn(rule, key))) throw new Error(`规则 ${index}: 字段必须为 include、type、title、pattern、active`);
        if (rule.include !== 'include' || !['regex', 'domain'].includes(rule.type)) throw new Error(`规则 ${index}: 只支持 include/regex 或 include/domain`);
        if (typeof rule.active !== 'boolean' || typeof rule.title !== 'string' || rule.title.length > 256 || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > 512) throw new Error(`规则 ${index}: 字段类型或长度无效`);
        if (rule.type === 'domain' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(rule.pattern)) throw new Error(`规则 ${index}: domain 须为小写域名，不含通配符或路径`);
        if (rule.type === 'regex') {
          try { new RegExp(rule.pattern, 'u'); } catch { throw new Error(`规则 ${index}: 正则表达式语法无效`); }
          // Pre-check only: JavaScript accepts constructs RE2 rejects, so the
          // host RE2 engine remains the authority on the final decision.
          if (/\\[1-9]/.test(rule.pattern) || /\(\?(=|!|<=|<!)/.test(rule.pattern)) throw new Error(`规则 ${index}: 宿主使用 RE2，不支持反向引用或先行断言`);
        }
      });
    }

    // Safe count for a possibly half-typed draft: never throw while editing.
    function ruleCount(text, saved) {
      if (text === null) return `共 ${(saved ?? []).length} 条。type 为 domain 时按域名及子域精确匹配，为 regex 时按正则匹配 hostname。`;
      try { return `共 ${JSON.parse(text).length} 条。type 为 domain 时按域名及子域精确匹配，为 regex 时按正则匹配 hostname。`; }
      catch { return 'JSON 尚未完成，保存前会校验。'; }
    }

    function RulesPanel({ shared }) {
      const snapshot = useConfig(shared);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [rulesText, setRulesText] = useState(null);
      const [url, setUrl] = useState('https://github.com');
      const [source, setSource] = useState('web-fetch');
      const [route, setRoute] = useState('');
      const workerRef = useRef(null);
      const timerRef = useRef(null);

      const cancel = () => {
        workerRef.current?.terminate();
        workerRef.current = null;
        clearTimeout(timerRef.current);
        timerRef.current = null;
      };
      useEffect(() => cancel, []);

      if (snapshot.status === 'unavailable') return h('p', { role: 'status' }, '宿主未提供配置接口，请确认插件已完整安装并已重启宿主。');
      if (snapshot.status !== 'ready') return h('p', { role: 'status' }, '配置加载中…');

      const value = snapshot.value ?? {};
      const disabled = busy || !snapshot.writable;
      const control = { width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 13, color: 'inherit', background: 'var(--dsw-specific-input, transparent)', border: '1px solid var(--dsw-alias-border-l1, currentColor)', borderRadius: 6 };
      const field = (label, node, hint) => h('label', { style: { display: 'grid', gap: 5, minWidth: 0 } },
        h('span', { style: { fontSize: 13, fontWeight: 550 } }, label),
        node,
        hint && h('span', { style: { fontSize: 12, lineHeight: 1.6, opacity: 0.68 } }, hint));
      const section = (title, children) => h('section', { style: { display: 'grid', gap: 10, padding: '12px 14px', border: '1px solid var(--dsw-alias-border-l1, currentColor)', borderRadius: 8 } },
        h('h4', { style: { margin: 0, fontSize: 13, fontWeight: 650, letterSpacing: '0.02em', opacity: 0.8 } }, title),
        ...children);

      async function commit(patch) {
        setBusy(true); setError('');
        try { await shared.set(patch); }
        catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }
      async function saveRules(next) {
        let rules;
        try { rules = JSON.parse(next); validateRules(rules); }
        catch (e) { setError(e.message); return; }
        await commit({ rules });
      }
      function diagnose() {
        cancel(); setRoute(''); setError('');
        if (source === 'model') { setRoute('不受插件管理：模型保持原有网络路径'); return; }
        let hostname, rules;
        try {
          const target = new URL(url);
          if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('仅接受无内嵌凭据的 HTTP(S) URL');
          hostname = target.hostname.toLowerCase().replace(/\.$/, '');
          rules = JSON.parse(rulesText ?? JSON.stringify(value.rules ?? []));
          validateRules(rules);
          if (value.enabled === false) { setRoute(`${hostname}: 直连，工具代理已关闭`); return; }
        } catch (e) { setError(e.message); return; }
        const workerSource = 'onmessage=({data})=>{try{const i=data.rules.findIndex(r=>r.active&&(r.type==="domain"?(data.hostname===r.pattern||data.hostname.endsWith("."+r.pattern)):new RegExp(r.pattern,"u").test(data.hostname)));postMessage({index:i})}catch{postMessage({error:true})}}';
        const address = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
        let worker;
        try { worker = new Worker(address); }
        catch { URL.revokeObjectURL(address); setError('浏览器禁止 Worker，改用 rule_proxy_diagnose 工具诊断'); return; }
        URL.revokeObjectURL(address);
        workerRef.current = worker;
        timerRef.current = setTimeout(() => { cancel(); setError('诊断超时，请检查表达式'); }, 200);
        const finish = cancel;
        worker.onerror = () => { finish(); setError('诊断失败'); };
        worker.onmessage = ({ data }) => {
          finish();
          if (data.error) { setError('表达式无效，保存时宿主会进一步校验 RE2 兼容性'); return; }
          const match = rules[data.index];
          setRoute(match
            ? `${hostname}: 代理（${match.type === 'domain' ? '精确域名' : '正则'}）；${match.title}；${match.pattern}${(value.proxyUrl ?? '') === '' ? '；未配置上游' : ''}`
            : `${hostname}: 直连，未命中活动规则`);
        };
        worker.postMessage({ rules, hostname });
      }

      return h('div', { style: { display: 'grid', gap: 18, maxWidth: 720, minWidth: 0 } },
        h('div', { style: { display: 'grid', gap: 6 } },
          h('div', { style: { fontSize: 17, fontWeight: 650 } }, '工具规则代理'),
          h('div', { style: { fontSize: 13, lineHeight: 1.7, opacity: 0.75 } }, '按 hostname 规则决定网页工具是否走代理。模型请求始终沿用原有网络路径，不受此设置影响。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 } },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '3px 10px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.85 } },
              h('span', { 'data-active': String(value.enabled === true), style: { width: 8, height: 8, borderRadius: 999, background: value.enabled === true ? 'var(--dsw-alias-state-success-primary, #10b981)' : 'var(--dsw-alias-state-error-primary, #ef4444)' } }),
              value.enabled === true ? '已开启' : '已关闭'))),

        section('代理', [
          h('label', { htmlFor: 'rule-proxy-enabled', style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 550, cursor: disabled ? 'not-allowed' : 'pointer' } },
            h('input', { id: 'rule-proxy-enabled', type: 'checkbox', checked: value.enabled === true, disabled, onChange: e => commit({ enabled: e.target.checked }) }),
            h('span', null, '工具代理'),
            h('span', { style: { fontSize: 12, fontWeight: 400, opacity: 0.68 } }, '关闭后规则仍然匹配，但网页工具改为直连。')),
          field('上游 HTTP(S) 代理', h('input', { id: 'rule-proxy-url', style: control, value: value.proxyUrl ?? '', disabled, placeholder: 'http://10.20.15.242:10880', onChange: e => commit({ proxyUrl: e.target.value }) }),
            '命中规则的网页工具通过此地址连接。只能填 origin，不含路径与账号密码。'),
          field('SearXNG 接口', h('input', { id: 'rule-proxy-searx', style: control, value: value.searxEndpoint ?? '', disabled, placeholder: '留空即可不启用', onChange: e => commit({ searxEndpoint: e.target.value }) }),
            '可选。仅用于纯搜索服务；该服务需开启 JSON 输出，且其 hostname 命中规则才会走代理。'),
        ]),

        section('规则', [
          field('规则 JSON', h('textarea', { id: 'rule-proxy-rules', style: { ...control, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, lineHeight: 1.6, minHeight: 220, resize: 'vertical' }, value: rulesText ?? JSON.stringify(value.rules ?? [], null, 2), disabled, onChange: e => setRulesText(e.target.value) }),
            ruleCount(rulesText, value.rules)),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('button', { type: 'button', disabled: disabled || rulesText === null, onClick: () => saveRules(rulesText) }, busy ? '保存中…' : '保存规则'),
            h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 } }, '导入规则文件',
              h('input', { type: 'file', accept: '.json,application/json', disabled, onChange: async event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                try {
                  if (file.size > 256 * 1024) throw new Error('规则文件超过 256 KiB');
                  const text = await file.text();
                  validateRules(JSON.parse(text));
                  setRulesText(text);
                  setError('');
                } catch (e) { setError(e.message); }
              } })),
            h('button', { type: 'button', disabled: rulesText === null, onClick: () => { setRulesText(null); setError(''); } }, '放弃修改')),
        ]),

        section('路由诊断', [
          h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 10, alignItems: 'end' } },
            field('目标 URL', h('input', { id: 'rule-proxy-diag-url', style: control, value: url, onChange: e => { setUrl(e.target.value); setRoute(''); } })),
            field('请求来源', h('select', { id: 'rule-proxy-diag-source', style: control, value: source, onChange: e => { setSource(e.target.value); setRoute(''); } },
              ...[['web-fetch', '网页读取'], ['pure-search', '纯搜索'], ['github-api', 'GitHub API'], ['github-git', 'Git 引用'], ['model', '模型请求（不受管理）']]
                .map(([value_, text]) => h('option', { key: value_, value: value_ }, text))))),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('button', { type: 'button', onClick: diagnose }, '诊断'),
            h('small', { style: { opacity: 0.7 } }, '不联网，仅预览规则命中；实际路由以宿主校验和 rule_proxy_diagnose 工具为准。')),
          route && h('output', { style: { display: 'block', overflowWrap: 'anywhere', padding: '8px 10px', borderRadius: 6, border: '1px solid currentColor', fontSize: 13 }, 'aria-live': 'polite' }, route),
        ].flat()),

        error && h('p', { role: 'alert', style: { overflowWrap: 'anywhere', margin: 0 } }, error),
        snapshot.error && h('p', { role: 'alert', style: { margin: 0 } }, snapshot.error));
    }

    function apply(ctx) {
      const shared = proxyStore();
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-rule-proxy', order: 30, label: '工具规则代理',
      }, function Section() { return h(RulesPanel, { shared }); }));
    }

    return { inject, apply };
  },
});
