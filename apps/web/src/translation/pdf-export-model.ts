export const exportReasons = {
  untranslated: "尚无已完成译文",
  stale: "译文与当前原文不匹配",
  structure: "复杂公式或排版",
  bounds: "段落位置无效",
  overlap: "与其他内容重叠",
  source: "无法安全定位原文文字",
  background: "文字区域含背景或图形",
  font: "字体无法完整显示",
  overflow: "译文无法在原区域内排下",
  unparsed: "页面尚未解析",
} as const;
export type ExportIssue = {
  page: number;
  blockId?: string;
  reason: keyof typeof exportReasons;
};
export type PDFExportProgress = {
  phase: "preparing" | "pages" | "saving";
  done: number;
  total: number;
};
export type TranslatedPDF = {
  bytes: Uint8Array;
  translated: number;
  pages: number;
  issues: ExportIssue[];
};
