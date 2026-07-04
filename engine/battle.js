/**
 * 忍戦 戦闘ステートマシン
 * 1ラウンドの流れ：プロット → 行動 → (ダメージ選択) → ラウンド終了
 * 純粋関数ベース。rng を注入することで決定論的テスト可能。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./core'));
  } else {
    root.NinjaBattleBattle = factory(root.NinjaBattleCore);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const PHASES = {
    PLOT:          'plot',
    ACTION:        'action',
    DAMAGE_CHOICE: 'damage_choice',
    ROUND_END:     'round_end',
    ENDED:         'ended',
  };

  // ===== 内部ヘルパー =====

  function isCharDefeated(c) {
    return c.conditions.includes('行方不明') || Core.getHpCurrent(c.hpSlots) === 0;
  }

  function cloneState(s) {
    return {
      ...s,
      chars: s.chars.map(c => ({
        ...c,
        hpSlots:    c.hpSlots.map(sl => ({ ...sl })),
        conditions: [...c.conditions],
        skillNames: [...c.skillNames],
        ninjutsuIds:[...c.ninjutsuIds],
        immuneConditions: [...(c.immuneConditions || [])],
      })),
      teams: s.teams ? s.teams.map(t => ({ ...t })) : [],
      actionOrder: [...s.actionOrder],
      log:         [...s.log],
      pendingDamageChoice: s.pendingDamageChoice
        ? { ...s.pendingDamageChoice, availableFields: [...s.pendingDamageChoice.availableFields] }
        : null,
    };
  }

  /** ダメージスロットを1つ回復（スペシャル時）。ベーススロット優先。 */
  function recoverOneHp(hpSlots) {
    const slot = hpSlots.find(sl => sl.damaged && sl.isBase)
               || hpSlots.find(sl => sl.damaged);
    if (slot) { slot.damaged = false; return true; }
    return false;
  }

  function endBattle(s, winnerTeamIdx) {
    s.phase = PHASES.ENDED;
    s.winnerTeamIdx = winnerTeamIdx;
    let winnerName = '引き分け';
    if (winnerTeamIdx !== null && winnerTeamIdx !== undefined) {
      const team = s.teams && s.teams.find(t => t.idx === winnerTeamIdx);
      if (team) {
        winnerName = team.name;
      } else {
        const wchar = s.chars.find(c => c.teamIdx === winnerTeamIdx);
        winnerName = wchar ? wchar.name : `チーム${winnerTeamIdx}`;
      }
    }
    s.log.push(`=== 戦闘終了 === 勝者: ${winnerName}`);
    return s;
  }

  function getLivingTeams(chars) {
    const seen = new Set();
    const living = [];
    for (const c of chars) {
      if (!isCharDefeated(c) && !seen.has(c.teamIdx)) {
        seen.add(c.teamIdx);
        living.push(c.teamIdx);
      }
    }
    return living;
  }

  function checkVictory(s) {
    const living = getLivingTeams(s.chars);
    if (living.length <= 1) return endBattle(s, living.length === 1 ? living[0] : null);
    return null;
  }

  function endByTimeLimit(s) {
    const teamHp = {};
    s.chars.forEach(c => {
      teamHp[c.teamIdx] = (teamHp[c.teamIdx] || 0) + Core.getHpCurrent(c.hpSlots);
    });
    s.log.push(`規定ラウンド終了。残生命力: ${s.chars.map(c => c.name + ' ' + Core.getHpCurrent(c.hpSlots)).join(' / ')}`);
    let maxHp = -1, winnerTeamIdx = null, tie = false;
    for (const [ti, hp] of Object.entries(teamHp)) {
      const t = Number(ti);
      if (hp > maxHp) { maxHp = hp; winnerTeamIdx = t; tie = false; }
      else if (hp === maxHp) { tie = true; }
    }
    return endBattle(s, tie ? null : winnerTeamIdx);
  }

  function resultLabel(r) {
    if (r.isFumble)  return 'ファンブル！';
    if (r.isSpecial) return 'スペシャル！';
    return r.success ? '成功' : '失敗';
  }

  /**
   * ダメージヒットを順番に適用する。
   * 選択が必要な場合は phase=DAMAGE_CHOICE にして早期リターン。
   * s は呼び出し前にクローン済みであること。
   */
  function applyDamageHits(s, defIdx, damageType, numHits, atkIdx, rng) {
    for (let h = 0; h < numHits; h++) {
      if (isCharDefeated(s.chars[defIdx])) return s;

      if (damageType === 'melee') {
        const r = Core.applyMeleeHit(s.chars[defIdx].hpSlots, rng);
        if (r.needsChoice) {
          s.phase = PHASES.DAMAGE_CHOICE;
          s.pendingDamageChoice = {
            defIdx, atkIdx, damageType: 'melee',
            randomField: r.randomField,
            availableFields: r.availableFields,
            remainingHits: numHits - h - 1,
          };
          s.log.push(`  ↪ ${s.chars[defIdx].name}：${r.randomField} のスロットが埋まっています。受けるスロットを選択してください`);
          return s;
        }
        s.log.push(`  ↪ ${s.chars[defIdx].name}：${r.damagedField} に接近戦ダメージ`);

      } else if (damageType === 'ranged') {
        const avail = s.chars[defIdx].hpSlots.filter(sl => !sl.damaged).map(sl => sl.field);
        if (avail.length === 0) return s;
        s.phase = PHASES.DAMAGE_CHOICE;
        s.pendingDamageChoice = {
          defIdx, atkIdx, damageType: 'ranged',
          randomField: null,
          availableFields: avail,
          remainingHits: numHits - h - 1,
        };
        s.log.push(`  ↪ ${s.chars[defIdx].name}：射撃戦ダメージ。受けるスロットを選択してください`);
        return s;
      }
    }
    return s;
  }

  /**
   * 変調付与時の副作用処理（マヒ→ブロック分野選択、呪い→ブロック忍法選択 等）
   */
  function applyConditionSideEffect(s, charIdx, condition, ninjutsuData, rng) {
    const c = s.chars[charIdx];

    // 霞身による免疫チェック
    if (c.immuneConditions.includes(condition)) {
      const idx = c.conditions.lastIndexOf(condition);
      if (idx >= 0) c.conditions.splice(idx, 1);
      s.log.push(`  （${c.name} は${condition}免疫：無効）`);
      return;
    }

    switch (condition) {
      case 'マヒ':
        if (!c.mahiBlockedField) {
          const fi = (Core.roll1d6(rng) - 1);  // 0-5
          c.mahiBlockedField = Core.FIELDS[fi];
          s.log.push(`  → マヒ: ${c.name} の「${c.mahiBlockedField}」分野の特技が使用不可に`);
        }
        break;
      case '呪い':
        if (!c.noroiBlockedNinjutsuId) {
          const usable = c.ninjutsuIds.filter(id => {
            const n = ninjutsuData.find(x => x.id === id);
            return n && n.battle_usable !== false;
          });
          if (usable.length > 0) {
            const fi = (Core.roll1d6(rng) - 1) % usable.length;
            c.noroiBlockedNinjutsuId = usable[fi];
            const blockedNin = ninjutsuData.find(x => x.id === c.noroiBlockedNinjutsuId);
            s.log.push(`  → 呪い: ${c.name} の「${blockedNin?.name}」が使用不可に`);
          }
        }
        break;
      case '行方不明':
        s.log.push(`  → ${c.name} が行方不明に！（脱落扱い）`);
        break;
      default:
        break;
    }
  }

  function _advanceAction(s) {
    for (let i = s.currentActionIdx + 1; i < s.actionOrder.length; i++) {
      const ci = s.actionOrder[i];
      if (!s.chars[ci].acted && !isCharDefeated(s.chars[ci])) {
        s.currentActionIdx = i;
        return s;
      }
    }
    // 全員行動済み → ラウンド終了
    s.phase = PHASES.ROUND_END;
    s.log.push(`[ラウンド ${s.round} 終了]`);
    return s;
  }

  // ===== initBattle =====

  /**
   * 戦闘を初期化して初期ステートを返す。
   * @param {Object[]} charSheets  - LoadCharacters() で得たキャラクターデータ（各自 teamIdx を持つこと）
   * @param {string|null} battlefieldId  - null = 平地
   * @param {Object[]} skillsData
   * @param {Object[]} ninjutsuData
   * @param {Function|null} rng
   * @param {Object[]|null} teams  - [{ idx, name }, ...] 省略時はcharSheetsから自動生成
   * @returns {Object} battle state
   */
  function initBattle(charSheets, battlefieldId, skillsData, ninjutsuData, rng, teams) {
    const battlefield = battlefieldId
      ? Core.getBattlefieldById(battlefieldId)
      : Core.BATTLEFIELDS[0];

    const chars = charSheets.map((c, i) => {
      const ninNames = (c.ninjutsuIds || [])
        .map(id => ninjutsuData.find(n => n.id === id)?.name)
        .filter(Boolean);
      return {
        charId:    c.id,
        name:      c.name,
        factionId: c.factionId,
        factionName: c.factionName,
        favoredFieldIndex: c.favoredFieldIndex,
        skillNames:  [...(c.skillNames  || [])],
        ninjutsuIds: [...(c.ninjutsuIds || [])],
        hpSlots:     Core.createHpSlots(ninNames),
        conditions:  [],
        immuneConditions: [...(c.immuneConditions || [])],
        mahiBlockedField:     null,
        noroiBlockedNinjutsuId: null,
        sakanagi:  false,
        plotValue: null,
        acted:     false,
        teamIdx:   c.teamIdx ?? i,
      };
    });

    // teamsが指定されていない場合はcharから自動生成
    if (!teams) {
      const teamMap = {};
      chars.forEach(c => {
        if (!teamMap[c.teamIdx]) teamMap[c.teamIdx] = { idx: c.teamIdx, name: `チーム${c.teamIdx}` };
      });
      teams = Object.values(teamMap);
    }

    const maxRounds = 10;

    return {
      phase:    PHASES.PLOT,
      round:    1,
      maxRounds,
      battlefield,
      chars,
      teams,
      actionOrder:       [],
      currentActionIdx:  0,
      pendingDamageChoice: null,
      winnerTeamIdx: null,
      lastDiceEvents: [],
      log: [`=== 第1ラウンド開始 === 戦場: ${battlefield.name}`],
    };
  }

  // ===== choosePlot =====

  /**
   * charIdx のキャラがプロット値 value を選択する。
   * 全員が選択済みになると行動フェーズに移行する。
   */
  function choosePlot(state, charIdx, value) {
    if (state.phase !== PHASES.PLOT)    return state;
    if (value < 1 || value > 6)         return state;

    const s = cloneState(state);
    s.chars[charIdx].plotValue = value;

    if (!s.chars.every(c => c.plotValue !== null)) return s; // まだ全員揃っていない

    const plotLog = s.chars.map(c => `${c.name}: ${c.plotValue}`).join('　');
    s.log.push(`[プロット公開] ${plotLog}`);

    // 高プロット順（同値は charIdx の小さい方が先）
    s.actionOrder = s.chars
      .map((c, i) => ({ i, p: c.plotValue }))
      .sort((a, b) => b.p - a.p || a.i - b.i)
      .map(x => x.i);

    s.phase = PHASES.ACTION;
    s.currentActionIdx = 0;
    s.chars.forEach(c => { c.acted = false; });

    return s;
  }

  // ===== getAvailableNinjutsu =====

  /**
   * 現在の行動者が使用可能な忍法一覧を返す。
   * @returns {{ id, name, ninjutsu, canUse, reason, availableTargetIdxs }[]}
   */
  function getAvailableNinjutsu(state, skillsData, ninjutsuData) {
    if (state.phase !== PHASES.ACTION) return [];
    const actorIdx = state.actionOrder[state.currentActionIdx];
    if (actorIdx === undefined) return [];
    const actor    = state.chars[actorIdx];
    const mods     = Core.getBattlefieldModifiers(state.battlefield);

    // 敵キャラインデックス一覧（別チーム・生存者）
    const enemyIdxs = state.chars
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => i !== actorIdx && c.teamIdx !== actor.teamIdx && !isCharDefeated(c))
      .map(({ i }) => i);

    return actor.ninjutsuIds.map(id => {
      const nin = ninjutsuData.find(n => n.id === id);
      if (!nin) return { id, name: '?', canUse: false, reason: 'データなし', availableTargetIdxs: [] };

      if (nin.battle_usable === false)
        return { id, name: nin.name, ninjutsu: nin, canUse: false, reason: '戦闘中使用不可', availableTargetIdxs: [] };

      if ((nin.cost || 0) > (actor.plotValue || 0))
        return { id, name: nin.name, ninjutsu: nin, canUse: false,
                 reason: `コスト不足（C${nin.cost}、プロット${actor.plotValue}）`, availableTargetIdxs: [] };

      if (actor.conditions.includes('敗走') && nin.type === 'equip')
        return { id, name: nin.name, ninjutsu: nin, canUse: false, reason: '敗走（忍具使用不可）', availableTargetIdxs: [] };

      if (actor.mahiBlockedField && nin.skill) {
        const skillEntry = skillsData.find(s => s.name === nin.skill);
        if (skillEntry && skillEntry.field === actor.mahiBlockedField)
          return { id, name: nin.name, ninjutsu: nin, canUse: false,
                   reason: `マヒ（${actor.mahiBlockedField}の特技が使用不可）`, availableTargetIdxs: [] };
      }

      if (actor.noroiBlockedNinjutsuId === id)
        return { id, name: nin.name, ninjutsu: nin, canUse: false, reason: '呪い（この忍法が使用不可）', availableTargetIdxs: [] };

      const effectiveRange = (nin.range != null ? nin.range : 99) + (mods.rangeBonus || 0);
      const availableTargetIdxs = enemyIdxs.filter(ti =>
        Core.isInRange(actor.plotValue || 0, state.chars[ti].plotValue || 0, effectiveRange, 0)
      );

      if (nin.type === 'attack' && availableTargetIdxs.length === 0)
        return { id, name: nin.name, ninjutsu: nin, canUse: false,
                 reason: `間合外（有効な対象なし）`, availableTargetIdxs: [] };

      return { id, name: nin.name, ninjutsu: nin, canUse: true, reason: null, availableTargetIdxs };
    });
  }

  // ===== chooseAction =====

  /**
   * 現在の行動者が忍法を使用する（または null でパス）。
   * @param {string|null} ninjutsuId
   * @param {number|null} targetIdx  - 攻撃対象の chars インデックス（パス時は null）
   */
  function chooseAction(state, ninjutsuId, targetIdx, skillsData, ninjutsuData, rng) {
    if (state.phase !== PHASES.ACTION) return state;

    const s       = cloneState(state);
    const actorIdx = s.actionOrder[s.currentActionIdx];
    const actor    = s.chars[actorIdx];
    const mods     = Core.getBattlefieldModifiers(s.battlefield);

    if (ninjutsuId === null) {
      s.log.push(`[${actor.name}] パス`);
    } else {
      const defIdx   = targetIdx;
      const defender = s.chars[defIdx];
      const nin = ninjutsuData.find(n => n.id === ninjutsuId);
      if (!nin) return state;

      s.lastDiceEvents = [];
      const skillNote = nin.skill ? `（指定特技: ${nin.skill}）` : '';
      s.log.push(`[${actor.name}] ${nin.name}${skillNote} → ${defender.name}`);

      // ===== 命中判定 =====
      const atkTV    = Core.calcTargetValue(actor.skillNames, nin.skill, actor.favoredFieldIndex, skillsData);
      const fumbleMod = mods.fumbleValueModifier || 0;
      const atkPlot  = (actor.plotValue || 0) + fumbleMod;
      const atkRoll  = Core.roll2d6(rng);
      const atkResult = Core.resolveCheck({ roll: atkRoll, targetValue: atkTV, plotValue: atkPlot, isSakanagi: actor.sakanagi });

      s.log.push(`  命中判定: ${atkRoll.total}（TV${atkTV}）→ ${resultLabel(atkResult)}`);
      s.lastDiceEvents.push({
        label: '命中判定',
        d1: atkRoll.d1, d2: atkRoll.d2, total: atkRoll.total,
        verdict:    atkResult.isSpecial ? '🌟 スペシャル！' : atkResult.isFumble ? '💀 ファンブル！' : atkResult.success ? '⚔️ 命中！' : '✗ 失敗',
        verdictCls: atkResult.isSpecial ? 'special'         : atkResult.isFumble ? 'fumble'         : atkResult.success ? 'hit'      : 'miss',
      });

      if (atkResult.isFumble) {
        s.chars[actorIdx].sakanagi = true;
        s.log.push(`  → ${actor.name} 逆凪状態に！`);
        if (Core.shouldApplyKoshoFumbleDamage(s.battlefield, atkResult)) {
          const r = Core.applyMeleeHit(s.chars[actorIdx].hpSlots, rng);
          const f = r.damagedField || r.randomField;
          if (r.needsChoice) Core.completeMeleeHitChoice(s.chars[actorIdx].hpSlots, r.randomField);
          s.log.push(`  → 高所ファンブル: ${actor.name} が ${f} に接近戦ダメージ`);
        }
      }
      if (atkResult.isSpecial && recoverOneHp(s.chars[actorIdx].hpSlots)) {
        s.log.push(`  → ${actor.name} スペシャル！生命力1点回復`);
      }

      if (atkResult.success) {
        // ===== 回避判定 =====
        const defTV   = Core.calcTargetValue(defender.skillNames, nin.skill, defender.favoredFieldIndex, skillsData);
        const defPlot = (defender.plotValue || 0) + fumbleMod;
        const defMod  = mods.dodgeModifier || 0;
        const defRoll = Core.roll2d6(rng);
        const defResult = Core.resolveCheck({ roll: defRoll, targetValue: defTV, plotValue: defPlot, isSakanagi: defender.sakanagi, modifier: defMod });

        const modNote = defMod ? `、修正${defMod}` : '';
        s.log.push(`  回避判定（${defender.name}）: ${defRoll.total}（TV${defTV}${modNote}）→ ${resultLabel(defResult)}`);
        s.lastDiceEvents.push({
          label: `回避判定（${defender.name}）`,
          d1: defRoll.d1, d2: defRoll.d2, total: defRoll.total,
          verdict:    defResult.isSpecial ? '🌟 スペシャル！' : defResult.isFumble ? '💀 ファンブル！' : defResult.success ? '✗ 回避！' : '⚔️ 命中！',
          verdictCls: defResult.isSpecial ? 'special'         : defResult.isFumble ? 'fumble'         : defResult.success ? 'miss'    : 'hit',
        });

        if (defResult.isFumble) {
          s.chars[defIdx].sakanagi = true;
          s.log.push(`  → ${defender.name} 逆凪状態に！`);
          if (Core.shouldApplyKoshoFumbleDamage(s.battlefield, defResult)) {
            const r = Core.applyMeleeHit(s.chars[defIdx].hpSlots, rng);
            const f = r.damagedField || r.randomField;
            if (r.needsChoice) Core.completeMeleeHitChoice(s.chars[defIdx].hpSlots, r.randomField);
            s.log.push(`  → 高所ファンブル: ${defender.name} が ${f} に接近戦ダメージ`);
          }
        }
        if (defResult.isSpecial && recoverOneHp(s.chars[defIdx].hpSlots)) {
          s.log.push(`  → ${defender.name} スペシャル！生命力1点回復`);
        }

        if (!defResult.success) {
          // ===== ダメージ処理 =====
          const damage    = nin.damage || 0;
          const dmgType   = nin.damage_type;
          const jyusho    = s.chars[defIdx].conditions.filter(c => c === '重傷').length;

          if (dmgType === 'melee') {
            const totalHits = damage + jyusho;
            applyDamageHits(s, defIdx, 'melee', totalHits, actorIdx, rng);
            if (s.phase === PHASES.DAMAGE_CHOICE) return s;

          } else if (dmgType === 'ranged') {
            applyDamageHits(s, defIdx, 'ranged', damage, actorIdx, rng);
            if (s.phase === PHASES.DAMAGE_CHOICE) return s;

          } else if (dmgType === 'group') {
            for (let h = 0; h < damage; h++) {
              const gr = Core.applyGroupDamage(s.chars[defIdx].conditions, rng);
              if (gr.applied) {
                applyConditionSideEffect(s, defIdx, gr.condition, ninjutsuData, rng);
                s.log.push(`  ↪ ${s.chars[defIdx].name}：変調「${gr.condition}」`);
              } else {
                s.log.push(`  ↪ ${s.chars[defIdx].name}：変調は累積不可（無効）`);
              }
            }
          } else if (damage > 0) {
            // damage_type 未定義だが damage > 0 の場合は接近戦扱い（フォールバック）
            applyDamageHits(s, defIdx, 'melee', damage, actorIdx, rng);
            if (s.phase === PHASES.DAMAGE_CHOICE) return s;
          } else {
            // 特殊効果（効果テキストのみ表示）
            if (nin.effect) s.log.push(`  効果: ${nin.effect.slice(0, 80)}…`);
          }
        }
      }
    }

    // ===== 脱落チェック（N人対応）=====
    const victoryResult = checkVictory(s);
    if (victoryResult) return victoryResult;

    s.chars[actorIdx].acted = true;
    return _advanceAction(s);
  }

  // ===== resolveDamageChoice =====

  /**
   * ダメージを受ける分野を選択して確定する（phase === DAMAGE_CHOICE のとき）。
   * @param {string} field - 選択した分野名（ranged: 任意, melee: availableFields 内）
   */
  function resolveDamageChoice(state, field, rng) {
    if (state.phase !== PHASES.DAMAGE_CHOICE || !state.pendingDamageChoice) return state;

    const s = cloneState(state);
    const { defIdx, atkIdx, damageType, remainingHits } = s.pendingDamageChoice;

    if (damageType === 'melee') {
      Core.completeMeleeHitChoice(s.chars[defIdx].hpSlots, field);
      s.log.push(`  ↪ ${s.chars[defIdx].name}：${field} に接近戦ダメージ（選択）`);
    } else {
      Core.applyRangedHit(s.chars[defIdx].hpSlots, field);
      s.log.push(`  ↪ ${s.chars[defIdx].name}：${field} に射撃戦ダメージ`);
    }

    s.pendingDamageChoice = null;
    s.phase = PHASES.ACTION;

    if (isCharDefeated(s.chars[defIdx])) {
      s.log.push(`${s.chars[defIdx].name} が脱落！`);
      s.chars[atkIdx].acted = true;
      return checkVictory(s) || _advanceAction(s);
    }

    if (remainingHits > 0) {
      applyDamageHits(s, defIdx, damageType, remainingHits, atkIdx, rng);
      if (s.phase === PHASES.DAMAGE_CHOICE) return s;

      if (isCharDefeated(s.chars[defIdx])) {
        s.log.push(`${s.chars[defIdx].name} が脱落！`);
        s.chars[atkIdx].acted = true;
        return checkVictory(s) || _advanceAction(s);
      }
    }

    s.chars[atkIdx].acted = true;
    return _advanceAction(s);
  }

  // ===== advanceRoundEnd =====

  /**
   * ラウンド終了処理を実行し、次のラウンドへ進める。
   * phase === ROUND_END のときに呼ぶ。
   */
  function advanceRoundEnd(state, rng) {
    if (state.phase !== PHASES.ROUND_END) return state;

    const s = cloneState(state);

    // 極地チェック
    if (s.battlefield.id === 'kyokuchi') {
      const kyRes = Core.resolveKyokuchiRoundEnd(s.round, rng);
      if (kyRes.triggered) {
        s.log.push(`[極地] 出目${kyRes.roll}（${s.round}以下）→ 全員に接近戦ダメージ`);
        for (let i = 0; i < s.chars.length; i++) {
          if (isCharDefeated(s.chars[i])) continue;
          const r = Core.applyMeleeHit(s.chars[i].hpSlots, rng);
          const f = r.damagedField || r.randomField;
          if (r.needsChoice) Core.completeMeleeHitChoice(s.chars[i].hpSlots, r.randomField);
          s.log.push(`  ↪ ${s.chars[i].name}：${f} に接近戦ダメージ`);
        }
      }
    }

    // 脱落チェック（N人対応）
    let anyDefeated = false;
    for (let i = 0; i < s.chars.length; i++) {
      if (isCharDefeated(s.chars[i])) {
        s.log.push(`${s.chars[i].name} が脱落！`);
        anyDefeated = true;
      }
    }
    if (anyDefeated) {
      const victoryResult = checkVictory(s);
      if (victoryResult) return victoryResult;
    }

    // 逆凪リセット・次ラウンド準備
    s.chars.forEach(c => {
      c.sakanagi  = false;
      c.acted     = false;
      c.plotValue = null;
    });

    const next = s.round + 1;
    if (next > s.maxRounds) return endByTimeLimit(s);

    s.round = next;
    s.phase = PHASES.PLOT;
    s.log.push(`=== 第${next}ラウンド開始 ===`);
    return s;
  }

  // ===== エクスポート =====

  return {
    PHASES,
    initBattle,
    choosePlot,
    getAvailableNinjutsu,
    chooseAction,
    resolveDamageChoice,
    advanceRoundEnd,
    /** 現在の行動者の chars インデックスを返す */
    getCurrentActorIdx: state => state.actionOrder[state.currentActionIdx],
    isCharDefeated,
    cloneState,
  };
});
