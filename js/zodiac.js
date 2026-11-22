/**
 * 十二生肖：文字 → 生肖。
 *
 * 只认这 12 个（及其常见别名），其他任何文字都不生效 —— 这是产品要求：
 * 「文字定制手势」的输入范围就是十二生肖，免得用户随便写一句也能变形。
 *
 * 形状用 emoji 字形取 alpha 采样（跨平台都能渲染），
 * 取不到再退回汉字字形，保证不会空手。
 */

export const ZODIAC = [
  { name: '鼠', emoji: '🐭', aliases: ['鼠', '老鼠', '子鼠', 'rat'] },
  { name: '牛', emoji: '🐮', aliases: ['牛', '丑牛', 'ox'] },
  { name: '虎', emoji: '🐯', aliases: ['虎', '老虎', '寅虎', 'tiger'] },
  { name: '兔', emoji: '🐰', aliases: ['兔', '兔子', '卯兔', 'rabbit'] },
  { name: '龙', emoji: '🐲', aliases: ['龙', '龍', '辰龙', 'dragon'] },
  { name: '蛇', emoji: '🐍', aliases: ['蛇', '巳蛇', 'snake'] },
  { name: '马', emoji: '🐴', aliases: ['马', '馬', '午马', 'horse'] },
  { name: '羊', emoji: '🐐', aliases: ['羊', '山羊', '未羊', 'goat'] },
  { name: '猴', emoji: '🐵', aliases: ['猴', '猴子', '申猴', 'monkey'] },
  { name: '鸡', emoji: '🐔', aliases: ['鸡', '雞', '公鸡', '酉鸡', 'rooster'] },
  { name: '狗', emoji: '🐶', aliases: ['狗', '小狗', '戌狗', 'dog'] },
  { name: '猪', emoji: '🐷', aliases: ['猪', '豬', '亥猪', 'pig'] },
];

/** @returns {number} 命中的生肖下标；不是十二生肖就返回 -1 */
export function zodiacIndexOf(text) {
  const raw = String(text || '').trim();
  if (!raw) return -1;
  // 完全相等的优先，避免「马」命中「马上」这种长句
  for (let i = 0; i < ZODIAC.length; i++) {
    const z = ZODIAC[i];
    if (z.name === raw) return i;
    if (z.aliases.some((a) => a === raw)) return i;
  }
  // 再退一步：包含别名（「可爱的小老虎」→ 虎），但限制长度，别让整句都算
  if (raw.length <= 6) {
    for (let i = 0; i < ZODIAC.length; i++) {
      if (ZODIAC[i].aliases.some((a) => raw.includes(a))) return i;
    }
  }
  return -1;
}

export function zodiacName(index) {
  return ZODIAC[index]?.name ?? '';
}

export function zodiacEmoji(index) {
  return ZODIAC[index]?.emoji ?? '';
}