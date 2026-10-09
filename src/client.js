// Browser module consumed by the DSH module loader; no global network hooks.
window.__ModuleLoader__.load({
  id: 'dsh-rule-proxy',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useSyncExternalStore } = React;
    const inject = ['slots', 'configForms'];
    function Page({ view, form }) {
      const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot());
      const [draft, setDraft] = useState(null);
      const [revision, setRevision] = useState(undefined);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [url, setUrl] = useState('https://github.com');
      const [source, setSource] = useState('web-fetch');
      const [result, setResult] = useState('');
      const workerRef = React.useRef(null);
      const timerRef = React.useRef(null);
      const cancelDiagnosis = () => {
        workerRef.current?.terminate();
        workerRef.current = null;
        clearTimeout(timerRef.current);
        timerRef.current = null;
      };
      useEffect(() => cancelDiagnosis, []);
      if (view === 'summary') return '工具规则代理';
      if (snapshot.status !== 'ready') return h('p', { role: 'status' }, '配置不可用');
      const value = draft ?? snapshot.value;
      const disabled = busy || !snapshot.writable;
      const change = (key, next) => {
        if (!draft) setRevision(snapshot.revision);
        setDraft({ ...value, [key]: next });
        setError(''); setResult('');
      };
      // Structural rule validation mirroring the host RE2 engine: reject an
      // invalid rule here instead of failing plugin activation at next boot.
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
      async function save() {
        setBusy(true); setError('');
        try {
          const rules = JSON.parse(value.rulesText ?? JSON.stringify(value.rules));
          validateRules(rules);
          const fields = { enabled: value.enabled, proxyUrl: value.proxyUrl, searxEndpoint: value.searxEndpoint, rules };
          const accepted = await form.mutate(Object.entries(fields).map(([key, val]) => ({ op: 'set', path: [key], value: val })), revision);
          if (!accepted) throw new Error('保存被拒绝，请检查规则或重新载入配置');
          setDraft(null); setRevision(undefined);
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }
      async function importFile(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
          if (file.size > 256 * 1024) throw new Error('规则文件超过 256 KiB');
          const text = await file.text();
          const rules = JSON.parse(text);
          validateRules(rules);
          change('rulesText', JSON.stringify(rules, null, 2));
        } catch (e) { setError(e.message); }
      }
      function diagnose() {
        cancelDiagnosis();
        setResult(''); setError('');
        if (source === 'model') { setResult('不受插件管理：模型保持既有网络路径'); return; }
        let hostname, rules;
        try {
          const target = new URL(url);
          if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('仅接受无内嵌凭据的 HTTP(S) URL');
          hostname = target.hostname.toLowerCase().replace(/\.$/, '');
          rules = JSON.parse(value.rulesText ?? JSON.stringify(value.rules));
          validateRules(rules);
          if (!value.enabled) { setResult(`${hostname}: 直连，工具代理已关闭`); return; }
        } catch (e) { setError(e.message); return; }
        // Draft previews are bounded native-regexp evaluations, never production routing.
        const blob = new Blob(['onmessage=({data})=>{try{const i=data.rules.findIndex(r=>r.active&&(r.type==="domain"?(data.hostname===r.pattern||data.hostname.endsWith("."+r.pattern)):new RegExp(r.pattern,"u").test(data.hostname)));postMessage({index:i})}catch{postMessage({error:true})}}'], { type: 'text/javascript' });
        const address = URL.createObjectURL(blob);
        let worker;
        try { worker = new Worker(address); }
        catch { URL.revokeObjectURL(address); setError('浏览器禁止 Worker，使用 rule_proxy_diagnose 工具诊断'); return; }
        URL.revokeObjectURL(address);
        workerRef.current = worker;
        timerRef.current = setTimeout(() => { cancelDiagnosis(); setError('草稿诊断超时，请检查表达式'); }, 200);
        const finish = cancelDiagnosis;
        worker.onerror = () => { finish(); setError('草稿诊断失败'); };
        worker.onmessage = ({ data }) => {
          finish();
          if (data.error) { setError('表达式无效，保存时宿主会进一步校验 RE2 兼容性'); return; }
          const match = rules[data.index];
          setResult(match ? `${hostname}: 代理（${match.type === 'domain' ? '精确域名' : '正则'}）；${match.title}；${match.pattern}${value.proxyUrl ? '' : '；未配置上游'}` : `${hostname}: 直连，未命中活动规则`);
        };
        worker.postMessage({ rules, hostname });
      }
      const field = (label, node) => h('label', { style: { display: 'grid', gap: 6 } }, label, node);
      const control = { width: '100%', padding: 8, borderRadius: 4, color: 'inherit', background: 'transparent', border: '1px solid currentColor', boxSizing: 'border-box' };
      return h('section', { style: { display: 'grid', gap: 16, maxWidth: 760, minWidth: 0 } },
        !snapshot.writable && h('p', { role: 'status' }, '当前部署配置只读'),
        field('工具代理', h('input', { type: 'checkbox', checked: value.enabled, disabled, onChange: e => change('enabled', e.target.checked) })),
        field('上游 HTTP(S) 代理', h('input', { style: control, value: value.proxyUrl ?? '', disabled, onChange: e => change('proxyUrl', e.target.value) })),
        field('SearXNG 接口', h('input', { style: control, value: value.searxEndpoint ?? '', disabled, onChange: e => change('searxEndpoint', e.target.value) })),
        field('规则 JSON', h('textarea', { style: { ...control, fontFamily: 'monospace', minHeight: 280, resize: 'vertical' }, value: value.rulesText ?? JSON.stringify(value.rules, null, 2), disabled, onChange: e => change('rulesText', e.target.value) })),
        field('导入规则文件', h('input', { type: 'file', accept: '.json,application/json', disabled, onChange: importFile })),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          h('button', { type: 'button', disabled: disabled || !draft, onClick: save }, busy ? '保存中' : '保存'),
          h('button', { type: 'button', disabled: busy || !draft, onClick: () => { setDraft(null); setRevision(undefined); setError(''); setResult(''); } }, '放弃修改')),
        field('诊断 URL', h('input', { style: control, value: url, onChange: e => { setUrl(e.target.value); setResult(''); } })),
        field('请求来源', h('select', { style: control, value: source, onChange: e => { setSource(e.target.value); setResult(''); } },
          ...['web-fetch', 'pure-search', 'github-api', 'github-git', 'model'].map(s => h('option', { key: s, value: s }, s)))),
        h('button', { type: 'button', onClick: diagnose }, '诊断草稿'),
        h('small', null, '草稿预览不联网；实际路由以宿主 RE2 校验和 rule_proxy_diagnose 为准。'),
        result && h('output', { style: { overflowWrap: 'anywhere' }, 'aria-live': 'polite' }, result),
        error && h('p', { role: 'alert', style: { overflowWrap: 'anywhere' } }, error));
    }
    function apply(ctx) {
      const form = ctx.configForms.get('rule-proxy');
      ctx.effect(() => ctx.configForms.whileServed(['rule-proxy'], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item', id: 'rule-proxy', order: 45, label: () => '工具规则代理', inject: () => ({ form }),
      }, Page))), 'rule-proxy settings page');
    }
    return { inject, apply };
  },
});
