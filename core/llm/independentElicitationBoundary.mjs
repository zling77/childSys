// A neutral target is not evidence of a symptom. This check complements the
// structural isolation: the generator never receives the hidden-source claim.
export function validateIndependentElicitation(question, { target, ownText = '' } = {}) {
  if (!target?.independentElicitation) return { ok: true };
  const text = String(question ?? '');
  if (/另一(?:方|端|来源|会话)|其他(?:来源|会话)|根据.{0,12}(?:自诉|报告)|(?:孩子|家长|父母).{0,8}(?:已经|之前|刚才).{0,6}(?:告诉我|向我|提到)|听(?:孩子|家长|父母)说/.test(text)) {
    return { ok: false, reason: '独立取证问题不得提示其他来源的报告。' };
  }
  if (/(?:孩子|妈妈|爸爸|家长|父母)(?:说|告诉|表示|反映|提到|认为)/.test(text)
    && !/(?:孩子|妈妈|爸爸|家长|父母)(?:说|告诉|表示|反映|提到|认为)/.test(ownText)) {
    return { ok: false, reason: '当前回答者尚未提供此转述，不能预设另一个人的说法。' };
  }
  if (target.targetFacetId === 'sleep_change' && !hasOwnSleepAccount(ownText)
    && !isNeutralSleepOpening(text)) {
    return { ok: false, reason: '独立睡眠取证首次应中性开放，不能附带尚未报告的异常、频率、程度或另一来源的说法。' };
  }
  return { ok: true };
}

function hasOwnSleepAccount(ownText) {
  // Mentioning a symptom under negation or uncertainty is not evidence that
  // the current source affirmed it. Conservative clause-level matching keeps
  // those cases on the neutral path; it never fills an evidence state.
  return String(ownText).split(/[。！？!?；;\n]/).some((clause) => (
    /睡不好|睡不着|失眠|入睡困难|难入睡|夜醒|早醒|半夜醒|噩梦|睡得.{0,3}(?:少|差|不舒服)/.test(clause)
    && !/不(?:是|知道|清楚|确定|了解)|没(?:有|观察|发现)|未(?:观察|发现)|无法|说不准|否认|并无/.test(clause)
  ));
}

function isNeutralSleepOpening(question) {
  const text = String(question).replace(/\s/g, '');
  // Match the WHOLE neutral question, not a keyword in a longer assertion.
  // If a model adds detail or an unsupported presupposition, the existing
  // neutral goal fallback is used. This guard applies only to first elicitation
  // of a cross-source-triggered sleep target, not all dynamic interview turns.
  return [
    /^(?:最近|近来|这段时间|平时)?(?:晚上|夜里)?[，,]?(?:孩子|他|她|你|自己)?(?:最近|平时)?(?:晚上|夜里)?的?(?:睡眠(?:情况)?|睡觉(?:情况)?|睡得)(?:怎么样|如何|怎样|还好吗)[？?]$/,
    /^(?:最近|近来|这段时间|平时)?(?:孩子|他|她|你)?(?:晚上|夜里)?的?(?:睡眠|睡觉)(?:情况)?[，,](?:您|你)(?:能|可以)?(?:观察到哪些情况|观察到什么|说说吗|说说具体情况吗)[？?]$/,
    /^(?:您|你)(?:能|可以)?(?:根据自己观察到的情况[，,]?)?(?:说说|说一下|讲讲)(?:最近|近来|这段时间|平时)?(?:孩子|他|她|你)?(?:晚上|夜里)?的?(?:睡眠|睡觉)(?:情况)?(?:吗|怎么样|如何|有哪些情况)[？?]$/,
  ].some((pattern) => pattern.test(text));
}
