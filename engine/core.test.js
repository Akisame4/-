/**
 * 忍戦 コアエンジン ユニットテスト
 * 実行: node engine/core.test.js  （プロジェクトルートから）
 */

'use strict';

const assert = require('assert');
const core = require('./core');
const skillsData = require('../data/skills.json').skills;
const factions   = require('../data/factions.json').factions;

// ===== シンプルなテストランナー =====

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  ✓', name);
    passed++;
  } catch (e) {
    console.error('  ✗', name);
    console.error('   ', e.message);
    failed++;
  }
}

function describe(label, fn) {
  console.log('\n[' + label + ']');
  fn();
}

// rng ヘルパー：決定論的な出目を作る
// roll2d6/roll1d6 は Math.floor(rng() * 6) + 1 なので、
//   目的の出目 n → rng() = (n - 1) / 6 でちょうど n になる
function makeRng(...vals) {
  let i = 0;
  return () => (vals[i++] - 1) / 6;
}

// resolveCheck 用の roll オブジェクトを作るショートカット（テスト専用モック）
function mkRoll(total) {
  return { d1: 1, d2: total - 1, total };
}

// ===== calcTargetValue =====
// 目標値 = 5 + 縦距離(|row差|) + 有料ギャップ数
// 得意分野に隣接する2つのギャップは無料（0コスト）

describe('calcTargetValue（代用判定目標値）', () => {
  const hasuba   = factions.find(f => f.id === 'hasuba');   // 得意=器術(fi=0)
  const hirasaka = factions.find(f => f.id === 'hirasaka'); // 得意=謀術(fi=3)
  const hagure   = factions.find(f => f.id === 'hagure');   // 得意=忍術(fi=2)

  test('指定特技が自由 → 5', () => {
    assert.strictEqual(core.calcTargetValue(['絡繰術'], '自由', 0, skillsData), 5);
  });

  test('指定特技がnull → 5', () => {
    assert.strictEqual(core.calcTargetValue(['絡繰術'], null, 0, skillsData), 5);
  });

  test('指定特技を習得済み → 5', () => {
    assert.strictEqual(core.calcTargetValue(['火術'], '火術', null, skillsData), 5);
  });

  test('同分野・縦距離 → 5+10=15', () => {
    // 絡繰術(fi=0,row=1)所持、掘削術(fi=0,row=11)指定
    // ギャップなし、縦=|1-11|=10 → TV=15
    assert.strictEqual(core.calcTargetValue(['絡繰術'], '掘削術', null, skillsData), 15);
  });

  test('隣分野・同行 → 5+0+1=6', () => {
    // 絡繰術(fi=0,row=1)所持、騎乗術(fi=1,row=1)指定
    // 縦=0、ギャップ1個(有料) → TV=6
    assert.strictEqual(core.calcTargetValue(['絡繰術'], '騎乗術', null, skillsData), 6);
  });

  test('2分野離れ・同行 → 5+0+2=7', () => {
    // 絡繰術(fi=0,row=1)所持、生存術(fi=2,row=1)指定
    // 縦=0、ギャップ2個(有料) → TV=7
    assert.strictEqual(core.calcTargetValue(['絡繰術'], '生存術', null, skillsData), 7);
  });

  test('複数特技 → 2D距離が最小の特技を使う', () => {
    // 絡繰術(fi=0,row=1)と第六感(fi=2,row=11)を持ち、骨法術(fi=1,row=9)指定
    // 絡繰術→骨法術: |1-9|+1=9  /  第六感→骨法術: |11-9|+1=3 ← 最小
    assert.strictEqual(core.calcTargetValue(['絡繰術', '第六感'], '骨法術', null, skillsData), 8);
  });

  // 得意分野テスト（ハグレモノ=忍術 fi=2）
  // 無料ギャップ: 体術-忍術間(fi=1-2)、忍術-謀術間(fi=2-3)

  test('得意=忍術：地の利(fi=4,row=4)→盗聴術(fi=2,row=4) → 5+0+1=6', () => {
    // 謀術-忍術ギャップ=無料、戦術-謀術ギャップ=有料1個
    assert.strictEqual(
      core.calcTargetValue(['地の利'], '盗聴術', hagure.favored_field_index, skillsData), 6
    );
  });

  test('得意=忍術：走法(fi=1,row=7)→調査術(fi=3,row=4) → 5+3+0=8', () => {
    // 体術-忍術=無料、忍術-謀術=無料 → ギャップ0個
    // 縦=|7-4|=3 → TV=8
    assert.strictEqual(
      core.calcTargetValue(['走法'], '調査術', hagure.favored_field_index, skillsData), 8
    );
  });

  // 得意分野テスト（斜歯忍軍=器術 fi=0）
  // 無料ギャップ: 器術-体術間(fi=0-1)のみ（fi=-1は存在しない）

  test('得意=器術：絡繰術(fi=0,row=1)→騎乗術(fi=1,row=1) → 5+0+0=5', () => {
    // gap(0-1)=無料 → TV=5
    assert.strictEqual(
      core.calcTargetValue(['絡繰術'], '騎乗術', hasuba.favored_field_index, skillsData), 5
    );
  });

  test('得意=器術：絡繰術(fi=0,row=1)→生存術(fi=2,row=1) → 5+0+1=6', () => {
    // gap(0-1)=無料、gap(1-2)=有料1個 → TV=6
    assert.strictEqual(
      core.calcTargetValue(['絡繰術'], '生存術', hasuba.favored_field_index, skillsData), 6
    );
  });

  // 得意分野テスト（比良坂機関=謀術 fi=3）
  // 無料ギャップ: 忍術-謀術間(fi=2-3)、謀術-戦術間(fi=3-4)

  test('得意=謀術：同分野 縦2マス → 5+2=7', () => {
    // 調査術(fi=3,row=4)所持、対人術(fi=3,row=6)指定
    // ギャップなし、縦=2 → TV=7
    assert.strictEqual(
      core.calcTargetValue(['調査術'], '対人術', hirasaka.favored_field_index, skillsData), 7
    );
  });

  test('得意=謀術：調査術(fi=3,row=4)→記憶術(fi=4,row=7) gap無料 → 5+3=8', () => {
    // gap(3-4)=無料(謀術に隣接)、縦=|4-7|=3 → TV=8
    assert.strictEqual(
      core.calcTargetValue(['調査術'], '記憶術', hirasaka.favored_field_index, skillsData), 8
    );
  });
});

