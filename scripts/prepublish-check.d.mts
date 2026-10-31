export interface Rule {
  id: string;
  re: RegExp;
  ignoreValue?: RegExp;
}
export interface Finding {
  line: number;
  rule: string;
  preview: string;
}
export interface FileFinding extends Finding {
  file: string;
}
export const LOCAL_PATTERNS_FILE: string;
export const BUILTIN_RULES: Rule[];
export function parseLocalPatterns(text: string): Rule[];
export function scanText(text: string, rules?: Rule[]): Finding[];
export function scanFiles(files: string[], root: string, rules?: Rule[]): FileFinding[];
export function listTrackedFiles(root: string): string[];
export function loadRules(root: string): { rules: Rule[]; localCount: number };
export function run(cwd?: string): number;
