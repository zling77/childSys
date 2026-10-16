import { mkdirSync, writeFileSync } from 'node:fs';

// Entirely fictional development examples; not a clinical benchmark or a gold standard.
const cases = [
  { id: 'quantity', expected: 'contradicts', sources: [
    { id: 'A', role: 'caregiver', text: '2026-10-01至2026-10-07，孩子因上学困难缺课两天。' },
    { id: 'B', role: 'teacher_school', text: '2026-10-01至2026-10-07，学校出勤记录显示孩子缺课四天。' },
  ] },
  { id: 'time', expected: 'different_time', sources: [
    { id: 'A', role: 'caregiver', text: '2026-09-01至2026-09-30经常缺课。' },
    { id: 'B', role: 'caregiver', text: '2026-10-05至2026-10-09每天到校，没有缺课。' },
  ] },
  { id: 'observation', expected: 'pending_review', sources: [
    { id: 'A', role: 'child', text: '近两周晚上躺下总要很久才睡着，我白天上课犯困。' },
    { id: 'B', role: 'caregiver', text: '近两周我没有看到孩子夜里醒来，是否难以入睡我不清楚。' },
  ] },
];
const string = { type: 'string' };
const schema = { type: 'object', required: ['cases'], properties: { cases: { type: 'array', items: {
  type: 'object', required: ['id', 'evidence', 'relation', 'doctor_text'], properties: {
    id: {type:'string',enum:cases.map(c=>c.id)},
    evidence: { type: 'array', items: { type: 'object', required: ['source_id', 'quote', 'claim', 'polarity'], properties: {
      source_id: string, quote: string, claim: string, polarity: { type: 'string', enum: ['affirmed', 'negated', 'uncertain'] },
    } } },
    relation: { type: 'string', enum: ['contradicts', 'supports', 'different_time', 'pending_review'] }, doctor_text: string,
  },
} } } };
const models = process.argv.slice(2);
if (!models.length) models.push('qwen3.5:9b', 'qwen3:32b', 'glm-4.7-flash:latest');
const results = [];
for (const model of models) {
  console.log(`Testing ${model} on 3 fictional examples`);
  const started = Date.now();
  try {
    const response = await fetch('http://127.0.0.1:11435/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ model, stream: false, think: false, keep_alive: 0, format: schema,
        options: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 2300 },
        messages: [
          { role: 'system', content: '你整理完全虚构的儿童预问诊材料。每个例子从每个来源各抽取一条核心证据，quote必须逐字来自该来源原文。输出关系初判及80字以内的中文医生摘要，保留来源、分歧、不确定性和限定语。数值不同且时间相同可以构成候选分歧；不同时间不能推断改善或冲突；未观察到不等于本人没有体验。不要诊断、治疗建议或风险分层。必须严格按 output_schema 返回 cases 数组（恰好3项），每项包含id、evidence、relation、doctor_text，不得换字段或省略证据。只输出JSON，不要Markdown代码围栏。' },
          { role: 'user', content: JSON.stringify({ output_schema:schema,cases: cases.map(({ expected, ...c }) => c) }) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const envelope = await response.json();
    const raw=String(envelope.message?.content??'').trim();
    const output = JSON.parse(/^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(raw)?.[1]??raw);
    const checks = cases.map(c => {
      const actual = output.cases?.find(item => item.id === c.id);
      const evidence = actual?.evidence ?? [];
      return { id: c.id, expected: c.expected, actual: actual?.relation ?? null,
        relationOk: actual?.relation === c.expected,
        quotesOk: evidence.length >= 2 && evidence.every(e => typeof e.quote === 'string' && e.quote.length && c.sources.find(s => s.id === e.source_id)?.text.includes(e.quote)),
        bothSources: c.sources.every(s => evidence.some(e => e.source_id === s.id)),
      };
    });
    const result = { model, wallMs: Date.now() - started, loadMs: Math.round((envelope.load_duration ?? 0) / 1e6), outputTokens: envelope.eval_count, wrapperRemoved:raw.startsWith('```'),
      tokensPerSecond: envelope.eval_duration ? Math.round(envelope.eval_count / (envelope.eval_duration / 1e9) * 10) / 10 : null,
      checks, output, error: null };
    results.push(result);
    console.log(JSON.stringify({ ...result, output: undefined }));
  } catch (error) {
    const result = { model, wallMs: Date.now() - started, error: error.message };
    results.push(result); console.log(JSON.stringify(result));
  }
  mkdirSync('output/clinician-llm', { recursive: true });
  writeFileSync('output/clinician-llm/candidate-probe-v2.json', JSON.stringify({ dataset: 'fully_synthetic_development', date: '2026-10-09', caveat: 'Three hand-authored development examples, one run per model; schema included in prompt. Not a clinical or statistical evaluation.', results }, null, 2));
}
