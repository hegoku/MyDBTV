function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return normalizeWhitespace(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function decodeEntities(value) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " "
  };

  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (entities[lower]) return entities[lower];
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return match;
  });
}

function cleanText(value) {
  return decodeEntities(stripTags(value));
}

function attrValue(attrs, name) {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function isUsefulTitle(title) {
  const value = cleanText(title);
  if (value.length < 2 || value.length > 90) return false;
  return !/^(首页|电影|电视剧|综艺|动漫|短剧|纪录片|登录|注册|搜索|更多|详情|立即播放|收藏|分享)$/i.test(value);
}

function extractLabeledValue(text, labels) {
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}[：:]\\s*([^\\n\\r|]{1,80})`, "i"));
    if (match) return normalizeWhitespace(match[1]);
  }
  return "";
}

function extractTitleFromHtml(html, fallback) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return cleanText(h1[1]);
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return cleanText(title[1]).replace(/[_-].*$/, "").trim();
  return fallback;
}

module.exports = {
  attrValue,
  cleanText,
  decodeEntities,
  extractLabeledValue,
  extractTitleFromHtml,
  isUsefulTitle,
  normalizeWhitespace
};
