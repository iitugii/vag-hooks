export const logger = {
  info: (...a: any[]) => console.log("[info]", ...a),
  warn: (...a: any[]) => console.warn("[warn]", ...a),
  error: (...a: any[]) => console.error("[error]", ...a),
};
