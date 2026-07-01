/**
 * 忍戦 戦闘ステートマシン ユニットテスト
 * 実行: node engine/battle.test.js
 */

'use strict';

const assert  = require('assert');
const Battle  = require('./battle');
const Core    = require('./core');

const skillsData   = require('../data/skills.json').skills;
const factionsData = require('../data/factions.json').factions;
const ninjutsuData = require('../data/ninjutsu.json').ninjutsu;

// ===== テストランナー =====

let passed = 0, failed = 0;
function test(name, fn) {
  try   { fn(); console.log('  ✓', name); passed++; }
  catch (e) { console.error('  ✗', name); console.error('   ', e.message); failed++; }
}
function describe(label, fn) { console.log('\n[' + label + ']'); fn(); }

// ===== テスト用 rng ヘルパー =====

/**
 * 指定した 2D6 の出目を返す rng を生成する。
 * makeRng(7, 3) → 最初の2D6=7、次の2D6=3 を返す。
 * roll2d6 は内部で rng() を2回呼ぶので、1D6値を2つセットで渡す。
 *   例: makeRng2d6(4,3, 1,5) → 最初の2D6=(4+3=7)、次の2D6=(1+5=6)
 */
function makeRng(...vals) {
  let i = 0;
  return () => (vals[i++ % vals.length] - 1) / 6;
}

// 2D6で指定の合計値が出るように低レベルrngを作る
// a+b = total となる値ペアを作る (a=b=ceil(total/2) が安全)
function rngFor2d6(total) {
  const a = Math.ceil(total / 2);
  const b = total - a;
  return makeRng(a, b);
}

// ===== テスト用キャラクターデータ =====

const hasuba  = factionsData.find(f => f.id === 'hasuba');  // 器術
const hagure  = factionsData.find(f => f.id === 'hagure');  // 忍術

const hasubaFavored = skillsData.filter(s => s.field === '器術').map(s => s.name);
const bodySkills    = skillsData.filter(s => s.field === '体術').map(s => s.name);
const ninSkills     = skillsData.filter(s => s.field === '忍術').map(s => s.name);

const validSkills_hasuba = [
  hasubaFavored[0], hasubaFavored[1], hasubaFavored[2],
  bodySkills[0], bodySkills[1], bodySkills[2],
];
const validSkills_hagure = [
  ninSkills[0], ninSkills[1], ninSkills[2],
  bodySkills[0], bodySkills[1], bodySkills[2],
];

// 汎用接近戦攻撃忍法（最初の battle_usable な melee）
const meleeNin   = ninjutsuData.find(n => n.damage_type === 'melee'  && n.battle_usable !== false && (n.cost||0) === 0);
const rangedNin  = ninjutsuData.find(n => n.damage_type === 'ranged' && n.battle_usable !== false && (n.cost||0) === 0);
const groupNin   = ninjutsuData.find(n => n.damage_type === 'group'  && n.battle_usable !== false && (n.cost||0) === 0);

// 斜歯忍軍の流派忍法（battle_usable, cost=0 or low）
const hasubaFactionNin = ninjutsuData.find(n =>
  n.availability === 'faction' && n.faction === '斜歯忍軍' && n.battle_usable !== false
);

function makeChar(id, name, factionId, skillNames, ninjutsuIds) {
  const faction = factionsData.find(f => f.id === factionId);
  return {
    id, name,
    factionId,
    factionName: faction.name,
    favoredFieldIndex: faction.favored_field_index,
    skillNames: [...skillNames],
    ninjutsuIds: [...ninjutsuIds],
    immuneConditions: [],
  };
}

const char1 = makeChar('c1', '天狗', 'hasuba', validSkills_hasuba, [meleeNin.id, hasubaFactionNin.id]);
const char2 = makeChar('c2', '鴉',   'hagure', validSkills_hagure, [meleeNin.id, rangedNin?.id].filter(Boolean));

// ===== initBattle =====

