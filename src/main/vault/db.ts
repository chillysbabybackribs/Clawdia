
import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../logger';

const log = createLogger('vault-db');

let db: Database.Database | null = null;

export function getVaultDB(): Database.Database {
    if (!db) {
        throw new Error('Vault DB not initialized. Call initVault() first.');
    }
    return db;
}

// Encapsulate vault location logic
let cachedVaultPath: string | null = null;
export function getVaultPath(): string {
    if (cachedVaultPath) return cachedVaultPath;
    throw new Error('Vault path not initialized. Call initVault() first.');
}

export function initVault(testBasePath?: string): void {
    try {
        let userDataPath: string;
        if (testBasePath) {
            userDataPath = testBasePath;
        } else {
            userDataPath = app.getPath('userData');
        }
        const vaultPath = path.join(userDataPath, 'clawdia_vault');
        cachedVaultPath = vaultPath;

        if (!fs.existsSync(vaultPath)) {
            fs.mkdirSync(vaultPath, { recursive: true });
        }

        const dbPath = path.join(vaultPath, 'vault.db');
        log.info(`Initializing Vault DB at: ${dbPath}`);

        // Determine schema path
        let schemaPath = path.join(__dirname, 'schema.sql');
        if (!fs.existsSync(schemaPath)) {
            // Fallback for development environment
            // Assumes we are in dist/main/vault and source is in src/main/vault
            schemaPath = path.resolve(__dirname, '../../../src/main/vault/schema.sql');
            if (!fs.existsSync(schemaPath)) {
                // Try one level up if structure is different
                schemaPath = path.resolve(__dirname, '../../src/main/vault/schema.sql');
            }
        }

        if (!fs.existsSync(schemaPath)) {
            throw new Error(`Schema file not found at ${schemaPath} or default locations.`);
        }

        const schema = fs.readFileSync(schemaPath, 'utf8');

        // Initialize DB
        db = new Database(dbPath);

        // Essential Pragmas
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON'); // Important!

        // Apply Schema
        // better-sqlite3 exec supports multiple statements
        db.exec(schema);

        log.info('Vault schema applied successfully.');

    } catch (error: any) {
        log.error('Failed to initialize vault database:', error);
        throw error;
    }
}
