import { createInterface } from 'node:readline/promises';

/**
 * Minimal terminal prompts for the admin CLI. Works interactively (TTY, with hidden
 * password input) and with piped stdin (one answer per line) for automation.
 */
export class Prompter {
  private pipedLines: string[] | undefined;

  private async nextPipedLine(): Promise<string> {
    if (this.pipedLines === undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
      this.pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    }
    return this.pipedLines.shift() ?? '';
  }

  async ask(question: string): Promise<string> {
    if (!process.stdin.isTTY) {
      process.stdout.write(question);
      const line = await this.nextPipedLine();
      process.stdout.write('\n');
      return line.trim();
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  async askHidden(question: string): Promise<string> {
    if (!process.stdin.isTTY) {
      process.stdout.write(question);
      const line = await this.nextPipedLine();
      process.stdout.write('\n');
      return line;
    }
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return new Promise((resolve) => {
      let value = '';
      const finish = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      };
      const onData = (data: string) => {
        for (const ch of data) {
          if (ch === '\r' || ch === '\n') {
            finish();
            return;
          }
          if (ch === '\u0003') {
            process.stdout.write('\nAborted.\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
            continue;
          }
          value += ch;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    });
  }
}
