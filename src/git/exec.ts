import { spawn } from 'child_process';

export class GitError extends Error {
  constructor(message: string, public readonly exitCode: number | null) {
    super(message);
  }
}

export function runGit(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => err.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new GitError(stderr || `git ${args[0]} exited with code ${code}`, code));
      }
    });
    proc.stdin.on('error', () => { /* process may exit before reading stdin */ });
    proc.stdin.end(input ?? '');
  });
}