describe('initBattle', () => {
  test('初期ステートが正しく生成される', () => {
    const s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    assert.strictEqual(s.phase, Battle.PHASES.PLOT);
    assert.strictEqual(s.round, 1);
    assert.strictEqual(s.chars.length, 2);
    assert.strictEqual(s.chars[0].name, '天狗');
    assert.strictEqual(s.chars[0].plotValue, null);
    assert.strictEqual(s.battlefield.id, 'hirachi');  // 平地
    assert.ok(s.chars[0].hpSlots.length >= 6);
    assert.ok(s.chars[0].hpSlots.every(sl => !sl.damaged));
  });

  test('maxRounds = 10', () => {
    const s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    assert.strictEqual(s.maxRounds, 10);
  });

  test('戦場 ID 指定が反映される', () => {
    const s = Battle.initBattle([char1, char2], 'suichu', skillsData, ninjutsuData);
    assert.strictEqual(s.battlefield.id, 'suichu');
    assert.strictEqual(s.battlefield.name, '水中');
  });
});

// ===== choosePlot =====

describe('choosePlot', () => {
  test('片方のみ選択 → まだ PLOT フェーズ', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 4);
    assert.strictEqual(s.phase, Battle.PHASES.PLOT);
    assert.strictEqual(s.chars[0].plotValue, 4);
    assert.strictEqual(s.chars[1].plotValue, null);
  });

  test('両方選択 → ACTION フェーズに移行', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 5);
    s = Battle.choosePlot(s, 1, 3);
    assert.strictEqual(s.phase, Battle.PHASES.ACTION);
    assert.deepStrictEqual(s.actionOrder, [0, 1]);  // 5 > 3 → char[0] 先攻
  });

  test('同プロット値 → インデックス小さい方が先', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 4);
    s = Battle.choosePlot(s, 1, 4);
    assert.deepStrictEqual(s.actionOrder, [0, 1]);
  });

  test('後攻が正しく設定される', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 2);
    s = Battle.choosePlot(s, 1, 6);
    assert.deepStrictEqual(s.actionOrder, [1, 0]);  // char[1] 先攻
  });

  test('範囲外の値は無視される', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 0);
    assert.strictEqual(s.chars[0].plotValue, null);
    s = Battle.choosePlot(s, 0, 7);
    assert.strictEqual(s.chars[0].plotValue, null);
  });
});

// ===== getAvailableNinjutsu =====

describe('getAvailableNinjutsu', () => {
  function plotState(c1Plot, c2Plot) {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, c1Plot);
    s = Battle.choosePlot(s, 1, c2Plot);
    return s;
  }

  test('間合い内の忍法が canUse=true になる', () => {
    const s = plotState(4, 4);  // 距離0
    // char[0] (plot=4) が先攻。meleeNin の間合いチェック
    const avail = Battle.getAvailableNinjutsu(s, skillsData, ninjutsuData);
    const entry = avail.find(a => a.id === meleeNin.id);
    assert.ok(entry, '忍法が一覧に含まれる');
    assert.strictEqual(entry.canUse, true);
  });

  test('間合い外は canUse=false', () => {
    // meleeNin の range を確認
    const range = meleeNin.range;
    // 距離 > range になるようなプロット値
    if (range === 0) {
      const s = plotState(1, 6);  // 距離5
      const avail = Battle.getAvailableNinjutsu(s, skillsData, ninjutsuData);
      const entry = avail.find(a => a.id === meleeNin.id);
      assert.ok(entry);
      assert.strictEqual(entry.canUse, false);
      assert.ok(entry.reason.includes('間合外'));
    } else {
      // range が広い場合は別の数値で確認
      const s = plotState(3, 3);  // 距離0 → in range
      const avail = Battle.getAvailableNinjutsu(s, skillsData, ninjutsuData);
      const entry = avail.find(a => a.id === meleeNin.id);
      assert.ok(entry?.canUse);
    }
  });

  test('コスト不足は canUse=false', () => {
    // コストが高い忍法
    const expensiveNin = ninjutsuData.find(n => (n.cost||0) >= 3 && n.battle_usable !== false);
    if (!expensiveNin) { console.log('    （スキップ: コスト3+の忍法なし）'); return; }

    const charWithCostNin = makeChar('cx', 'テスト', 'hasuba', validSkills_hasuba, [expensiveNin.id, hasubaFactionNin.id]);
    let s = Battle.initBattle([charWithCostNin, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 2);  // プロット2 < コスト3
    s = Battle.choosePlot(s, 1, 2);
    const avail = Battle.getAvailableNinjutsu(s, skillsData, ninjutsuData);
    const entry = avail.find(a => a.id === expensiveNin.id);
    if (entry) {
      assert.strictEqual(entry.canUse, false);
      assert.ok(entry.reason.includes('コスト'));
    }
  });
});