// ===== roll2d6 =====

describe('roll2d6', () => {
  test('出目は常に2〜12の範囲', () => {
    for (let i = 0; i < 200; i++) {
      const r = core.roll2d6();
      assert.ok(r.total >= 2 && r.total <= 12, 'total=' + r.total);
      assert.ok(r.d1 >= 1 && r.d1 <= 6);
      assert.ok(r.d2 >= 1 && r.d2 <= 6);
    }
  });

  test('決定論的rngで再現性あり', () => {
    const r = core.roll2d6(makeRng(2, 5)); // d1=2, d2=5
    assert.strictEqual(r.d1, 2);
    assert.strictEqual(r.d2, 5);
    assert.strictEqual(r.total, 7);
  });
});

// ===== resolveCheck =====

describe('resolveCheck（判定解決）', () => {
  test('通常成功', () => {
    const r = core.resolveCheck({ roll: mkRoll(7), targetValue: 5, plotValue: 3, isSakanagi: false });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.isSpecial, false);
    assert.strictEqual(r.isFumble, false);
    assert.strictEqual(r.achievementValue, 7);
  });

  test('通常失敗', () => {
    const r = core.resolveCheck({ roll: mkRoll(4), targetValue: 5, plotValue: 3, isSakanagi: false });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.isFumble, false);
  });

  test('スペシャル（出目12）→ 自動成功', () => {
    const r = core.resolveCheck({ roll: mkRoll(12), targetValue: 99, plotValue: 6, isSakanagi: false });
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.isSpecial, true);
    assert.strictEqual(r.isFumble, false);
  });

  test('プロット値6でも出目12はスペシャル（ファンブルにならない）', () => {
    const r = core.resolveCheck({ roll: mkRoll(12), targetValue: 5, plotValue: 6, isSakanagi: false });
    assert.strictEqual(r.isSpecial, true);
    assert.strictEqual(r.isFumble, false);
  });

  test('ファンブル（出目 ≤ プロット値）→ 自動失敗', () => {
    const r = core.resolveCheck({ roll: mkRoll(4), targetValue: 5, plotValue: 4, isSakanagi: false });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.isFumble, true);
  });

  test('プロット値1・出目2→ファンブルなし', () => {
    const r = core.resolveCheck({ roll: mkRoll(2), targetValue: 5, plotValue: 1, isSakanagi: false });
    assert.strictEqual(r.isFumble, false);
  });

  test('プロット値1・出目1→ファンブル', () => {
    const r = core.resolveCheck({ roll: { d1: 1, d2: 0, total: 1 }, targetValue: 5, plotValue: 1, isSakanagi: false });
    assert.strictEqual(r.isFumble, true);
  });

  test('逆凪中 → 常に失敗・達成値0', () => {
    const r = core.resolveCheck({ roll: mkRoll(12), targetValue: 5, plotValue: 1, isSakanagi: true });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.achievementValue, 0);
    assert.strictEqual(r.isSpecial, false);
  });

  test('修正+2 で成功に転じる', () => {
    const r = core.resolveCheck({ roll: mkRoll(6), targetValue: 8, plotValue: 3, isSakanagi: false, modifier: 2 });
    assert.strictEqual(r.achievementValue, 8);
    assert.strictEqual(r.success, true);
  });

  test('修正-2 で失敗に転じる', () => {
    const r = core.resolveCheck({ roll: mkRoll(6), targetValue: 5, plotValue: 3, isSakanagi: false, modifier: -2 });
    assert.strictEqual(r.achievementValue, 4);
    assert.strictEqual(r.success, false);
  });
});

