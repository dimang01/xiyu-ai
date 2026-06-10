/**
 * v1.x 关系节奏 + 表白闸门冒烟测试（偏真实节奏）
 * 验证：好感降速/单条封顶、动态每日上限(新人期快)、55+衰减、暧昧→恋人(表白+5天)、
 *       恋人→深爱(当恋人30天)、只拦升级不动存量、canAcceptConfession。
 * Copyright (c) 2026 溪语 AI Contributors. MIT License.
 */
process.env.DB_PATH = '/tmp/relpace_test.db';

const {
  calcAffectionDelta, syncUpdateCompanionState, canAcceptConfession, affectionDailyCap,
} = await import('../src/memory.mjs');
const { shanghaiDateKey } = await import('../src/db.mjs');

const today = shanghaiDateKey();
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();
let fail = 0;
const check = (name, cond, got) => { console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  → got ' + JSON.stringify(got)}`); if (!cond) fail++; };

// 基础 companion 模板
const base = (o) => ({ id: 999999, affection_level: 50, relationship_stage: '暧昧', current_mood: 'shy',
  created_at: daysAgo(20), affection_day: null, affection_today: 0, confessed_at: null, user_confessed_at: null, became_lover_at: null, ...o });

// ① 单条封顶 +3（强词+长消息不叠加超 3）
check('calcAffectionDelta 封顶 +3', calcAffectionDelta('爱你' + '好'.repeat(200)) === 3, calcAffectionDelta('爱你' + '好'.repeat(200)));

// ② 暧昧无表白：好感涨但阶段卡住（即使冲到 55+）
let f = syncUpdateCompanionState(base({ affection_level: 54 }), '爱你好棒棒', '嗯');
check('②暧昧无表白 → 好感+3=57', f.affection_level === 57, f.affection_level);
check('②无表白 stage 卡在暧昧', f.relationship_stage === '暧昧', f.relationship_stage);

// ③ 够格（表白+5天+好感够）→ 升恋人 + 记 became_lover_at
f = syncUpdateCompanionState(base({ affection_level: 54, user_confessed_at: daysAgo(1), created_at: daysAgo(6) }), '爱你', '嗯');
check('③表白+认识≥5天 → 升恋人', f.relationship_stage === '恋人', f.relationship_stage);
check('③升恋人记 became_lover_at', Boolean(f.became_lover_at), f.became_lover_at);

// ④ 有表白但认识太短（4天<5）→ 卡暧昧（仍防秒升）
f = syncUpdateCompanionState(base({ affection_level: 54, user_confessed_at: daysAgo(1), created_at: daysAgo(4) }), '爱你', '嗯');
check('④认识<5天 → 卡暧昧不升恋人', f.relationship_stage === '暧昧', f.relationship_stage);

// ⑤ 动态每日上限：暧昧段(aff40) cap=15，今天已满 15 → 不再涨
f = syncUpdateCompanionState(base({ affection_level: 40, affection_day: today, affection_today: affectionDailyCap(40) }), '爱你好棒', '嗯');
check('⑤暧昧段当日满15 → 好感不再涨', f.affection_level === 40, f.affection_level);

// ⑥ 55+ 衰减：恋人态强词 +3 → 减半≈2
f = syncUpdateCompanionState(base({ affection_level: 60, relationship_stage: '恋人', user_confessed_at: daysAgo(40), became_lover_at: daysAgo(40) }), '爱你好棒', '嗯');
check('⑥55+衰减 60→62(而非63)', f.affection_level === 62, f.affection_level);

// ⑦ 不动存量：老恋人无表白记录，不被降级
f = syncUpdateCompanionState(base({ affection_level: 60, relationship_stage: '恋人', confessed_at: null, user_confessed_at: null, became_lover_at: daysAgo(5) }), '今天天气不错', '嗯');
check('⑦老恋人无表白 → 不降级', f.relationship_stage === '恋人', f.relationship_stage);

// ⑧ 恋人→深爱：当恋人 40 天 + 好感 80 → 升深爱
f = syncUpdateCompanionState(base({ affection_level: 79, relationship_stage: '恋人', user_confessed_at: daysAgo(40), became_lover_at: daysAgo(40) }), '爱你好棒', '嗯');
check('⑧当恋人40天+好感80 → 升深爱', f.relationship_stage === '深爱', f.relationship_stage);

// ⑨ 恋人→深爱 卡住：当恋人才 10 天
f = syncUpdateCompanionState(base({ affection_level: 79, relationship_stage: '恋人', user_confessed_at: daysAgo(40), became_lover_at: daysAgo(10) }), '爱你好棒', '嗯');
check('⑨当恋人<30天 → 卡恋人不升深爱', f.relationship_stage === '恋人', f.relationship_stage);

// ⑩ canAcceptConfession 边界
check('⑩好感55+认识5天 → 可接受', canAcceptConfession(base({ affection_level: 55, created_at: daysAgo(5) })) === true);
check('⑩好感54 → 不可接受', canAcceptConfession(base({ affection_level: 54, created_at: daysAgo(20) })) === false);
check('⑩认识4天 → 不可接受(防秒升)', canAcceptConfession(base({ affection_level: 60, created_at: daysAgo(4) })) === false);

// ⑪ v1.16.x 动态日上限分段
check('⑪cap 陌生/朋友段(aff<30)=25', affectionDailyCap(10) === 25, affectionDailyCap(10));
check('⑪cap 暧昧段(30-54)=15',       affectionDailyCap(40) === 15, affectionDailyCap(40));
check('⑪cap 恋人段(55-79)=8',        affectionDailyCap(60) === 8,  affectionDailyCap(60));
check('⑪cap 深爱段(>=80)=5',         affectionDailyCap(85) === 5,  affectionDailyCap(85));

// ⑫ 新人期不再被旧 cap8 压死：陌生人 aff10 当天已得 8，仍能继续涨（新 cap25；旧机制此处会卡 0）
f = syncUpdateCompanionState(base({ affection_level: 10, relationship_stage: '陌生人', created_at: daysAgo(1), affection_day: today, affection_today: 8 }), '爱你好棒', '嗯');
check('⑫新人期 today已得8 仍能涨(cap25)', f.affection_level > 10, f.affection_level);

// ⑬ 新人期仍有天花板：陌生人当天满 25 → 不再涨（防一天刷爆）
f = syncUpdateCompanionState(base({ affection_level: 20, relationship_stage: '陌生人', created_at: daysAgo(1), affection_day: today, affection_today: 25 }), '爱你好棒', '嗯');
check('⑬新人期当天满25 → 不再涨(防刷爆)', f.affection_level === 20, f.affection_level);

console.log(fail === 0 ? '\n✅ 关系节奏闸门全部通过' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