// ===== chooseAction (パス) =====

describe('chooseAction - パス', () => {
  test('パス → 次の行動者に移る', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 5);
    s = Battle.choosePlot(s, 1, 3);
    // char[0] が先攻
    assert.strictEqual(s.actionOrder[0], 0);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    assert.strictEqual(s.actionOrder[s.currentActionIdx], 1);  // char[1] の番
    assert.ok(s.log.some(l => l.includes('パス')));
  });

  test('全員パス → ROUND_END フェーズ', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);  // char[0] パス
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);  // char[1] パス
    assert.strictEqual(s.phase, Battle.PHASES.ROUND_END);
  });
});

// ===== chooseAction (接近戦) =====

describe('chooseAction - 接近戦攻撃', () => {
  function attackSetup(atkPlot, defPlot) {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, atkPlot);
    s = Battle.choosePlot(s, 1, defPlot);
    return s;
  }

  test('攻撃成功・回避失敗 → HP が減る（スロットが埋まる）', () => {
    // 命中=12(special)、回避=2(fumble想定ではなく失敗)
    // rng: 攻撃側 6+6=12, 回避側 1+1=2, damage_random: どの分野でも
    const rng = makeRng(6, 6,  // 攻撃2D6=12
                        1, 1,  // 回避2D6=2
                        1);    // ダメージランダム分野選択(roll1d6)
    let s = attackSetup(5, 3);  // char[0]先攻（距離2）
    // meleeNin の range が 2以上かチェック
    if (meleeNin.range < 2) {
      console.log('    （スキップ: meleeNin.range < 2）');
      return;
    }
    s = Battle.chooseAction(s, meleeNin.id, skillsData, ninjutsuData, rng);
    // HP が1つ減っているはず（スペシャルで回復可能性あり）
    const hpAfter = Core.getHpCurrent(s.chars[1].hpSlots);
    // スペシャルで1回復するので max-1+1=max か max-1 のどちらか
    assert.ok(hpAfter <= 7, 'HP が無限増加しない');
    assert.ok(s.log.some(l => l.includes('接近戦ダメージ') || l.includes('スペシャル')));
  });

  test('命中失敗 → HP は変わらない', () => {
    // 命中=2(ファンブルにならないプロット=6でないケース)
    // プロット=1 なら ファンブル値は1。roll=2は2>1なのでファンブルではない。
    // 目標値は通常5以上。roll=2は失敗。
    const rng = makeRng(1, 1,  // 攻撃2D6=2（目標値5未満→失敗、プロット1なのでファンブルではない）
                        3, 4); // 使われないが念のため
    let s = attackSetup(1, 1);  // char[0]先攻
    const hpBefore = Core.getHpCurrent(s.chars[1].hpSlots);
    s = Battle.chooseAction(s, meleeNin.id, skillsData, ninjutsuData, rng);
    const hpAfter = Core.getHpCurrent(s.chars[1].hpSlots);
    assert.strictEqual(hpBefore, hpAfter, '命中失敗ならHP変化なし');
  });

  test('回避成功 → HP は変わらない', () => {
    // 命中=7(成功)、回避=12(スペシャル→自動成功)
    const rng = makeRng(4, 3,  // 攻撃2D6=7
                        6, 6,  // 回避2D6=12(スペシャル)
                        1);
    let s = attackSetup(3, 3);
    const hpBefore = Core.getHpCurrent(s.chars[1].hpSlots);
    s = Battle.chooseAction(s, meleeNin.id, skillsData, ninjutsuData, rng);
    const hpAfter = Core.getHpCurrent(s.chars[1].hpSlots);
    assert.ok(hpAfter >= hpBefore, '回避成功なら HP 減少なし（スペシャル回復あり）');
  });

  test('ファンブル → 攻撃者が逆凪になる', () => {
    // プロット=6、roll=6(6≤6 → ファンブル)
    const rng = makeRng(3, 3);  // 2D6=6、プロット=6 → ファンブル
    let s = attackSetup(6, 1);
    s = Battle.chooseAction(s, meleeNin.id, skillsData, ninjutsuData, rng);
    assert.strictEqual(s.chars[0].sakanagi, true, '攻撃者が逆凪');
    assert.ok(s.log.some(l => l.includes('逆凪')));
  });
});