// ===== createHpSlots / getHpCurrent =====

describe('createHpSlots / getHpCurrent（生命力スロット）', () => {
  test('頑健なし → 6スロット', () => {
    const slots = core.createHpSlots([]);
    assert.strictEqual(slots.length, 6);
    assert.strictEqual(core.getHpCurrent(slots), 6);
  });

  test('頑健1つ → 8スロット（+2）', () => {
    const slots = core.createHpSlots(['頑健']);
    assert.strictEqual(slots.length, 8);
    assert.strictEqual(core.getHpCurrent(slots), 8);
  });

  test('頑健2つ → 9スロット（+2+1）', () => {
    const slots = core.createHpSlots(['頑健', '頑健']);
    assert.strictEqual(slots.length, 9);
  });

  test('頑健3つ → 10スロット（+2+1+1）', () => {
    const slots = core.createHpSlots(['頑健', '頑健', '頑健']);
    assert.strictEqual(slots.length, 10);
  });

  test('ダメージを受けると getHpCurrent が減る', () => {
    const slots = core.createHpSlots([]);
    slots[0].damaged = true;
    assert.strictEqual(core.getHpCurrent(slots), 5);
  });
});

// ===== applyMeleeHit =====

describe('applyMeleeHit（接近戦ダメージ）', () => {
  test('空きスロット → needsChoice=false、スロット削れる', () => {
    const slots = core.createHpSlots([]);
    const r = core.applyMeleeHit(slots, makeRng(1)); // 出目1 → FIELDS[0]=器術
    assert.strictEqual(r.needsChoice, false);
    assert.strictEqual(r.randomField, '器術');
    assert.strictEqual(r.damagedField, '器術');
    assert.strictEqual(core.getHpCurrent(slots), 5);
    assert.strictEqual(slots.find(s => s.field === '器術').damaged, true);
  });

  test('既に埋まったスロット → needsChoice=true、HP変化なし', () => {
    const slots = core.createHpSlots([]);
    slots.find(s => s.field === '器術').damaged = true;
    const r = core.applyMeleeHit(slots, makeRng(1)); // また器術
    assert.strictEqual(r.needsChoice, true);
    assert.strictEqual(r.randomField, '器術');
    assert.strictEqual(core.getHpCurrent(slots), 5);
  });

  test('completeMeleeHitChoice で選択完了', () => {
    const slots = core.createHpSlots([]);
    slots.find(s => s.field === '器術').damaged = true;
    core.applyMeleeHit(slots, makeRng(1));
    core.completeMeleeHitChoice(slots, '体術');
    assert.strictEqual(core.getHpCurrent(slots), 4);
    assert.strictEqual(slots.find(s => s.field === '体術').damaged, true);
  });

  test('全スロット消費 → HP=0、isDefeated=true', () => {
    const slots = core.createHpSlots([]);
    core.FIELDS.forEach(f => core.completeMeleeHitChoice(slots, f));
    assert.strictEqual(core.getHpCurrent(slots), 0);
    assert.strictEqual(core.isDefeated({ hpSlots: slots }), true);
  });

  test('availableFields に残りスロットが含まれる', () => {
    const slots = core.createHpSlots([]);
    slots.find(s => s.field === '器術').damaged = true;
    const r = core.applyMeleeHit(slots, makeRng(1));
    assert.ok(Array.isArray(r.availableFields));
    assert.strictEqual(r.availableFields.includes('器術'), false); // 埋まっているので除外
    assert.strictEqual(r.availableFields.length, 5);
  });
});

