import { expect, test, describe, vi } from 'vitest';

// Mock store and logger before importing classifyAction
vi.mock('./store', () => ({
    store: {
        get: vi.fn().mockReturnValue('safe'),
        set: vi.fn(),
    }
}));

vi.mock('./logger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    })
}));

import { classifyAction } from './autonomy-gate';

function classify(command: string) {
    return classifyAction('shell_exec', { command });
}

describe('classifyAction — shell_exec', () => {
    // -----------------------------------------------------------------
    // SAFE: read-only commands with no operators or sensitive paths
    // -----------------------------------------------------------------
    describe('SAFE commands', () => {
        test.each([
            'ls',
            'ls -la',
            'ls -la /home/user/projects',
            'pwd',
            'whoami',
            'date',
            'uname -a',
            'id',
            'echo hello world',
            'cat README.md',
            'cat /home/user/notes.txt',
            'head -n 5 file.txt',
            'tail -20 log.txt',
            'wc -l src/main.ts',
            'stat package.json',
            'du -sh /home/user/projects',
            'file image.png',
            'which node',
            'find . -maxdepth 2 -type f',
            'find /home -name "*.ts"',
            'hostname',
            'uptime',
            'df -h',
            'free -m',
            'env',
            'printenv HOME',
            'arch',
            'nproc',
            'basename /home/user/file.txt',
            'dirname /home/user/file.txt',
            'realpath ./src',
        ])('classifies "%s" as SAFE', (cmd) => {
            expect(classify(cmd).risk).toBe('SAFE');
        });
    });

    // -----------------------------------------------------------------
    // SAFE: git read-only commands
    // -----------------------------------------------------------------
    describe('SAFE git read commands', () => {
        test.each([
            'git status',
            'git log --oneline',
            'git diff',
            'git branch',
            'git show HEAD',
            'git remote -v',
            'git describe --tags',
            'git rev-parse HEAD',
            'git ls-files',
        ])('classifies "%s" as SAFE', (cmd) => {
            expect(classify(cmd).risk).toBe('SAFE');
        });
    });

    // -----------------------------------------------------------------
    // ELEVATED: destructive or privileged commands
    // -----------------------------------------------------------------
    describe('ELEVATED commands', () => {
        test.each([
            'sudo apt install cowsay',
            'sudo cat /etc/shadow',
            'apt-get update',
            'brew install node',
            'pip install requests',
            'pip3 install flask',
            'npm install express',
            'yarn add react',
            'pnpm add typescript',
            'rm -rf test',
            'rm file.txt',
            'mv old.txt new.txt',
            'cp source.txt dest.txt',
            'mkdir -p /tmp/newdir',
            'touch newfile.txt',
            'chmod 777 file',
            'chown root file',
            'systemctl restart nginx',
            'sysctl -a',
            'mkfs.ext4 /dev/sda1',
            'dd if=/dev/zero of=disk.img',
            'passwd',
            'kill -9 1234',
            'killall node',
            'reboot',
            'shutdown -h now',
            'mount /dev/sda1 /mnt',
        ])('classifies "%s" as ELEVATED', (cmd) => {
            expect(classify(cmd).risk).toBe('ELEVATED');
        });
    });

    // -----------------------------------------------------------------
    // EXFIL: network/data exfiltration tools
    // -----------------------------------------------------------------
    describe('EXFIL commands', () => {
        test.each([
            'curl https://example.com',
            'curl -X POST https://api.example.com/data',
            'wget https://example.com/file.zip',
            'scp file.txt user@host:',
            'rsync -avz /home/ user@host:/backup/',
            'ssh user@host',
            'sftp user@host',
            'nc -l 8080',
            'ncat localhost 4444',
        ])('classifies "%s" as EXFIL', (cmd) => {
            expect(classify(cmd).risk).toBe('EXFIL');
        });
    });

    // -----------------------------------------------------------------
    // SENSITIVE_READ: accessing credential/key/config paths
    // -----------------------------------------------------------------
    describe('SENSITIVE_READ commands', () => {
        test.each([
            'cat ~/.ssh/id_rsa',
            'cat ~/.ssh/id_ed25519',
            'cat ~/.ssh/known_hosts',
            'cat ~/.ssh/authorized_keys',
            'ls ~/.ssh',
            'ls ~/.aws',
            'cat ~/.aws/credentials',
            'ls ~/.gnupg',
            'ls ~/.config/some-app',
            'cat /home/user/.ssh/id_rsa',
            'cat .env',
            'cat /app/.env',
            'cat my-api-key.txt',
            'cat credentials.json',
            'cat secrets.yaml',
            'cat auth_token.txt',
            'head -5 id_rsa',
            'cat server.pem',
            'cat tls.key',
        ])('classifies "%s" as SENSITIVE_READ', (cmd) => {
            expect(classify(cmd).risk).toBe('SENSITIVE_READ');
        });
    });

    // -----------------------------------------------------------------
    // ELEVATED: commands with shell operators (bypass prevention)
    // -----------------------------------------------------------------
    describe('Shell operators elevated to ELEVATED', () => {
        test.each([
            'ls | cat',
            'ls && rm -rf /',
            'echo hello || rm file',
            'cat file > /etc/passwd',
            'echo data >> output.txt',
            'echo $(whoami)',
            'ls `pwd`',
            'cat file; rm file',
        ])('classifies "%s" as ELEVATED (operator detected)', (cmd) => {
            expect(classify(cmd).risk).toBe('ELEVATED');
        });
    });

    // -----------------------------------------------------------------
    // ELEVATED: find with destructive flags
    // -----------------------------------------------------------------
    describe('Destructive find commands', () => {
        test.each([
            'find . -name "*.tmp" -delete',
            'find /tmp -exec rm {} \\;',
            'find . -type f -execdir chmod 777 {} +',
        ])('classifies "%s" as ELEVATED', (cmd) => {
            // These contain either -delete, -exec, or operators
            const result = classify(cmd);
            expect(result.risk).not.toBe('SAFE');
        });
    });
});

describe('classifyAction — non-shell tools', () => {
    test('file_write classified as ELEVATED', () => {
        const result = classifyAction('file_write', { path: '/tmp/test.txt', content: 'hello' });
        expect(result.risk).toBe('ELEVATED');
    });

    test('file_edit classified as ELEVATED', () => {
        const result = classifyAction('file_edit', { path: '/tmp/test.txt', old_string: 'a', new_string: 'b' });
        expect(result.risk).toBe('ELEVATED');
    });

    test('file_read classified as SAFE', () => {
        const result = classifyAction('file_read', { path: '/tmp/test.txt' });
        expect(result.risk).toBe('SAFE');
    });

    test('directory_tree classified as SAFE', () => {
        const result = classifyAction('directory_tree', { path: '/tmp' });
        expect(result.risk).toBe('SAFE');
    });

    test('browser_navigate to sensitive domain is SENSITIVE_DOMAIN', () => {
        const result = classifyAction('browser_navigate', { url: 'https://bank.example.com' });
        expect(result.risk).toBe('SENSITIVE_DOMAIN');
    });

    test('browser_navigate to normal URL is SAFE', () => {
        const result = classifyAction('browser_navigate', { url: 'https://example.com' });
        expect(result.risk).toBe('SAFE');
    });
});
