import type { GoalBudget, MaybeUndefined, ParsedGoalCommand, OperationResult } from "./types";

const STATUS_WORDS = new Set(["status", "show"]);
const LIST_WORDS = new Set(["list", "ls"]);
const PAUSE_WORDS = new Set(["pause", "stop"]);
const RESUME_WORDS = new Set(["resume", "continue"]);
const CLEAR_WORDS = new Set(["clear", "reset", "off", "none"]);
const ABORT_WORDS = new Set(["abort", "cancel"]);
const FOCUS_WORDS = new Set(["focus", "switch"]);
const TWEAK_WORDS = new Set(["tweak", "edit", "revise"]);
const HELP_WORDS = new Set(["help", "?"]);

interface FlagValueRead {
  flag: string;
  value: string;
  nextIndex: number;
}

interface NumericParseOptions {
  integer: boolean;
  allowZero: boolean;
  description: string;
}

export function parseGoalCommand(commandName: string, defaultCommandName: string, rawArguments: string): OperationResult<ParsedGoalCommand> {
  const tokensResult = splitCommandLine(rawArguments);
  if (tokensResult.ok === false) return tokensResult;
  const tokens = tokensResult.value;

  if (commandName === `${defaultCommandName}-status`) return okCommand("status");
  if (commandName === `${defaultCommandName}-list`) return okCommand("list");
  if (commandName === `${defaultCommandName}-pause`) return okCommand("pause", { reason: rawArguments });
  if (commandName === `${defaultCommandName}-resume`) return okCommand("resume");
  if (commandName === `${defaultCommandName}-clear`) return okCommand("clear");
  if (commandName === `${defaultCommandName}-abort`) return okCommand("abort", { reason: rawArguments });
  if (commandName === `${defaultCommandName}-focus`) return okCommand("focus", { goalId: rawArguments.trim() });
  if (commandName === `${defaultCommandName}-tweak`) return okCommand("tweak", { objective: rawArguments.trim() });
  if (commandName === `${defaultCommandName}-confirm`) return okCommand("confirm", { goalId: rawArguments.trim() });
  if (commandName === `${defaultCommandName}-reject`) return okCommand("reject", { goalId: rawArguments.trim() });
  if (commandName === `${defaultCommandName}-set`) return parseStart(tokens);

  if (tokens.length === 0) return okCommand("status");
  const first = tokens[0];
  if (first === undefined) return okCommand("status");
  const lowerFirst = first.toLowerCase();
  const rest = tokens.slice(1).join(" ");

  if (STATUS_WORDS.has(lowerFirst)) return okCommand("status");
  if (LIST_WORDS.has(lowerFirst)) return okCommand("list");
  if (PAUSE_WORDS.has(lowerFirst)) return okCommand("pause", { reason: rest });
  if (RESUME_WORDS.has(lowerFirst)) return okCommand("resume");
  if (CLEAR_WORDS.has(lowerFirst)) return okCommand("clear");
  if (ABORT_WORDS.has(lowerFirst)) return okCommand("abort", { reason: rest });
  if (FOCUS_WORDS.has(lowerFirst)) return okCommand("focus", { goalId: rest.trim() });
  if (TWEAK_WORDS.has(lowerFirst)) return okCommand("tweak", { objective: rest.trim() });
  if (lowerFirst === "confirm") return okCommand("confirm", { goalId: rest.trim() });
  if (lowerFirst === "reject" || lowerFirst === "discard-draft") return okCommand("reject", { goalId: rest.trim() });
  if (HELP_WORDS.has(lowerFirst)) return okCommand("help");

  return parseDraft(tokens);
}

function parseDraft(tokens: string[]): OperationResult<ParsedGoalCommand> {
  const parsed = parseGoalDefinition(tokens, "draft");
  if (parsed.ok === false) return parsed;
  return parsed;
}

function parseStart(tokens: string[]): OperationResult<ParsedGoalCommand> {
  return parseGoalDefinition(tokens, "start");
}

function parseGoalDefinition(tokens: string[], action: "draft" | "start"): OperationResult<ParsedGoalCommand> {
  const objectiveParts: string[] = [];
  const budgetOverrides: Partial<GoalBudget> = {};
  let successCriteria: MaybeUndefined<string>;
  let constraints: MaybeUndefined<string>;
  let verificationContract: MaybeUndefined<string>;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.startsWith("--") === false) {
      objectiveParts.push(token);
      continue;
    }

    const flagResult = readFlagValue(tokens, index);
    if (flagResult.ok === false) return flagResult;
    index = flagResult.value.nextIndex;
    const flag = flagResult.value.flag;
    const value = flagResult.value.value;

    const budgetFlag = applyKnownBudgetFlag(flag, value, budgetOverrides);
    if (budgetFlag.ok === false) return budgetFlag;
    if (budgetFlag.value) continue;
    if (flag === "success" || flag === "success-criteria") {
      successCriteria = value;
      continue;
    }
    if (flag === "constraints" || flag === "non-goals") {
      constraints = value;
      continue;
    }
    if (flag === "contract" || flag === "verification-contract") {
      verificationContract = value;
      continue;
    }

    return { ok: false, message: `Unknown goal flag: --${flag}` };
  }

  const objective = objectiveParts.join(" ").trim();
  if (objective.length === 0) return { ok: false, message: "Goal objective is empty." };
  return {
    ok: true,
    value: {
      action,
      objective,
      successCriteria,
      constraints,
      verificationContract,
      budgetOverrides,
    },
  };
}

function okCommand(action: ParsedGoalCommand["action"], partial?: Partial<ParsedGoalCommand>): OperationResult<ParsedGoalCommand> {
  return { ok: true, value: { action, budgetOverrides: {}, ...partial } };
}