// ===== applyRangedHit =====

describe('applyRangedHit（射撃戦ダメージ）', () => {
  test('好きな分野を選択して削れる', () => {
    const slots = core.createHpSlots([]);
    const ok = core.applyRangedHit(slots, '妖術');
    assert.strictEqual(ok, true);
    assert.strictEqual(core.getHpCurrent(slots), 5);
    assert.strictEqual(slots.find(s => s.field === '妖術').damaged, true);
  });

  test('既に埋まった分野は選択不可', () => {
    const slots = core.createHpSlots([]);
    core.applyRangedHit(slots, '妖術');
    const ok = core.applyRangedHit(slots, '妖術');
    assert.strictEqual(ok, false);
    assert.strictEqual(core.getHpCurrent(slots), 5);
  });

  test('追加スロット（null）も指定可能', () => {
    const slots = core.createHpSlots(['頑健']);
    const ok = core.applyRangedHit(slots, null);
    assert.strictEqual(ok, true);
    assert.strictEqual(core.getHpCurrent(slots), 7);
  });
});

// ===== applyGroupDamage =====

describe('applyGroupDamage（集団戦ダメージ）', () => {
  test('HPは減らない', () => {
    const slots = core.createHpSlots([]);
    const se = [];
    core.applyGroupDamage(se, makeRng(1)); // 出目1 → 敗走
    assert.strictEqual(core.getHpCurrent(slots), 6); // slots は無傷
  });

  test('変調が付与される（敗走）', () => {
    const se = [];
    const r = core.applyGroupDamage(se, makeRng(1)); // index=0 → 敗走
    assert.strictEqual(r.condition, '敗走');
    assert.strictEqual(r.applied, true);
    assert.ok(se.includes('敗走'));
  });

  test('累積不可変調（敗走・行方不明）は重複しない', () => {
    const se = ['敗走'];
    const r = core.applyGroupDamage(se, makeRng(1));
    assert.strictEqual(r.applied, false);
    assert.strictEqual(se.filter(s => s === '敗走').length, 1);
  });

  test('累積可能変調（マヒ）は重複付与される', () => {
    const se = ['マヒ'];
    const r = core.applyGroupDamage(se, makeRng(2)); // index=1 → マヒ
    assert.strictEqual(r.applied, true);
    assert.strictEqual(se.filter(s => s === 'マヒ').length, 2);
  });

  test('6種類の変調がすべて抽選可能', () => {
    const results = new Set();
    for (let i = 1; i <= 6; i++) {
      const se = [];
      core.applyGroupDamage(se, makeRng(i));
      results.add(se[0]);
    }
    assert.strictEqual(results.size, 6);
    core.CONDITIONS.forEach(c => assert.ok(results.has(c), '未出現: ' + c));
  });
});

// ===== 戦場 =====

