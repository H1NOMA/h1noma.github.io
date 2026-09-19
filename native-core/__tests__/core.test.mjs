// КОМИК · core — самодостаточные тесты (node --test не нужен; чистый node, без зависимостей).
// Запуск:  node native-core/__tests__/core.test.mjs
import assert from 'node:assert';
import {
  abilityMod, abilityModStr, proficiencyBonus, saveValue, skillValue, pointBuyTotal,
  rollPool, cantripsKnownFor, knownSpellsMaxFor, multiclassCasterLevel, multiclassSlots,
  deathSaveStep, canRollDeathSave, deriveSheet, themeFor, DEFAULT_PROJECT,
} from '../index.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log('abilities');
test('модификатор характеристики', () => {
  assert.equal(abilityMod(10), 0);
  assert.equal(abilityMod(14), 2);
  assert.equal(abilityMod(7), -2);
  assert.equal(abilityModStr(18), '+4');
  assert.equal(abilityModStr('нет'), '');
});
test('бонус мастерства по уровню', () => {
  assert.equal(proficiencyBonus(1), 2);
  assert.equal(proficiencyBonus(4), 2);
  assert.equal(proficiencyBonus(5), 3);
  assert.equal(proficiencyBonus(20), 6);
});
test('спасброски и навыки', () => {
  assert.equal(saveValue(16, true, 3), 6);   // +3 мод + 3 бонус
  assert.equal(saveValue(16, false, 3), 3);
  assert.equal(skillValue(14, 2, 3), 8);     // +2 мод + двойной бонус
  assert.equal(skillValue(14, 0, 3), 2);
});
test('покупка очков', () => {
  assert.equal(pointBuyTotal([15, 15, 15, 8, 8, 8]), 27);   // классический 27-очковый набор
  assert.equal(pointBuyTotal([16]), null);                  // вне диапазона
});

console.log('dice (детерминированный rng)');
test('пул кубов считается верно', () => {
  const rng = () => 0.5;                       // всегда середина → d20→11, d6→4
  const r = rollPool({ 20: 1, 6: 2 }, rng);
  assert.equal(r.total, 11 + 4 + 4);
  assert.equal(r.crit, false);
});
test('крит на d20', () => {
  const r = rollPool({ 20: 1 }, () => 0.999);  // → 20
  assert.equal(r.crit, true);
});

console.log('spellcasting');
test('заговоры и известные', () => {
  assert.equal(cantripsKnownFor('Бард', 1), 2);
  assert.equal(cantripsKnownFor('Бард', 4), 3);
  assert.equal(cantripsKnownFor('Бард', 10), 4);
  assert.equal(knownSpellsMaxFor('Бард', 5), 8);       // по таблице
  assert.equal(knownSpellsMaxFor('Волшебник', 3), 10); // 6 + 2*(3-1)
});
test('совокупный уровень мультикласса и ячейки', () => {
  // Волшебник 5 (полный) + Паладин 4 (полу → 2) = 7
  const lvl = multiclassCasterLevel([{ cls: 'Волшебник', level: 5 }, { cls: 'Паладин', level: 4 }]);
  assert.equal(lvl, 7);
  assert.deepEqual(multiclassSlots(7), [4, 3, 3, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(multiclassSlots(20), [4, 3, 3, 3, 3, 2, 2, 1, 1]);
  // трети-каст: Воин 6 (Мистический рыцарь) = floor(6/3)=2
  assert.equal(multiclassCasterLevel([{ cls: 'Воин', level: 6, third: true }]), 2);
});

console.log('deathSaves');
test('успех/провал/крит/единица', () => {
  assert.equal(deathSaveStep({ s: 0, f: 0 }, 12).s, 1);
  assert.equal(deathSaveStep({ s: 0, f: 0 }, 8).f, 1);
  assert.equal(deathSaveStep({ s: 0, f: 0 }, 1).f, 2);
  const crit = deathSaveStep({ s: 1, f: 0 }, 20);
  assert.equal(crit.stabilized, true);
  assert.equal(crit.hp, 1);
  assert.equal(crit.ds, null);
  const dead = deathSaveStep({ s: 0, f: 2 }, 3);
  assert.equal(dead.dead, true);
});
test('можно ли бросать', () => {
  assert.equal(canRollDeathSave(0, { s: 0, f: 0 }), true);
  assert.equal(canRollDeathSave(5, { s: 0, f: 0 }), false);   // жив
  assert.equal(canRollDeathSave(0, { s: 3, f: 0 }), false);   // стабилен
});

console.log('character.deriveSheet');
test('полный лист считается', () => {
  const sheet = deriveSheet({
    level: 5, abil: { str: 16, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
    saves: { str: true, con: true }, skills: { 'Атлетика': 1, 'Запугивание': 2 },
    hp: '42 (макс)', spellcasting: { cls: ['Бард'], lvls: { 'Бард': 5 } },
  });
  assert.equal(sheet.pb, 3);                       // 5 уровень
  assert.equal(sheet.maxHp, 42);
  assert.equal(sheet.mods.str, 3);
  const atl = sheet.skills.find(s => s.name === 'Атлетика');
  assert.equal(atl.value, 6);                      // +3 мод + 3 бонус
  const intim = sheet.skills.find(s => s.name === 'Запугивание');
  assert.equal(intim.value, 5);                    // -1 мод (ХАР 8) + 2*3 бонус = 5
  assert.ok(sheet.spells && sheet.spells.cantripMax === 3);
});

console.log('settings');
test('токены темы и стартовый сеттинг', () => {
  assert.equal(DEFAULT_PROJECT, 'classic');
  assert.equal(themeFor('classic').accent, '#d3a84a');
  assert.equal(themeFor('нет-такого').accent, themeFor('assimilation').accent);  // фолбэк
});

console.log(`\nВсе тесты пройдены: ${passed} блоков.`);
