import type { ITheme } from "@xterm/xterm";
import type { Key } from "../i18n";

export type TerminalThemeChoice = "auto" | "onedark" | "midnight" | "light" | "paper";
export type ResolvedTerminalTheme = "onedark" | "midnight" | "light" | "paper";

const STORAGE_KEY = "jarvy-term-theme";

export interface TerminalThemeOption {
  id: TerminalThemeChoice;
  labelKey: Key;
  swatch: string;
}

export const TERMINAL_THEME_OPTIONS: readonly TerminalThemeOption[] = [
  { id: "auto", labelKey: "terminal.themeAuto", swatch: "linear-gradient(135deg, #fafbfc 50%, #21252b 50%)" },
  { id: "onedark", labelKey: "terminal.themeOnedark", swatch: "#21252b" },
  { id: "midnight", labelKey: "terminal.themeMidnight", swatch: "#131720" },
  { id: "light", labelKey: "terminal.themeLight", swatch: "#fafbfc" },
  { id: "paper", labelKey: "terminal.themePaper", swatch: "#fbf8ef" },
];

export const TERMINAL_THEMES: Record<ResolvedTerminalTheme, ITheme> = {
  onedark: {
    background: "#21252b",
    foreground: "#e1e6ee",
    cursor: "#61afef",
    cursorAccent: "#21252b",
    selectionBackground: "#3e4451",
    selectionInactiveBackground: "#323842",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#f47067",
    brightGreen: "#a8d98b",
    brightYellow: "#f0cc86",
    brightBlue: "#74bdf7",
    brightMagenta: "#d28ee8",
    brightCyan: "#6bc9d5",
    brightWhite: "#f5f7fa",
  },
  midnight: {
    background: "#131720",
    foreground: "#eef2f8",
    cursor: "#7aa2f7",
    cursorAccent: "#131720",
    selectionBackground: "#28344a",
    selectionInactiveBackground: "#1e2636",
    black: "#151923",
    red: "#f7768e",
    green: "#5fd7a7",
    yellow: "#f6c177",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#c0caf5",
    brightBlack: "#565f89",
    brightRed: "#ff899d",
    brightGreen: "#7ee8be",
    brightYellow: "#ffd599",
    brightBlue: "#9bb8ff",
    brightMagenta: "#d0b3ff",
    brightCyan: "#9de0ff",
    brightWhite: "#ffffff",
  },
  light: {
    background: "#fafbfc",
    foreground: "#24292f",
    cursor: "#0969da",
    cursorAccent: "#fafbfc",
    selectionBackground: "#b6d7ff",
    selectionInactiveBackground: "#dce8f8",
    black: "#24292f",
    red: "#cf222e",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#2da44e",
    brightYellow: "#bf8700",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
  paper: {
    background: "#fbf8ef",
    foreground: "#3b3428",
    cursor: "#2663a8",
    cursorAccent: "#fbf8ef",
    selectionBackground: "#e6dbc2",
    selectionInactiveBackground: "#efe7d6",
    black: "#3b3428",
    red: "#b83a2d",
    green: "#4c7a34",
    yellow: "#9c6311",
    blue: "#2663a8",
    magenta: "#7e4896",
    cyan: "#1f7872",
    white: "#786e5d",
    brightBlack: "#837864",
    brightRed: "#d1493a",
    brightGreen: "#5d9142",
    brightYellow: "#b87718",
    brightBlue: "#3678c2",
    brightMagenta: "#945ab0",
    brightCyan: "#28918a",
    brightWhite: "#9d927e",
  },
};

export function loadTerminalThemeChoice(): TerminalThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "auto" || saved === "onedark" || saved === "midnight" || saved === "light" || saved === "paper") return saved;
  } catch { /* ignore storage restrictions */ }
  return "onedark";
}

export function saveTerminalThemeChoice(choice: TerminalThemeChoice): void {
  try { localStorage.setItem(STORAGE_KEY, choice); } catch { /* ignore */ }
}

export function resolveTerminalTheme(choice: TerminalThemeChoice): ResolvedTerminalTheme {
  if (choice !== "auto") return choice;
  return document.documentElement.classList.contains("dark") ? "onedark" : "light";
}