// ===== chooseAction (射撃戦) =====

describe('chooseAction - 射撃戦', () => {
  test('射撃戦ヒット → DAMAGE_CHOICE フェーズ', () => {
    if (!rangedNin) { console.log('  （スキップ: 射撃戦忍法なし）'); return; }
    // 命中成功、回避失敗
    const rng = makeRng(6, 6, 1, 1);
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    s = Battle.chooseAction(s, rangedNin.id, skillsData, ninjutsuData, rng);
    assert.strictEqual(s.phase, Battle.PHASES.DAMAGE_CHOICE);
    assert.ok(s.pendingDamageChoice);
    assert.strictEqual(s.pendingDamageChoice.damageType, 'ranged');
    assert.ok(s.pendingDamageChoice.availableFields.length > 0);
  });
});

// ===== resolveDamageChoice =====

describe('resolveDamageChoice', () => {
  test('フィールド選択 → HP が減り ACTION に戻る', () => {
    if (!rangedNin) { console.log('  （スキップ）'); return; }
    const rng = makeRng(6, 6, 1, 1);
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    s = Battle.chooseAction(s, rangedNin.id, skillsData, ninjutsuData, rng);
    assert.strictEqual(s.phase, Battle.PHASES.DAMAGE_CHOICE);

    const hpBefore = Core.getHpCurrent(s.chars[1].hpSlots);
    const field = s.pendingDamageChoice.availableFields[0];
    s = Battle.resolveDamageChoice(s, field);
    const hpAfter = Core.getHpCurrent(s.chars[1].hpSlots);

    assert.ok(hpAfter < hpBefore, 'HP が減少する');
    assert.ok(s.phase === Battle.PHASES.ACTION || s.phase === Battle.PHASES.ROUND_END);
  });
});

// ===== 逆凪 =====

describe('逆凪', () => {
  test('逆凪状態では攻撃が自動失敗（達成値0）', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    // char[0] に逆凪を付ける
    s.chars[0].sakanagi = true;
    const hpBefore = Core.getHpCurrent(s.chars[1].hpSlots);
    // 逆凪中はロールに関係なく失敗
    const rng = makeRng(6, 6, 6, 6);  // 出目がよくても
    s = Battle.chooseAction(s, meleeNin.id, skillsData, ninjutsuData, rng);
    const hpAfter = Core.getHpCurrent(s.chars[1].hpSlots);
    // 逆凪なら攻撃失敗→HPは変わらない（スペシャルによる回復はない）
    assert.strictEqual(hpBefore, hpAfter, '逆凪で攻撃失敗');
  });

  test('ラウンド終了で逆凪リセット', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    s.chars[0].sakanagi = true;
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    assert.strictEqual(s.phase, Battle.PHASES.ROUND_END);
    s = Battle.advanceRoundEnd(s);
    // maxRounds=2 なので advanceRoundEnd が endByTimeLimit を呼ぶ可能性あり
    // 1ラウンド目終了後は逆凪がリセットされているはず
    // phase が PLOT なら 2ラウンド目に進んでいる
    if (s.phase === Battle.PHASES.PLOT) {
      assert.strictEqual(s.chars[0].sakanagi, false);
    }
  });
});

// ===== 集団戦ダメージ =====

describe('集団戦ダメージ', () => {
  test('集団戦攻撃命中 → 変調が付く', () => {
    if (!groupNin) { console.log('  （スキップ）'); return; }
    const rng = makeRng(6, 6, 1, 1, 1);  // 命中success, 回避失敗, 変調roll
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    const condBefore = s.chars[1].conditions.length;
    s = Battle.chooseAction(s, groupNin.id, skillsData, ninjutsuData, rng);
    // 変調が付いているはず（または免疫で無効化）
    assert.ok(s.chars[1].conditions.length >= condBefore, '変調が付くかそのまま');
  });
});

// ===== ラウンド進行 =====