function readFlagValue(tokens: string[], index: number): OperationResult<FlagValueRead> {
  const token = tokens[index];
  if (token === undefined) return { ok: false, message: "Missing flag." };
  const rawFlag = token.slice(2);
  const equalsIndex = rawFlag.indexOf("=");
  if (equalsIndex >= 0) {
    const flag = rawFlag.slice(0, equalsIndex);
    const value = rawFlag.slice(equalsIndex + 1);
    if (flag.length === 0 || value.length === 0) return { ok: false, message: `Invalid flag: ${token}` };
    return { ok: true, value: { flag, value, nextIndex: index } };
  }

  const next = tokens[index + 1];
  if (next === undefined) return { ok: false, message: `Missing value for flag: ${token}` };
  if (next.startsWith("--")) return { ok: false, message: `Missing value for flag: ${token}` };
  if (rawFlag.length === 0) return { ok: false, message: `Invalid flag: ${token}` };
  return { ok: true, value: { flag: rawFlag, value: next, nextIndex: index + 1 } };
}

function applyBudgetFlag(
  value: string,
  flag: string,
  parse: (value: string, flag: string) => OperationResult<number>,
  assign: (numberValue: number) => void,
): OperationResult<boolean> {
  const numberResult = parse(value, flag);
  if (numberResult.ok === false) return numberResult;
  assign(numberResult.value);
  return { ok: true, value: true };
}

function applyKnownBudgetFlag(flag: string, value: string, budgetOverrides: Partial<GoalBudget>): OperationResult<boolean> {
  if (flag === "max-turns") {
    return applyBudgetFlag(value, flag, parsePositiveInteger, (numberValue) => {
      budgetOverrides.maxTurns = numberValue;
    });
  }
  if (flag === "max-minutes") {
    return applyBudgetFlag(value, flag, parsePositiveNumber, (numberValue) => {
      budgetOverrides.maxRuntimeMs = Math.round(numberValue * 60_000);
    });
  }
  if (flag === "max-duration-ms") {
    return applyBudgetFlag(value, flag, parsePositiveInteger, (numberValue) => {
      budgetOverrides.maxRuntimeMs = numberValue;
    });
  }
  if (flag === "max-tokens" || flag === "budget") {
    return applyBudgetFlag(value, flag, parseTokenBudget, (numberValue) => {
      budgetOverrides.maxTokens = numberValue;
    });
  }
  if (flag === "cooldown-ms" || flag === "min-delay-ms") {
    return applyBudgetFlag(value, flag, parseNonNegativeInteger, (numberValue) => {
      budgetOverrides.minDelayMs = numberValue;
    });
  }
  if (flag === "no-progress-turns") {
    return applyBudgetFlag(value, flag, parsePositiveInteger, (numberValue) => {
      budgetOverrides.noProgressTurnsBeforePause = numberValue;
    });
  }
  if (flag === "no-tool-turns") {
    return applyBudgetFlag(value, flag, parsePositiveInteger, (numberValue) => {
      budgetOverrides.noToolCallTurnsBeforePause = numberValue;
    });
  }
  if (flag === "no-progress-threshold") {
    return applyBudgetFlag(value, flag, parseNonNegativeInteger, (numberValue) => {
      budgetOverrides.noProgressTokenThreshold = numberValue;
    });
  }
  return { ok: true, value: false };
}

function parsePositiveInteger(value: string, flag: string): OperationResult<number> {
  return parseNumericValue(value, flag, { integer: true, allowZero: false, description: "a positive integer" });
}

function parseNonNegativeInteger(value: string, flag: string): OperationResult<number> {
  return parseNumericValue(value, flag, { integer: true, allowZero: true, description: "a non-negative integer" });
}

function parsePositiveNumber(value: string, flag: string): OperationResult<number> {
  return parseNumericValue(value, flag, { integer: false, allowZero: false, description: "a positive number" });
}

function parseNumericValue(
  value: string,
  flag: string,
  options: NumericParseOptions,
): OperationResult<number> {
  const numericPattern = options.integer ? /^\d+$/ : /^\d+(?:\.\d+)?$/;
  if (numericPattern.test(value) === false) return { ok: false, message: `--${flag} must be ${options.description}.` };
  const parsed = options.integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
  if (options.allowZero === false && parsed <= 0) return { ok: false, message: `--${flag} must be greater than zero.` };
  return { ok: true, value: parsed };
}

function parseTokenBudget(value: string, flag: string): OperationResult<number> {
  const match = /^(\d+(?:\.\d+)?)([kKmM])?$/.exec(value);
  if (match === null) return { ok: false, message: `--${flag} must be a number with optional k/m suffix.` };
  const amountText = match[1];
  if (amountText === undefined) return { ok: false, message: `--${flag} must include a number.` };
  const suffix = match[2];
  const amount = Number.parseFloat(amountText);
  if (amount <= 0) return { ok: false, message: `--${flag} must be greater than zero.` };
  return { ok: true, value: Math.round(amount * tokenBudgetMultiplier(suffix)) };
}

function tokenBudgetMultiplier(suffix: MaybeUndefined<string>): number {
  if (suffix === undefined) return 1;
  if (suffix.toLowerCase() === "k") return 1_000;
  return 1_000_000;
}

export function splitCommandLine(input: string): OperationResult<string[]> {
  const tokens: string[] = [];
  let current = "";
  let quote: MaybeUndefined<string>;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote !== undefined) return { ok: false, message: "Unclosed quote in goal command." };
  if (current.length > 0) tokens.push(current);
  return { ok: true, value: tokens };
}
