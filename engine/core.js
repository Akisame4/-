/**
 * 忍戦 コアエンジン
 * UIなしのロジック単体。ブラウザ・Node.js 両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NinjaBattleCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ===== 定数 =====

  const FIELDS = ['器術', '体術', '忍術', '謀術', '戦術', '妖術'];

  // 変調一覧（4.5）。インデックス=1d6の出目-1
  const CONDITIONS = ['敗走', 'マヒ', '重傷', '行方不明', '忘却', '呪い'];
  const CONDITION_STACKABLE = {
    '敗走': false, 'マヒ': true, '重傷': true,
    '行方不明': false, '忘却': true, '呪い': true,
  };

  // 戦場表（4.8）。インデックス=1d6の出目-1
  const BATTLEFIELDS = [
    { id: 'hirachi',    name: '平地',   effectType: 'none',                  value: null },
    { id: 'suichu',    name: '水中',   effectType: 'dodge_penalty',         value: -2   },
    { id: 'kosho',     name: '高所',   effectType: 'fumble_damage',         value: 1    },
    { id: 'akutenkou', name: '悪天候', effectType: 'range_bonus',           value: 1    },
    { id: 'zattou',    name: '雑踏',   effectType: 'fumble_value_up',       value: 1    },
    { id: 'kyokuchi',  name: '極地',   effectType: 'round_end_damage_check',value: null },
  ];

  // ===== ダイス =====

  function roll2d6(rng) {
    rng = rng || Math.random;
    const d1 = Math.floor(rng() * 6) + 1;
    const d2 = Math.floor(rng() * 6) + 1;
    return { d1, d2, total: d1 + d2 };
  }

  function roll1d6(rng) {
    rng = rng || Math.random;
    return Math.floor(rng() * 6) + 1;
  }

  // ===== 判定（設計書 2.2 / 4.1） =====

  /**
   * 代用判定の目標値を計算する。
   * @param {string[]}   charSkillNames          - キャラクターの習得特技名リスト
   * @param {string}     requiredSkill           - 忍法の指定特技名。'自由' or null は常に5
   * @param {number|null} factionFavoredFieldIndex - 流派得意分野インデックス（なければnull）
   * @param {Object[]}   skillsData              - skills.json の skills 配列
   * @returns {number}
   */
  function calcTargetValue(charSkillNames, requiredSkill, factionFavoredFieldIndex, skillsData) {
    if (!requiredSkill || requiredSkill === '自由') return 5;

    const reqEntry = skillsData.find(s => s.name === requiredSkill);
    if (!reqEntry) return 5; // 未知特技は基本値

    const requiredFI = reqEntry.field_index;

    const myFIs = charSkillNames
      .map(name => skillsData.find(s => s.name === name))
      .filter(Boolean)
      .map(s => s.field_index);

    if (myFIs.length === 0) return 5 + 5;

    let minDist = Math.min(...myFIs.map(fi => Math.abs(fi - requiredFI)));

    // 得意分野スキップ：習得特技に得意分野が含まれ、かつ得意分野が必要分野の隣なら距離-1
    if (
      factionFavoredFieldIndex !== null &&
      factionFavoredFieldIndex !== undefined &&
      myFIs.includes(factionFavoredFieldIndex)
    ) {
      const favoredToRequired = Math.abs(factionFavoredFieldIndex - requiredFI);
      if (favoredToRequired === 1) {
        minDist = Math.max(0, minDist - 1);
      }
    }

    return 5 + minDist;
  }

  /**
   * 2D6判定を解決する（4.1 / 4.1.1）。
   * @param {Object} p
   * @param {{d1,d2,total}} p.roll
   * @param {number}  p.targetValue
   * @param {number}  p.plotValue    - 自プロット値（ファンブル判定基準）
   * @param {boolean} p.isSakanagi  - 逆凪中は強制失敗・達成値0
   * @param {number}  [p.modifier]  - 修正値（サポート忍法など）
   * @returns {{ success, isSpecial, isFumble, achievementValue }}
   */
  function resolveCheck({ roll, targetValue, plotValue, isSakanagi, modifier }) {
    modifier = modifier || 0;

    if (isSakanagi) {
      return { success: false, isSpecial: false, isFumble: false, achievementValue: 0 };
    }

    // スペシャル（出目12）は先にチェック。12 > plotValue(max6) なのでファンブルと排他
    if (roll.total === 12) {
      return { success: true, isSpecial: true, isFumble: false, achievementValue: 12 + modifier };
    }

    if (roll.total <= plotValue) {
      return { success: false, isSpecial: false, isFumble: true, achievementValue: 0 };
    }

    const achievementValue = roll.total + modifier;
    return {
      success: achievementValue >= targetValue,
      isSpecial: false,
      isFumble: false,
      achievementValue,
    };
  }

  // ===== 生命力スロット（4.3） =====

  /**
   * キャラクターの生命力スロットを生成する。
   * 頑健1つ目=+2、2つ目以降=+1（設計書 3.8）。
   * @param {string[]} ninjutsuNames - 修得忍法名リスト（重複含む）
   * @returns {Object[]}
   */
  function createHpSlots(ninjutsuNames) {
    const base = FIELDS.map((field, fi) => ({
      field, fieldIndex: fi, isBase: true, damaged: false,
    }));

    const gankenCount = ninjutsuNames.filter(n => n === '頑健').length;
    const extra = [];
    if (gankenCount >= 1) {
      extra.push({ field: null, fieldIndex: null, isBase: false, damaged: false });
      extra.push({ field: null, fieldIndex: null, isBase: false, damaged: false });
    }
    for (let i = 1; i < gankenCount; i++) {
      extra.push({ field: null, fieldIndex: null, isBase: false, damaged: false });
    }

    return [...base, ...extra];
  }

  function getHpCurrent(slots) {
    return slots.filter(s => !s.damaged).length;
  }

  function hasExtraUndamagedSlot(slots) {
    return slots.some(s => !s.isBase && !s.damaged);
  }

  // ===== ダメージ処理（4.4） =====

  /**
   * 接近戦ダメージ1点を適用する（4.4①）。
   * ランダムで分野を決定し、そのスロットが空なら即確定。
   * 埋まっていれば受けた側が選択（completeMeleeHitChoice を後続で呼ぶ）。
   * @param {Object[]} slots  - hpSlots（mutates when needsChoice=false）
   * @param {Function} [rng]
   * @returns {{ needsChoice, randomField, damagedField, availableFields }}
   */
  function applyMeleeHit(slots, rng) {
    rng = rng || Math.random;
    const fieldName = FIELDS[Math.floor(rng() * 6)];
    const targetSlot = slots.find(s => s.field === fieldName && !s.damaged);

    if (targetSlot) {
      targetSlot.damaged = true;
      return { needsChoice: false, randomField: fieldName, damagedField: fieldName };
    }

    const availableFields = slots.filter(s => !s.damaged).map(s => s.field);
    return { needsChoice: true, randomField: fieldName, damagedField: null, availableFields };
  }

  /**
   * 接近戦ダメージの受け手選択を完了する（needsChoice=true の後に呼ぶ）。
   * chosenField=null は追加スロット（頑健由来）を指定。
   * @param {Object[]} slots
   * @param {string|null} chosenField
   */
  function completeMeleeHitChoice(slots, chosenField) {
    const slot = slots.find(s => s.field === chosenField && !s.damaged);
    if (slot) slot.damaged = true;
  }

  /**
   * 射撃戦ダメージ1点を適用する（4.4②）。受け手が自由選択。
   * @param {Object[]} slots
   * @param {string|null} chosenField
   * @returns {boolean} 適用できたか
   */
  function applyRangedHit(slots, chosenField) {
    const slot = slots.find(s => s.field === chosenField && !s.damaged);
    if (!slot) return false;
    slot.damaged = true;
    return true;
  }

  /**
   * 集団戦ダメージを適用する（4.4③）。HP減少なし、変調をランダムで1つ付与。
   * @param {string[]} statusEffects - キャラクターの変調リスト（mutates）
   * @param {Function} [rng]
   * @returns {{ condition, applied }}
   */
  function applyGroupDamage(statusEffects, rng) {
    rng = rng || Math.random;
    const condition = CONDITIONS[Math.floor(rng() * 6)];

    if (!CONDITION_STACKABLE[condition] && statusEffects.includes(condition)) {
      return { condition, applied: false };
    }

    statusEffects.push(condition);
    return { condition, applied: true };
  }

  // ===== 戦場（4.8） =====

  function rollBattlefield(rng) {
    rng = rng || Math.random;
    return BATTLEFIELDS[Math.floor(rng() * 6)];
  }

  function getBattlefieldById(id) {
    return BATTLEFIELDS.find(b => b.id === id) || BATTLEFIELDS[0];
  }

  /**
   * 戦場が判定に与える修正を返す。
   * 高所・極地はラウンド処理で個別に判定する（shouldApplyKoshoFumbleDamage / resolveKyokuchiRoundEnd）。
   */
  function getBattlefieldModifiers(battlefield) {
    const mods = { dodgeModifier: 0, rangeBonus: 0, fumbleValueModifier: 0 };
    if (!battlefield) return mods;
    switch (battlefield.effectType) {
      case 'dodge_penalty':     mods.dodgeModifier      = battlefield.value; break;
      case 'range_bonus':       mods.rangeBonus         = battlefield.value; break;
      case 'fumble_value_up':   mods.fumbleValueModifier= battlefield.value; break;
    }
    return mods;
  }

  /** 高所：ファンブル時に接近戦ダメージ1点が発生するか */
  function shouldApplyKoshoFumbleDamage(battlefield, checkResult) {
    return !!(battlefield && battlefield.id === 'kosho' && checkResult.isFumble);
  }

  /**
   * 極地：ラウンド終了時に1d6を振り、経過ラウンド以下なら全員に接近戦ダメージ1点。
   * @returns {{ triggered, roll }}
   */
  function resolveKyokuchiRoundEnd(round, rng) {
    const d = roll1d6(rng);
    return { triggered: d <= round, roll: d };
  }

  // ===== ラウンド管理 =====

  /** ラウンド終了時に逆凪フラグをリセットする（4.1.1） */
  function resetRoundState(characters) {
    characters.forEach(c => { c.isSakanagi = false; });
  }

  /** キャラクターが脱落しているか（4.6） */
  function isDefeated(character) {
    return getHpCurrent(character.hpSlots) <= 0;
  }

  // ===== 間合い・コスト =====

  /**
   * 忍法が使用可能な間合いにあるか（4.2 行動フェーズ）。
   * |攻撃者プロット - 目標プロット| ≤ range + rangeBonus
   */
  function isInRange(attackerPlot, targetPlot, ninjutsuRange, rangeBonus) {
    return Math.abs(attackerPlot - targetPlot) <= ninjutsuRange + (rangeBonus || 0);
  }

  /**
   * コスト支払いが可能か（使用忍法合計コスト ≤ 自プロット値）。
   * @param {number[]} costs
   * @param {number}   plotValue
   */
  function canPayCost(costs, plotValue) {
    return costs.reduce((a, b) => a + b, 0) <= plotValue;
  }

  // ===== エクスポート =====

  return {
    FIELDS, CONDITIONS, CONDITION_STACKABLE, BATTLEFIELDS,
    roll2d6, roll1d6,
    calcTargetValue, resolveCheck,
    createHpSlots, getHpCurrent, hasExtraUndamagedSlot,
    applyMeleeHit, completeMeleeHitChoice, applyRangedHit, applyGroupDamage,
    rollBattlefield, getBattlefieldById, getBattlefieldModifiers,
    shouldApplyKoshoFumbleDamage, resolveKyokuchiRoundEnd,
    resetRoundState, isDefeated,
    isInRange, canPayCost,
  };
});
