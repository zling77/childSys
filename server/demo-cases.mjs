import { handleTurn } from '../core/orchestrator.mjs';

export const demoCases = [
  {
    id: 'school_refusal',
    label: '拒学 / 上学困难',
    profile: { age: 9, sex: 'M', grade: '小学三年级', respondent: 'mother' },
    selectedComplaints: ['school_refusal'],
    chiefComplaint: '孩子最近不想上学，一到校门口就哭，说肚子疼，回家看电视就好一点',
    answers: [
      '最近两周缺课四天，还有两次到校门口又回来了。',
      '最困难的是早上出门和到校门口，到了门口就哭，说肚子疼。',
      '离开学校回家以后明显好一些，能看电视，也能吃饭。',
      '最近有一次被同学笑，说他胆小，老师也因为作业批评过。',
      '我们一般先劝，实在不行就请假，有时候也会吵起来。',
    ],
  },
  {
    id: 'attention',
    label: '注意力 / 多动冲动',
    profile: { age: 8, sex: 'M', grade: '小学二年级', respondent: 'father' },
    selectedComplaints: ['attention_hyperactivity_impulsivity'],
    chiefComplaint: '老师说孩子上课走神，小动作多，作业拖拉，考试经常粗心漏题',
    answers: [
      '一年级开始明显，最近半学期更突出。',
      '学校和家里写作业都明显，出去玩的时候好一些。',
      '老师反馈上课走神、小动作多，也会插嘴。',
      '写作业主要是拖拉和粗心，不会的题也容易发脾气。',
      '成绩波动比较大，作业期间亲子冲突很多。',
    ],
  },
  {
    id: 'social',
    label: '社交沟通 / 刻板行为',
    profile: { age: 5, sex: 'F', grade: '幼儿园中班', respondent: 'mother' },
    selectedComplaints: ['social_communication_repetitive_behavior'],
    chiefComplaint: '孩子不太和小朋友玩，叫名字有时不回应，喜欢反复看同一集动画片',
    answers: [
      '大概三岁以后更明显。',
      '叫名字有时候会回头，有时候像没听见。',
      '想要东西多半会拉大人的手，偶尔能说出来。',
      '很少主动拿东西给我们看。',
      '和小朋友更多是各玩各的，喜欢固定路线和固定动画。',
    ],
  },
  {
    id: 'mood_risk',
    label: '情绪低落 / 自伤线索',
    profile: { age: 14, sex: 'F', grade: '初二', respondent: 'mother' },
    selectedComplaints: ['mood_anxiety_selfharm'],
    chiefComplaint: '孩子最近情绪低，经常一个人哭，说自己没用，有时说不想活',
    answers: [
      '大概持续两个月了，最近几乎每天都明显。',
      '以前喜欢画画，现在也不太画了，精力差。',
      '睡眠不好，入睡慢，早上很难起床。',
      '上学和朋友关系都受影响，成绩也下降了。',
      '她说过想消失，也用指甲抓过自己手臂。',
    ],
  },
  {
    id: 'emotion_regulation',
    label: '情绪调节 / 冲动行为',
    profile: { age: 10, sex: 'M', grade: '小学四年级', respondent: 'mother' },
    selectedComplaints: ['emotion_regulation_impulsivity'],
    chiefComplaint: '孩子愿望不满足就大哭大闹，摔东西，有时会打自己',
    answers: [
      '从小就急，最近一年更明显。',
      '主要是被批评、游戏被停、要求没满足时爆发。',
      '一周大概三四次，每次二十分钟到一小时。',
      '会哭闹、摔东西、捶自己，平静后有时会后悔。',
      '主要在家里发生，学校也有过一次和同学冲突。',
    ],
  },
  {
    id: 'generic',
    label: '通用入口 / 混合表达',
    profile: { age: 12, sex: 'U', grade: '小学六年级', respondent: 'guardian' },
    selectedComplaints: ['generic_behavioral_health'],
    chiefComplaint: '最近孩子状态不太对，说不清哪里有问题，学习和睡觉都乱了',
    answers: [
      '大概一个月前开始。',
      '最近一周几乎每天都会有点烦，不愿意写作业。',
      '家里和学校都有，学校反馈注意力下降。',
      '睡得晚，早上起不来，作业拖到很晚。',
      '最近家里搬家，孩子也换了班主任。',
    ],
  },
];

export function seedDemoCases(store) {
  const created = [];
  for (const item of demoCases) {
    const session = store.createSession({
      profile: item.profile,
      selectedComplaints: item.selectedComplaints,
      chiefComplaint: item.chiefComplaint,
    });
    let snapshot = store.getSnapshot(session.sessionId);
    let result = handleTurn(snapshot, {
      speakerRole: 'guardian',
      answerText: item.chiefComplaint,
      currentQuestion: null,
    });
    snapshot = store.applyTurnResult(result);
    for (const answer of item.answers) {
      result = handleTurn(snapshot, {
        speakerRole: 'guardian',
        answerText: answer,
        currentQuestion: snapshot.decisionLogs.at(-1)?.selectedAction?.nextQuestion ?? null,
      });
      snapshot = store.applyTurnResult(result);
    }
    const packet = store.generatePacket(session.sessionId);
    created.push({ caseId: item.id, label: item.label, sessionId: session.sessionId, status: store.getSnapshot(session.sessionId).session.status, packetId: packet.packetId });
  }
  return created;
}