describe('戦場（4.8）', () => {
  test('rollBattlefield で6種類すべてが出る', () => {
    const ids = new Set();
    for (let i = 1; i <= 6; i++) {
      ids.add(core.rollBattlefield(makeRng(i)).id);
    }
    assert.strictEqual(ids.size, 6);
  });

  test('平地: 修正なし', () => {
    const mods = core.getBattlefieldModifiers(core.getBattlefieldById('hirachi'));
    assert.strictEqual(mods.dodgeModifier, 0);
    assert.strictEqual(mods.rangeBonus, 0);
    assert.strictEqual(mods.fumbleValueModifier, 0);
  });

  test('水中: 回避に-2', () => {
    const mods = core.getBattlefieldModifiers(core.getBattlefieldById('suichu'));
    assert.strictEqual(mods.dodgeModifier, -2);
  });

  test('悪天候: 間合+1', () => {
    const mods = core.getBattlefieldModifiers(core.getBattlefieldById('akutenkou'));
    assert.strictEqual(mods.rangeBonus, 1);
  });

  test('雑踏: ファンブル値+1', () => {
    const mods = core.getBattlefieldModifiers(core.getBattlefieldById('zattou'));
    assert.strictEqual(mods.fumbleValueModifier, 1);
  });

  test('高所: ファンブル時にダメージフラグ=true', () => {
    const bf = core.getBattlefieldById('kosho');
    const fumble = core.resolveCheck({ roll: mkRoll(2), targetValue: 5, plotValue: 3, isSakanagi: false });
    assert.strictEqual(core.shouldApplyKoshoFumbleDamage(bf, fumble), true);
  });

  test('高所: 通常判定ではダメージフラグ=false', () => {
    const bf = core.getBattlefieldById('kosho');
    const normal = core.resolveCheck({ roll: mkRoll(7), targetValue: 5, plotValue: 3, isSakanagi: false });
    assert.strictEqual(core.shouldApplyKoshoFumbleDamage(bf, normal), false);
  });

  test('極地: 出目 ≤ ラウンドなら発動', () => {
    // ラウンド3・出目3 → triggered
    const r = core.resolveKyokuchiRoundEnd(3, makeRng(3));
    assert.strictEqual(r.triggered, true);
    assert.strictEqual(r.roll, 3);
  });

  test('極地: 出目 > ラウンドなら不発', () => {
    // ラウンド2・出目4 → not triggered
    const r = core.resolveKyokuchiRoundEnd(2, makeRng(4));
    assert.strictEqual(r.triggered, false);
  });
});

// ===== 間合い・コスト =====

describe('isInRange / canPayCost', () => {
  test('間合い内', () => {
    assert.strictEqual(core.isInRange(4, 2, 2, 0), true); // |4-2|=2 ≤ 2
  });

  test('間合い外', () => {
    assert.strictEqual(core.isInRange(4, 1, 2, 0), false); // |4-1|=3 > 2
  });

  test('悪天候ボーナスで届く', () => {
    assert.strictEqual(core.isInRange(4, 1, 2, 1), true); // 3 ≤ 3
  });

  test('同プロット値（間合0）', () => {
    assert.strictEqual(core.isInRange(3, 3, 0, 0), true);
  });

  test('コスト支払い可能', () => {
    assert.strictEqual(core.canPayCost([1, 2], 4), true); // 3 ≤ 4
  });

  test('コスト超過', () => {
    assert.strictEqual(core.canPayCost([2, 3], 4), false); // 5 > 4
  });

  test('コスト0（無料忍法）', () => {
    assert.strictEqual(core.canPayCost([0], 1), true);
  });
});

// ===== resetRoundState =====

describe('resetRoundState', () => {
  test('全キャラの逆凪フラグがリセットされる', () => {
    const chars = [{ isSakanagi: true }, { isSakanagi: true }, { isSakanagi: false }];
    core.resetRoundState(chars);
    chars.forEach(c => assert.strictEqual(c.isSakanagi, false));
  });
});

// ===== 結果 =====

console.log('\n' + '='.repeat(44));
console.log(`テスト結果: ${passed} 成功 / ${failed} 失敗`);
if (failed > 0) process.exit(1);
