export type LogLevel = "debug" | "info" | "warning" | "error";

export interface LogEntry {
  time: string;
  level: LogLevel;
  flag: string;
  message: string;
}

/**
 * 内存里最多留这么多条，超出就丢最早的。
 *
 * 为什么从 3000 提到 20000：批量压缩时单文件就会有十几行过程日志
 * （解析 / 5 个处理步骤 / 逐张纹理 / 校验 / 收尾），压一个 113 个文件的目录
 * 轻松超过 3000 行。旧的容量会把最早那批文件的过程日志挤掉，
 * 事后排查就只剩最后几个文件，等于没记。
 */
const MAX_ENTRIES = 20000;

/** 单条消息最长字符数；超长对象（比如整份参数树）截断，避免一行日志几千字 */
const MAX_MESSAGE_CHARS = 4000;

/** 等级由低到高，用于「当前等级以上才输出」的判断 */
const LEVEL_ORDER: LogLevel[] = ["debug", "info", "warning", "error"];

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS)}…（已截断，原文 ${text.length} 字符）`;
}

/**
 * 把任意类型的日志参数渲染成可读文本。
 *
 * 三条硬要求：
 * 1. **一条事件占一行** —— 缓冲、落盘、导出都按行处理，多行会把时间线切碎，
 *    所以普通对象统一用紧凑 JSON（不带缩进）。
 * 2. **Error 必须带栈** —— 只记 `e.message` 永远定位不到出错位置，这是排查的关键。
 *    Error 的栈天生多行，改成把后续行前缀成 `    | `，一眼能看出是上一条的续行。
 * 3. **超长要截断** —— 参数树、图片 key 列表可能很长，不截断会把一整行日志撑到几万字符。
 */
function formatMessage(message: any): string {
  if (message === undefined) return "";
  if (message === null) return "null";
  if (typeof message === "string") return truncate(message);
  if (message instanceof Error) {
    const stack = message.stack || `${message.name}: ${message.message}`;
    return truncate(stack.replace(/\r?\n/g, "\n    | "));
  }
  // 顶层就是二进制时直接给摘要，别指望 replacer——
  // JSON.stringify 会先调 Buffer.prototype.toJSON，replacer 拿到的已经是
  // {type:"Buffer",data:[...]} 这种几百个数字的形状了
  if (message instanceof Uint8Array) return `<${message.length} bytes>`;
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(message, (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
        // toJSON 之后的 Buffer 形状，同样换成摘要
        if (value.type === "Buffer" && Array.isArray(value.data)) return `<${value.data.length} bytes>`;
      }
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Uint8Array) return `<${value.length} bytes>`;
      return value;
    });
    return truncate(text === undefined ? String(message) : text);
  } catch {
    return truncate(String(message));
  }
}

export class Logger {
  private static enable = true;
  private static instance: Logger;
  private logLevel: LogLevel;
  /** 最近的日志，供界面「导出日志」按钮取用 */
  private entries: LogEntry[] = [];
  /** 额外出口（扩展端挂 OutputChannel + 落盘），与 console 并行 */
  private sink: ((line: string) => void) | undefined;
  private _logger = {
    debug: console.log,
    info: console.log,
    warning: console.warn,
    error: console.error,
  };

  constructor(logLevel: LogLevel = "debug") {
    if (Logger.instance) return Logger.instance;
    Logger.instance = this;
    this.logLevel = logLevel;
  }

  static getInstance(logLevel?: LogLevel): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(logLevel);
    }
    return Logger.instance;
  }

  setLogLevel(logLevel: LogLevel): void {
    if (LEVEL_ORDER.includes(logLevel)) this.logLevel = logLevel;
  }

  get currentLevel(): LogLevel {
    return this.logLevel;
  }

  /**
   * 注册一个日志出口。
   *
   * VSCode 的「输出」面板要把日志写进 OutputChannel 才会显示，而 console 输出
   * 除 error 外都会被扩展宿主丢弃（exthost.log 里只剩 [error] 行），
   * 所以排查时必须有这条通道。扩展端还会在这个出口里再加一层落盘。
   */
  setSink(sink: ((line: string) => void) | undefined): void {
    this.sink = sink;
  }

  private log(level: LogLevel, flag: string, message: any): void {
    if (!Logger.enable || !this.shouldLog(level)) return;
    const text = formatMessage(message);
    const _logger = this._logger[level] || console.log;
    _logger(`[${level.toUpperCase()} => ${flag}]: `, text);
    this.record(level, flag, text);
  }

  private record(level: LogLevel, flag: string, message: string): void {
    const time = timestamp();
    this.entries.push({ time, level, flag, message });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    if (this.sink) {
      try {
        this.sink(`${time} [${level.toUpperCase()}] ${flag} ${message}`);
      } catch {
        // 日志出口自身出问题不能反过来把主流程带崩
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(this.logLevel);
  }

  debug(flag: string, message: any = ""): void {
    this.log("debug", flag, message);
  }

  info(flag: string, message: any = ""): void {
    this.log("info", flag, message);
  }

  warn(flag: string, message: any): void {
    this.log("warning", flag, message);
  }

  error(flag: string, message: any): void {
    this.log("error", flag, message);
  }

  /** 已缓存条数 */
  get size(): number {
    return this.entries.length;
  }

  /** 缓冲区是否已经因为容量上限丢过日志（丢了就说明该靠磁盘历史补齐） */
  get truncated(): boolean {
    return this.entries.length >= MAX_ENTRIES;
  }

  /** 导出已缓存的全部日志（纯文本） */
  dump(): string {
    if (!this.entries.length) return "(本次会话没有日志)";
    return this.entries.map((e) => `${e.time} [${e.level.toUpperCase()}] ${e.flag} ${e.message}`).join("\n");
  }

  /** 只要最后 n 条，用于导出的「磁盘历史」这类摘要场景 */
  tail(n: number): string {
    if (!this.entries.length) return "(没有日志)";
    const slice = n > 0 ? this.entries.slice(-n) : this.entries;
    return slice.map((e) => `${e.time} [${e.level.toUpperCase()}] ${e.flag} ${e.message}`).join("\n");
  }

  clear(): void {
    this.entries = [];
  }
}

export default new Logger();
