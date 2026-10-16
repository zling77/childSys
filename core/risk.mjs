export const riskRules = [
  ['suicide', ['不想活', '想死', '想消失', '活着没意思', '结束生命']],
  ['self_harm', ['划伤', '割手', '撞墙', '打自己', '伤害自己', '自伤']],
  ['harm_other', ['打死', '报复', '带刀', '伤害别人', '弄死']],
  ['abuse', ['被打', '被威胁', '不敢回家', '被摸', '性侵']],
  ['bullying', ['被欺负', '被嘲笑', '被孤立', '被勒索', '网络攻击', '霸凌']],
  ['psychotic_like', ['听到声音', '有人监视', '被控制', '害我', '幻听']],
];

const negationMarkers = [
  '从来没有', '并没有', '从未', '从没', '未曾', '并未', '不曾',
  '没有', '否认', '并非', '不是', '不会', '不再', '不想', '没', '无', '未',
];

const uncertaintyMarkers = ['不确定', '说不清', '记不清', '不知道', '可能', '也许', '好像', '似乎', '大概', '应该'];

/**
 * Classify one concrete mention instead of treating every keyword hit as present.
 * The window is deliberately short and clause-bounded so a negation in the
 * previous clause does not suppress a later positive disclosure.
 */
export function classifyMentionPolarity(text, keyword) {
  const raw = String(text ?? '');
  const cue = String(keyword ?? '');
  if (!cue) return classifyPrefix(raw.slice(0, 14));

  let from = 0;
  let sawUncertain = false;
  let sawMention = false;
  while (from <= raw.length) {
    const mentionAt = raw.indexOf(cue, from);
    if (mentionAt < 0) break;
    sawMention = true;
    const polarity = classifyPrefix(mentionPrefix(raw, mentionAt));
    if (polarity === 'present') return 'present';
    if (polarity === 'uncertain') sawUncertain = true;
    from = mentionAt + Math.max(cue.length, 1);
  }
  if (!sawMention) return classifyPrefix(raw.slice(0, 14));
  return sawUncertain ? 'uncertain' : 'absent';
}

export function findRiskSignals(text, sessionId, turnNo, speakerRole) {
  const raw = String(text ?? '');
  const signals = [];
  for (const [signalType, keywords] of riskRules) {
    for (const keyword of keywords) {
      if (!raw.includes(keyword)) continue;
      // A clearly denied historical/current risk statement is evidence of
      // absence, not an open risk signal. Uncertain wording remains open so it
      // can be checked by a clinician.
      if (classifyMentionPolarity(raw, keyword) === 'absent') continue;
      signals.push({
        signalId: `R-${sessionId}-${turnNo}-${signals.length + 1}`,
        sessionId,
        turnNo,
        signalType,
        triggerText: raw,
        keyword,
        source: speakerRole,
        status: 'open',
        createdAt: Date.now(),
      });
      break;
    }
  }
  return signals;
}

function mentionPrefix(raw, mentionAt) {
  const window = raw.slice(Math.max(0, mentionAt - 14), mentionAt);
  const boundary = Math.max(
    window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('。'),
    window.lastIndexOf('！'), window.lastIndexOf('!'), window.lastIndexOf('？'),
    window.lastIndexOf('?'), window.lastIndexOf('；'), window.lastIndexOf(';'),
    window.lastIndexOf('\n'),
  );
  return window.slice(boundary + 1).trim();
}

function isNegatedPrefix(prefix) {
  // “不是没有想死过” is a double negation and must not be discarded.
  if (/(?:不是|并非)(?:没有|没|无|未)/.test(prefix)) return false;
  // The keyword is “想死”, so in “不想死” the negator sits immediately
  // before the matched span. Avoid a broad bare-“不” rule that would wrongly
  // suppress wording such as “忍不住想死”。
  if (prefix.endsWith('不') && !prefix.endsWith('不得不')) return true;

  for (const marker of negationMarkers) {
    const markerAt = prefix.lastIndexOf(marker);
    if (markerAt < 0) continue;
    const tail = prefix.slice(markerAt + marker.length);
    if (tail.length > 9) continue;
    // A contrast re-opens the scope: “没有自伤但有想死的想法”。
    if (/(?:但|但是|不过|然而|却|仍然|仍|还)/.test(tail)) continue;
    return true;
  }
  return false;
}

function classifyPrefix(prefix) {
  if (uncertaintyMarkers.some((marker) => prefix.includes(marker))) return 'uncertain';
  return isNegatedPrefix(prefix) ? 'absent' : 'present';
}
