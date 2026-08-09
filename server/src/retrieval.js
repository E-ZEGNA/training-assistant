const STOP_WORDS = new Set(['我们', '这个', '那个', '然后', '就是', '可以', '一个', '以及', '进行', '相关', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are']);

export function chunkMasterPack(text, maxChars = 1200) {
  const blocks = text.split(/\n{2,}|(?=^#{1,4}\s)/m).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  for (const block of blocks) {
    if (block.length <= maxChars) {
      chunks.push(block);
      continue;
    }
    for (let offset = 0; offset < block.length; offset += maxChars - 150) {
      chunks.push(block.slice(offset, offset + maxChars));
    }
  }
  return chunks;
}

export function tokenize(text) {
  const latin = text.toLowerCase().match(/[a-z][a-z0-9._+#/-]{1,}/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fff]{2,8}/g) ?? [];
  const tokens = [];
  for (const value of [...latin, ...chinese]) {
    if (!STOP_WORDS.has(value)) tokens.push(value);
    if (/^[\u4e00-\u9fff]+$/.test(value) && value.length >= 4) {
      for (let index = 0; index <= value.length - 2; index += 1) tokens.push(value.slice(index, index + 2));
    }
  }
  return tokens;
}

export function retrieveChunks(masterText, query, limit = 4) {
  const queryTokens = new Set(tokenize(query));
  const chunks = chunkMasterPack(masterText);
  return chunks
    .map((text, index) => {
      const frequencies = new Map();
      for (const token of tokenize(text)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const count = frequencies.get(token) ?? 0;
        if (count) score += (1 + Math.log(count)) * Math.log(2 + chunks.length);
      }
      return { text, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ text }) => text);
}

export function buildHotwords(masterText, supplement, maxTerms = 60, tokenBudget = 90) {
  const candidates = [];
  const source = `${supplement}\n${masterText}`;
  for (const match of source.matchAll(/[A-Za-z][A-Za-z0-9._+#/-]{2,30}|[\u4e00-\u9fff]{2,8}/g)) {
    const term = match[0].trim();
    if (!STOP_WORDS.has(term.toLowerCase())) candidates.push(term);
  }
  const counts = new Map();
  for (const term of candidates) counts.set(term, (counts.get(term) ?? 0) + 1);
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, maxTerms);
  const selected = [];
  let estimatedTokens = 0;
  for (const [word] of ranked) {
    const chineseCharacters = (word.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latinCharacters = word.length - chineseCharacters;
    const cost = chineseCharacters + Math.max(1, Math.ceil(latinCharacters / 4));
    if (estimatedTokens + cost > tokenBudget) continue;
    selected.push({ word });
    estimatedTokens += cost;
  }
  return selected;
}

export function looksLikeExfiltration(question) {
  return /(逐字|完整|原样|verbatim|exact).{0,20}(主线程|主包|系统提示|system prompt|context)|(?:输出|展示|泄露|print|reveal).{0,20}(主线程|主包|系统提示|隐藏指令|hidden prompt)/i.test(question);
}

export function hasVerbatimLeak(answer, masterText, windowSize = 100) {
  const normalizedAnswer = answer.replace(/\s+/g, ' ').trim();
  const normalizedMaster = masterText.replace(/\s+/g, ' ');
  if (normalizedAnswer.length < windowSize) return false;
  for (let offset = 0; offset <= normalizedAnswer.length - windowSize; offset += 1) {
    if (normalizedMaster.includes(normalizedAnswer.slice(offset, offset + windowSize))) return true;
  }
  return false;
}