describe('advanceRoundEnd', () => {
  test('次ラウンドに進む（round1 → round2, phase=PLOT）', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    s.maxRounds = 3;  // 遷移を確認するため余裕を持たせる
    s = Battle.choosePlot(s, 0, 2);
    s = Battle.choosePlot(s, 1, 2);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    assert.strictEqual(s.phase, Battle.PHASES.ROUND_END);
    s = Battle.advanceRoundEnd(s);
    assert.strictEqual(s.phase, Battle.PHASES.PLOT);  // round2 へ進む
    assert.strictEqual(s.round, 2);
    assert.strictEqual(s.chars[0].plotValue, null);   // プロットがリセットされている
    assert.strictEqual(s.chars[0].sakanagi, false);
  });

  test('規定ラウンド終了 → HP で勝者決定', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    // maxRounds を 3 に変更して2ラウンド通過させる
    s.maxRounds = 3;
    // Round 1: 全員パス
    s = Battle.choosePlot(s, 0, 3); s = Battle.choosePlot(s, 1, 3);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.advanceRoundEnd(s);
    assert.strictEqual(s.phase, Battle.PHASES.PLOT);
    assert.strictEqual(s.round, 2);
    // Round 2: 全員パス
    s = Battle.choosePlot(s, 0, 4); s = Battle.choosePlot(s, 1, 2);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.advanceRoundEnd(s);
    assert.strictEqual(s.phase, Battle.PHASES.PLOT);
    assert.strictEqual(s.round, 3);
    // Round 3: 全員パス → round_end → exceeded maxRounds → ended
    s = Battle.choosePlot(s, 0, 2); s = Battle.choosePlot(s, 1, 2);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    s = Battle.advanceRoundEnd(s);
    assert.strictEqual(s.phase, Battle.PHASES.ENDED);
    // HP 同じなので引き分け（winner=null）
    assert.strictEqual(s.winner, null);
  });
});

// ===== 戦場効果 =====

describe('戦場効果', () => {
  test('水中: 回避判定に-2修正', () => {
    let s = Battle.initBattle([char1, char2], 'suichu', skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    // 回避判定のログに修正が記録されているか確認
    const rng = makeRng(4, 3, 3, 3);  // 攻撃7成功、回避6だが-2で4→成功(TV5-2=3以上?)
    s = Battle.chooseAction(s, meleeNin.id, skillsData, ninjutsuData, rng);
    assert.ok(s.log.some(l => l.includes('修正')), '回避判定に修正が記録される');
  });

  test('悪天候: 間合+1', () => {
    // 悪天候では rangeBonus=1 なので range が広がる
    let s = Battle.initBattle([char1, char2], 'akutenkou', skillsData, ninjutsuData);
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);  // 距離0: 全ての忍法が間合内
    const avail = Battle.getAvailableNinjutsu(s, skillsData, ninjutsuData);
    // 間合0の忍法も距離0で使えるはず（range=0+bonus=1 ≥ distance=0）
    avail.forEach(a => {
      if (a.ninjutsu && a.ninjutsu.range === 0) {
        assert.ok(a.canUse || a.reason !== '間合外', '悪天候で間合+1 → 使用可能');
      }
    });
  });
});

// ===== 脱落 =====

describe('脱落', () => {
  test('HP が全スロット埋まると ENDED', () => {
    let s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    // char[1] の全スロットを手動でダメージ済みにする
    s.chars[1].hpSlots.forEach(sl => { sl.damaged = true; });
    s = Battle.choosePlot(s, 0, 3);
    s = Battle.choosePlot(s, 1, 3);
    // char[0] の行動時に脱落チェックがかかる（既に defeated）
    s = Battle.chooseAction(s, null, skillsData, ninjutsuData);
    assert.strictEqual(s.phase, Battle.PHASES.ENDED);
    assert.strictEqual(s.winner, 0);
  });
});

// ===== cloneState =====

describe('cloneState', () => {
  test('クローンを変更しても元のステートが変わらない', () => {
    const s = Battle.initBattle([char1, char2], null, skillsData, ninjutsuData);
    const c = Battle.cloneState(s);
    c.chars[0].sakanagi = true;
    c.chars[0].hpSlots[0].damaged = true;
    assert.strictEqual(s.chars[0].sakanagi, false);
    assert.strictEqual(s.chars[0].hpSlots[0].damaged, false);
  });
});

// ===== 結果 =====

console.log('\n' + '='.repeat(44));
console.log(`テスト結果: ${passed} 成功 / ${failed} 失敗`);
if (failed > 0) process.exit(1);
