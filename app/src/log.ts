import { parseArgs } from 'https://deno.land/std@0.217.0/cli/parse_args.ts';
import { dirname, join, normalize } from 'https://deno.land/std@0.217.0/path/mod.ts';

const __args = parseArgs(Deno.args);

const logfile = __args['logfile']
  ? normalize(String(__args['logfile']))
  : join(dirname(new URL(import.meta.url).pathname), '../../peek.log');

type LogArg = string | number | boolean | null | undefined | object;

type Logger = {
  info: (msg: string, ...args: LogArg[]) => void;
};

let logger: Logger | undefined;

function timestamp() {
  return new Date().toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    fractionalSecondDigits: 3,
  });
}

function formatArg(arg: LogArg) {
  if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
  return String(arg);
}

function write(levelName: string, msg: string, args: LogArg[]) {
  const pid = Deno.pid.toString().padEnd(8, ' ');
  const suffix = args.length ? ` ${args.map(formatArg).join(' ')}` : '';
  Deno.writeTextFileSync(
    logfile,
    `${levelName.padEnd(9, ' ')} ${pid} ${timestamp()}  ${msg}${suffix}\n`,
    { append: true },
  );
}

function setupLogger() {
  logger = {
    info(msg: string, ...args: LogArg[]) {
      write('INFO', msg, args);
    },
  };

  return logger;
}

function get() {
  return logger || setupLogger();
}

export default { setupLogger, get };
