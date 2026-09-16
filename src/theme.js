export const BRAND = "Inkstone";
export const VERSION = "1.7.1";

const supportsColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

export const color = {
  cyan: wrap("\x1b[36m", "\x1b[0m"),
  dim: wrap("\x1b[2m", "\x1b[0m"),
  green: wrap("\x1b[32m", "\x1b[0m"),
  red: wrap("\x1b[31m", "\x1b[0m"),
  yellow: wrap("\x1b[33m", "\x1b[0m"),
  bold: wrap("\x1b[1m", "\x1b[0m"),
  inverse: wrap("\x1b[7m", "\x1b[0m")
};

export function banner() {
  return [
    color.cyan(color.bold(`${BRAND} ${VERSION}`)),
    color.dim("面向 DeepSeek 的本地 AI 编程 Agent")
  ].join("\n");
}

export function section(title) {
  return color.cyan(color.bold(title));
}

export function commandLine(command, description) {
  return `  ${color.green(command.padEnd(42))} ${color.dim(description)}`;
}

export function statusLine(label, value) {
  return `${color.dim(label.padEnd(12))} ${value}`;
}

function wrap(open, close) {
  return (value) => supportsColor ? `${open}${value}${close}` : value;
}
