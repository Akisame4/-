/**
 * 忍戦 キャラクター作成・管理ロジック
 * UIなし。ブラウザ・Node.js 両対応（UMD）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NinjaBattleCharacter = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const STORAGE_KEY = 'ninjaSen_characters';
  let _storage = (typeof localStorage !== 'undefined') ? localStorage : null;

  /** テスト時にモックストレージを注入する */
  function setStorage(impl) { _storage = impl; }

  // ===== バリデーション（設計書 2.1.1 / 2.3） =====

  /**
   * 特技選択を検証する。
   * @param {string}   factionId
   * @param {string[]} skillNames    - 選択した特技名リスト（6つ想定）
   * @param {Object[]} factionsData
   * @param {Object[]} skillsData
   * @returns {{ valid, errors }}
   */
  function validateSkills(factionId, skillNames, factionsData, skillsData) {
    const errors = [];

    if (skillNames.length !== 6) {
      errors.push(`特技は6つ選択してください（現在 ${skillNames.length} つ）`);
    }

    if (new Set(skillNames).size !== skillNames.length) {
      errors.push('同じ特技を複数選択することはできません');
    }

    const validNames = new Set(skillsData.map(s => s.name));
    const invalid = skillNames.filter(n => !validNames.has(n));
    if (invalid.length > 0) {
      errors.push('無効な特技: ' + invalid.join('、'));
    }

    const faction = factionsData.find(f => f.id === factionId);
    if (faction) {
      const favoredSet = new Set(
        skillsData.filter(s => s.field === faction.favored_field).map(s => s.name)
      );
      const favoredCount = skillNames.filter(n => favoredSet.has(n)).length;
      if (favoredCount < 3) {
        errors.push(`得意分野「${faction.favored_field}」から3つ以上選択してください（現在 ${favoredCount} つ）`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 忍法選択を検証する。
   * @param {string}   factionId
   * @param {string[]} ninjutsuIds   - 選択した忍法IDリスト（4〜6個想定）
   * @param {Object[]} ninjutsuData
   * @param {Object[]} factionsData
   * @returns {{ valid, errors }}
   */
  function validateNinjutsu(factionId, ninjutsuIds, ninjutsuData, factionsData) {
    const errors = [];
    const faction = factionsData.find(f => f.id === factionId);

    if (ninjutsuIds.length < 4 || ninjutsuIds.length > 6) {
      errors.push(`忍法は4〜6個選択してください（現在 ${ninjutsuIds.length} 個）`);
    }

    const ninMap = new Map(ninjutsuData.map(n => [n.id, n]));
    const invalidIds = ninjutsuIds.filter(id => !ninMap.has(id));
    if (invalidIds.length > 0) {
      errors.push('無効な忍法ID: ' + invalidIds.join('、'));
    }

    const selected = ninjutsuIds.map(id => ninMap.get(id)).filter(Boolean);

    if (faction) {
      const otherFactionNin = selected.filter(
        n => n.availability === 'faction' && n.faction !== faction.name
      );
      if (otherFactionNin.length > 0) {
        errors.push('他の流派の流派忍法は習得できません: ' + otherFactionNin.map(n => n.name).join('、'));
      }

      const hasFactionNin = selected.some(
        n => n.availability === 'faction' && n.faction === faction.name
      );
      if (!hasFactionNin && ninjutsuIds.length > 0) {
        errors.push(`${faction.name}の流派忍法を最低1つ習得してください`);
      }
    }

    // ※マークなし忍法の重複チェック
    const countByName = {};
    selected.forEach(n => { countByName[n.name] = (countByName[n.name] || 0) + 1; });
    const dupes = Object.entries(countByName)
      .filter(([name, cnt]) => cnt > 1 && !selected.find(n => n.name === name)?.multiple)
      .map(([name]) => name);
    if (dupes.length > 0) {
      errors.push('複数修得不可の忍法が重複しています: ' + dupes.join('、'));
    }

    return { valid: errors.length === 0, errors };
  }

  // ===== キャラクター作成 =====

  /**
   * 頑健の修得数に応じてHP最大値を計算する（設計書 3.8）。
   * @param {string[]} ninjutsuNames - 修得忍法名リスト
   * @returns {number}
   */
  function calcHpMax(ninjutsuNames) {
    const gankenCount = ninjutsuNames.filter(n => n === '頑健').length;
    let hp = 6;
    if (gankenCount >= 1) hp += 2;
    for (let i = 1; i < gankenCount; i++) hp += 1;
    return hp;
  }

  /**
   * キャラクターを作成する（バリデーション込み）。
   * @param {{ id?, name, factionId, skillNames, ninjutsuIds }} params
   *   id: 省略時は新規生成。編集時は既存IDを渡す。
   * @param {{ factionsData, skillsData, ninjutsuData }} masterData
   * @returns {{ success, character?, errors }}
   */
  function createCharacter(
    { id, name, factionId, skillNames, ninjutsuIds },
    { factionsData, skillsData, ninjutsuData }
  ) {
    const errors = [];

    if (!name || !name.trim()) errors.push('キャラクター名を入力してください');
    if (!factionId) errors.push('流派を選択してください');

    const skillResult = validateSkills(factionId, skillNames, factionsData, skillsData);
    errors.push(...skillResult.errors);

    const ninResult = validateNinjutsu(factionId, ninjutsuIds, ninjutsuData, factionsData);
    errors.push(...ninResult.errors);

    if (errors.length > 0) return { success: false, errors };

    const faction = factionsData.find(f => f.id === factionId);
    const ninNames = ninjutsuIds
      .map(nid => ninjutsuData.find(n => n.id === nid)?.name)
      .filter(Boolean);

    const character = {
      id: id || generateId(),
      name: name.trim(),
      factionId,
      factionName: faction.name,
      favoredFieldIndex: faction.favored_field_index,
      skillNames: [...skillNames],
      ninjutsuIds: [...ninjutsuIds],
      hpMax: calcHpMax(ninNames),
      immuneConditions: [], // 霞身の選択はUI側で別途設定
      createdAt: new Date().toISOString(),
    };

    return { success: true, character };
  }

  function generateId() {
    return 'char_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  // ===== ストレージ =====

  function saveCharacter(character) {
    if (!_storage) return { success: false, error: 'ストレージ未対応' };
    const all = loadCharacters();
    const idx = all.findIndex(c => c.id === character.id);
    if (idx >= 0) all[idx] = character; else all.push(character);
    try {
      _storage.setItem(STORAGE_KEY, JSON.stringify(all));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function loadCharacters() {
    if (!_storage) return [];
    try {
      const raw = _storage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function deleteCharacter(id) {
    if (!_storage) return { success: false, error: 'ストレージ未対応' };
    try {
      _storage.setItem(STORAGE_KEY, JSON.stringify(loadCharacters().filter(c => c.id !== id)));
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  }

  function getCharacterById(id) {
    return loadCharacters().find(c => c.id === id) || null;
  }

  // ===== エクスポート =====

  return {
    validateSkills,
    validateNinjutsu,
    createCharacter,
    calcHpMax,
    saveCharacter,
    loadCharacters,
    deleteCharacter,
    getCharacterById,
    setStorage,
  };
});
