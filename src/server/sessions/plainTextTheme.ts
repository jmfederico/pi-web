import { Theme } from "@earendil-works/pi-coding-agent";

type ThemeConstructorParameters = ConstructorParameters<typeof Theme>;

const RESET_COLOR = "";

// Theme requires complete color tables for nominal class construction. Every
// method that could expose the resulting reset codes is overridden below.
const SUPERCLASS_FOREGROUND_COLORS = {
  accent: RESET_COLOR,
  border: RESET_COLOR,
  borderAccent: RESET_COLOR,
  borderMuted: RESET_COLOR,
  success: RESET_COLOR,
  error: RESET_COLOR,
  warning: RESET_COLOR,
  muted: RESET_COLOR,
  dim: RESET_COLOR,
  text: RESET_COLOR,
  thinkingText: RESET_COLOR,
  userMessageText: RESET_COLOR,
  customMessageText: RESET_COLOR,
  customMessageLabel: RESET_COLOR,
  toolTitle: RESET_COLOR,
  toolOutput: RESET_COLOR,
  mdHeading: RESET_COLOR,
  mdLink: RESET_COLOR,
  mdLinkUrl: RESET_COLOR,
  mdCode: RESET_COLOR,
  mdCodeBlock: RESET_COLOR,
  mdCodeBlockBorder: RESET_COLOR,
  mdQuote: RESET_COLOR,
  mdQuoteBorder: RESET_COLOR,
  mdHr: RESET_COLOR,
  mdListBullet: RESET_COLOR,
  toolDiffAdded: RESET_COLOR,
  toolDiffRemoved: RESET_COLOR,
  toolDiffContext: RESET_COLOR,
  syntaxComment: RESET_COLOR,
  syntaxKeyword: RESET_COLOR,
  syntaxFunction: RESET_COLOR,
  syntaxVariable: RESET_COLOR,
  syntaxString: RESET_COLOR,
  syntaxNumber: RESET_COLOR,
  syntaxType: RESET_COLOR,
  syntaxOperator: RESET_COLOR,
  syntaxPunctuation: RESET_COLOR,
  thinkingOff: RESET_COLOR,
  thinkingMinimal: RESET_COLOR,
  thinkingLow: RESET_COLOR,
  thinkingMedium: RESET_COLOR,
  thinkingHigh: RESET_COLOR,
  thinkingXhigh: RESET_COLOR,
  thinkingMax: RESET_COLOR,
  bashMode: RESET_COLOR,
} satisfies ThemeConstructorParameters[0];

const SUPERCLASS_BACKGROUND_COLORS = {
  selectedBg: RESET_COLOR,
  userMessageBg: RESET_COLOR,
  customMessageBg: RESET_COLOR,
  toolPendingBg: RESET_COLOR,
  toolSuccessBg: RESET_COLOR,
  toolErrorBg: RESET_COLOR,
} satisfies ThemeConstructorParameters[1];

function preserveText(text: string): string {
  return text;
}

class PlainTextTheme extends Theme {
  constructor() {
    super(SUPERCLASS_FOREGROUND_COLORS, SUPERCLASS_BACKGROUND_COLORS, "256color", { name: "pi-web-plain-text" });
  }

  override fg(color: Parameters<Theme["fg"]>[0], text: string): string {
    void color;
    return text;
  }

  override bg(color: Parameters<Theme["bg"]>[0], text: string): string {
    void color;
    return text;
  }

  override bold(text: string): string {
    return text;
  }

  override italic(text: string): string {
    return text;
  }

  override underline(text: string): string {
    return text;
  }

  override inverse(text: string): string {
    return text;
  }

  override strikethrough(text: string): string {
    return text;
  }

  override getFgAnsi(color: Parameters<Theme["getFgAnsi"]>[0]): string {
    void color;
    return "";
  }

  override getBgAnsi(color: Parameters<Theme["getBgAnsi"]>[0]): string {
    void color;
    return "";
  }

  override getColorMode(): ReturnType<Theme["getColorMode"]> {
    return "256color";
  }

  override getThinkingBorderColor(
    level: Parameters<Theme["getThinkingBorderColor"]>[0],
  ): ReturnType<Theme["getThinkingBorderColor"]> {
    void level;
    return preserveText;
  }

  override getBashModeBorderColor(): ReturnType<Theme["getBashModeBorderColor"]> {
    return preserveText;
  }
}

/** Shared ANSI-free Theme facade for extension code running without a terminal. */
export const plainTextTheme: Theme = new PlainTextTheme();
