#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';

import {
  CONFIG_FILENAME,
  DEFAULT_ENVIRONMENTS,
  createConfig,
  listEnvironments,
  loadConfig,
  resolveEnvironment,
  saveConfig,
} from '../src/config.js';
import {
  DecryptionError,
  EnvelopeFormatError,
  decrypt,
  encrypt,
  parseEnvelope,
  serializeEnvelope,
} from '../src/crypto.js';
import {
  VaultError,
  buffersEqual,
  diffEnv,
  ensureGitignore,
  fileExists,
  gitStatusOf,
  hasDifferences,
  parseEnv,
  safeReadFile,
  safeWriteFile,
  sanitizeForTerminal,
} from '../src/utils.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const PASSWORD_ENV = 'DOTENV_VAULT_PASSWORD';
const NEW_PASSWORD_ENV = 'DOTENV_VAULT_NEW_PASSWORD';
const MIN_PASSWORD_LENGTH = 12;

const log = {
  info: (msg) => console.log(msg),
  success: (msg) => console.log(`${chalk.green('✔')} ${msg}`),
  warn: (msg) => console.error(`${chalk.yellow('⚠')} ${msg}`),
  error: (msg) => console.error(`${chalk.red('✖')} ${msg}`),
  dim: (msg) => console.log(chalk.dim(msg)),
};

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

function ask(questions) {
  return prompts(questions, {
    onCancel: () => {
      throw new VaultError('Aborted by user. No files were changed.', { exitCode: 130 });
    },
  });
}

/** Resolves on approval; throws when declined or when approval is impossible (non-TTY). */
async function confirmOrAbort(message, { force = false } = {}) {
  if (force) return;
  if (!isInteractive()) {
    throw new VaultError(`${message.replace(/\?$/, '.')} Not running interactively.`, {
      hint: 'Re-run with --force to proceed without a prompt.',
    });
  }
  const { ok } = await ask({ type: 'confirm', name: 'ok', message, initial: false });
  if (!ok) throw new VaultError('Aborted. No files were changed.');
}

function newPasswordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.trim() !== password) return 'Password must not start or end with whitespace.';
  return null;
}

function assertNewPassword(password) {
  const problem = newPasswordProblem(password);
  if (problem) throw new VaultError(problem);
}

/**
 * Password precedence: CLI flag > environment variable > interactive prompt.
 * New passwords are strength-checked and confirmed when prompted.
 */
async function resolvePassword({ flagValue, flagName, envVar, message, isNew = false }) {
  if (flagValue !== undefined) {
    log.warn(
      `Passing a password via ${flagName} may expose it in shell history and process listings. ` +
        `Prefer the interactive prompt or the ${envVar} environment variable.`,
    );
    if (!flagValue) throw new VaultError(`${flagName} must not be empty.`);
    if (isNew) assertNewPassword(flagValue);
    return flagValue;
  }

  const fromEnv = process.env[envVar];
  if (fromEnv) {
    if (isNew) assertNewPassword(fromEnv);
    return fromEnv;
  }

  if (!isInteractive()) {
    throw new VaultError('No password provided.', {
      hint: `Run interactively, set ${envVar}, or pass ${flagName}.`,
    });
  }

  const { password } = await ask({
    type: 'password',
    name: 'password',
    message,
    validate: (value) => (isNew ? newPasswordProblem(value) ?? true : value.length > 0 || 'Password cannot be empty.'),
  });
  if (isNew) {
    const { confirmation } = await ask({ type: 'password', name: 'confirmation', message: 'Confirm password' });
    if (confirmation !== password) throw new VaultError('Passwords do not match. No files were changed.');
  }
  return password;
}

async function pickEnvironment(ctx, requested) {
  if (requested) return resolveEnvironment(ctx, requested);
  const names = listEnvironments(ctx.config);
  if (names.length === 1) return resolveEnvironment(ctx, names[0]);

  if (isInteractive()) {
    const initial = Math.max(0, names.indexOf(ctx.config.defaultEnvironment));
    const { env } = await ask({
      type: 'select',
      name: 'env',
      message: 'Select an environment',
      choices: names.map((name) => ({ title: name, value: name })),
      initial,
    });
    return resolveEnvironment(ctx, env);
  }
  if (ctx.config.defaultEnvironment) return resolveEnvironment(ctx, ctx.config.defaultEnvironment);
  throw new VaultError('No environment specified.', { hint: `Use --env <${names.join('|')}>.` });
}

function loadEnvelope(ctx, env) {
  if (!fileExists(env.encPath)) {
    throw new VaultError(`Encrypted file ${env.encryptedFile} not found for environment "${env.name}".`, {
      hint: `Run "dotenv-vault-cli encrypt -e ${env.name}" first, or pull the latest changes from Git.`,
    });
  }
  try {
    return parseEnvelope(safeReadFile(ctx.root, env.encPath));
  } catch (err) {
    if (err instanceof EnvelopeFormatError) {
      throw new VaultError(`${env.encryptedFile} is not a valid vault file: ${err.message}`);
    }
    throw err;
  }
}

function decryptOrFail(envelope, password, env) {
  try {
    return decrypt(envelope, password, { expectedEnvironment: env.name });
  } catch (err) {
    if (err instanceof DecryptionError) throw new VaultError(err.message, { exitCode: 2 });
    throw err;
  }
}

function warnIfPlaintextExposed(root, relFile) {
  const status = gitStatusOf(root, relFile);
  if (!status.inRepo) return;
  if (status.tracked) {
    log.warn(
      chalk.bold(`${relFile} is TRACKED by Git! `) +
        `Remove it with "git rm --cached ${relFile}" and consider rotating the secrets it contains.`,
    );
  } else if (!status.ignored) {
    log.warn(`${relFile} is not ignored by Git. Run "dotenv-vault-cli init" or add it to .gitignore.`);
  }
}

function summarizeDiff({ added, removed, changed }) {
  return `${added.length} added, ${removed.length} removed, ${changed.length} changed`;
}

function printDiff(diff, { addedLabel, removedLabel }) {
  for (const key of diff.added) log.info(chalk.green(`  + ${sanitizeForTerminal(key)}`) + chalk.dim(`  (${addedLabel})`));
  for (const key of diff.removed) log.info(chalk.red(`  - ${sanitizeForTerminal(key)}`) + chalk.dim(`  (${removedLabel})`));
  for (const key of diff.changed) log.info(chalk.yellow(`  ~ ${sanitizeForTerminal(key)}`) + chalk.dim('  (value differs)'));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function initCommand(opts) {
  const root = process.cwd();
  const configPath = path.join(root, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    await confirmOrAbort(`${CONFIG_FILENAME} already exists. Overwrite it?`, { force: opts.force });
  }

  let name = opts.name ?? path.basename(root);
  let environments = opts.envs ? opts.envs.split(',') : [...DEFAULT_ENVIRONMENTS];
  let defaultEnvironment = opts.defaultEnv;

  if (!opts.yes && isInteractive()) {
    const answers = await ask([
      { type: 'text', name: 'name', message: 'Vault / project name', initial: name },
      {
        type: 'list',
        name: 'environments',
        message: 'Environments (comma-separated)',
        initial: environments.join(', '),
        separator: ',',
      },
    ]);
    name = answers.name.trim();
    environments = answers.environments.map((env) => env.trim()).filter(Boolean);
    if (environments.length > 1) {
      const preferred = defaultEnvironment ?? (environments.includes('development') ? 'development' : environments[0]);
      const { selected } = await ask({
        type: 'select',
        name: 'selected',
        message: 'Default environment',
        choices: environments.map((env) => ({ title: env, value: env })),
        initial: Math.max(0, environments.indexOf(preferred)),
      });
      defaultEnvironment = selected;
    }
  }

  const config = createConfig({ name, environments, defaultEnvironment });
  saveConfig(root, config);
  log.success(`Wrote ${CONFIG_FILENAME}`);

  const plaintextFiles = Object.values(config.environments).map((env) => env.file);
  const added = ensureGitignore(root, plaintextFiles);
  if (added.length) log.success(`Updated .gitignore with: ${added.join(', ')}`);
  else log.success('.gitignore already protects plaintext env files');

  for (const file of ['.env', ...plaintextFiles]) {
    if (fs.existsSync(path.join(root, file))) warnIfPlaintextExposed(root, file);
  }

  log.info('');
  log.info(chalk.bold('Environments:'));
  for (const [envName, mapping] of Object.entries(config.environments)) {
    const marker = envName === config.defaultEnvironment ? chalk.cyan(' (default)') : '';
    log.info(`  ${envName}${marker}: ${mapping.file} -> ${mapping.encryptedFile}`);
  }
  log.info('');
  log.info(chalk.bold('Next steps:'));
  log.info(`  1. Create your local env file, e.g. ${config.environments[config.defaultEnvironment].file}`);
  log.info(`  2. dotenv-vault-cli encrypt -e ${config.defaultEnvironment}`);
  log.info(`  3. git add ${CONFIG_FILENAME} .gitignore *.enc && git commit`);
}

async function encryptCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);

  if (!fileExists(env.plainPath)) {
    throw new VaultError(`Local file ${env.file} not found for environment "${env.name}".`);
  }
  warnIfPlaintextExposed(ctx.root, env.file);
  const plaintext = safeReadFile(ctx.root, env.plainPath);

  try {
    let existing = null;
    if (fileExists(env.encPath)) {
      try {
        existing = loadEnvelope(ctx, env);
      } catch (err) {
        if (!opts.force) throw new VaultError(err.message, { hint: 'Use --force to replace it.' });
        log.warn(`Replacing unreadable ${env.encryptedFile} because --force was given.`);
      }
    }

    const password = await resolvePassword({
      flagValue: opts.password,
      flagName: '--password',
      envVar: PASSWORD_ENV,
      isNew: !existing,
      message: existing ? `Vault password for "${env.name}"` : `Choose a new vault password for "${env.name}"`,
    });

    if (existing) {
      let previous = null;
      try {
        previous = decrypt(existing, password, { expectedEnvironment: env.name });
      } catch (err) {
        if (!(err instanceof DecryptionError)) throw err;
        // Guards against a teammate accidentally splitting the vault onto a different password.
        if (!opts.force) {
          throw new VaultError(`Cannot verify the password against the existing ${env.encryptedFile}. ${err.message}`, {
            exitCode: 2,
            hint: 'To change the password use "dotenv-vault-cli rotate-key". Use --force to replace the file anyway.',
          });
        }
        assertNewPassword(password);
        log.warn(`Replacing ${env.encryptedFile} with a different password because --force was given.`);
      }

      if (previous) {
        try {
          if (buffersEqual(previous, plaintext)) {
            log.success(`${env.encryptedFile} is already up to date. Nothing to do.`);
            return;
          }
          const diff = diffEnv(parseEnv(previous), parseEnv(plaintext));
          log.info(`Changes vs. ${env.encryptedFile}: ${summarizeDiff(diff)}`);
          printDiff(diff, { addedLabel: 'new in local', removedLabel: 'will be removed from vault' });
        } finally {
          previous.fill(0);
        }
        await confirmOrAbort(`Overwrite ${env.encryptedFile} with the contents of ${env.file}?`, { force: opts.force });
      }
    }

    const envelope = encrypt(plaintext, password, { environment: env.name, sourceFile: env.file });
    safeWriteFile(ctx.root, env.encPath, serializeEnvelope(envelope), { mode: 0o644 });
    log.success(`Encrypted ${env.file} -> ${env.encryptedFile}`);
    log.dim(`Commit ${env.encryptedFile} to share it with your team.`);
  } finally {
    plaintext.fill(0);
  }
}

async function decryptCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  const envelope = loadEnvelope(ctx, env);
  const password = await resolvePassword({
    flagValue: opts.password,
    flagName: '--password',
    envVar: PASSWORD_ENV,
    message: `Vault password for "${env.name}"`,
  });
  const plaintext = decryptOrFail(envelope, password, env);

  try {
    if (fileExists(env.plainPath)) {
      const current = safeReadFile(ctx.root, env.plainPath);
      try {
        if (buffersEqual(current, plaintext)) {
          log.success(`${env.file} is already up to date. Nothing to do.`);
          return;
        }
        if (!opts.force) {
          const diff = diffEnv(parseEnv(plaintext), parseEnv(current));
          log.info(`${env.file} differs from the vault: ${summarizeDiff(diff)}`);
          printDiff(diff, { addedLabel: 'local only — will be lost', removedLabel: 'will be restored from vault' });
          await confirmOrAbort(`Overwrite local ${env.file}?`);
        }
      } finally {
        current.fill(0);
      }
    }

    safeWriteFile(ctx.root, env.plainPath, plaintext, { mode: 0o600 });
    log.success(`Decrypted ${env.encryptedFile} -> ${env.file}`);
    warnIfPlaintextExposed(ctx.root, env.file);
  } finally {
    plaintext.fill(0);
  }
}

async function rotateKeyCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  const envelope = loadEnvelope(ctx, env);

  const oldPassword = await resolvePassword({
    flagValue: opts.oldPassword,
    flagName: '--old-password',
    envVar: PASSWORD_ENV,
    message: `Current password for "${env.name}"`,
  });
  const plaintext = decryptOrFail(envelope, oldPassword, env);

  try {
    const newPassword = await resolvePassword({
      flagValue: opts.newPassword,
      flagName: '--new-password',
      envVar: NEW_PASSWORD_ENV,
      isNew: true,
      message: `New password for "${env.name}"`,
    });
    if (newPassword === oldPassword) throw new VaultError('The new password must differ from the current password.');

    const rotated = encrypt(plaintext, newPassword, { environment: env.name, sourceFile: env.file });

    // Verify the new file round-trips before replacing the old one.
    const check = decrypt(rotated, newPassword, { expectedEnvironment: env.name });
    const ok = buffersEqual(check, plaintext);
    check.fill(0);
    if (!ok) throw new VaultError('Verification of the re-encrypted data failed. The original file was not modified.');

    safeWriteFile(ctx.root, env.encPath, serializeEnvelope(rotated), { mode: 0o644 });
    log.success(`Rotated password for ${env.encryptedFile} (fresh salt and IV).`);
    log.dim('Commit the updated file and share the new password with your team over a secure channel.');
  } finally {
    plaintext.fill(0);
  }
}

async function diffCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  const envelope = loadEnvelope(ctx, env);
  const password = await resolvePassword({
    flagValue: opts.password,
    flagName: '--password',
    envVar: PASSWORD_ENV,
    message: `Vault password for "${env.name}"`,
  });
  const plaintext = decryptOrFail(envelope, password, env);

  let vaultVars;
  let localVars = {};
  try {
    vaultVars = parseEnv(plaintext);
  } finally {
    plaintext.fill(0);
  }
  const localExists = fileExists(env.plainPath);
  if (localExists) {
    const local = safeReadFile(ctx.root, env.plainPath);
    try {
      localVars = parseEnv(local);
    } finally {
      local.fill(0);
    }
  }

  const diff = diffEnv(vaultVars, localVars);
  log.info(chalk.bold(`Comparing ${env.file} (local) with ${env.encryptedFile} (vault)`));
  if (!localExists) log.warn(`${env.file} does not exist locally; treating it as empty.`);

  if (!hasDifferences(diff)) {
    log.success(`In sync (${diff.unchanged} key${diff.unchanged === 1 ? '' : 's'}).`);
    return;
  }
  printDiff(diff, { addedLabel: 'local only — not yet encrypted', removedLabel: 'vault only — missing locally' });
  log.info('');
  log.info(`${summarizeDiff(diff)}, ${diff.unchanged} unchanged`);
  if (opts.exitCode) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name('dotenv-vault-cli')
  .description('Securely sync .env environments across machines via Git using AES-256-GCM encrypted files.')
  .version(pkg.version)
  .showHelpAfterError()
  .addHelpText(
    'after',
    `\nPasswords are read from (in order): the CLI flag, $${PASSWORD_ENV} ($${NEW_PASSWORD_ENV} for rotate-key's new password), or an interactive prompt.`,
  );

program
  .command('init')
  .description(`create ${CONFIG_FILENAME} and protect plaintext env files in .gitignore`)
  .option('-n, --name <name>', 'vault / project name (default: directory name)')
  .option('--envs <list>', `comma-separated environments (default: ${DEFAULT_ENVIRONMENTS.join(',')})`)
  .option('-d, --default-env <name>', 'default environment')
  .option('-y, --yes', 'accept defaults without prompting')
  .option('-f, --force', `overwrite an existing ${CONFIG_FILENAME} without prompting`)
  .action(initCommand);

program
  .command('encrypt')
  .description('encrypt a local env file into its .enc vault file')
  .option('-e, --env <name>', 'environment name')
  .option('-p, --password <password>', 'vault password (prompted if omitted)')
  .option('-f, --force', 'overwrite without prompting, even if the password differs from the existing file')
  .action(encryptCommand);

program
  .command('decrypt')
  .description('decrypt a .enc vault file into its local env file')
  .option('-e, --env <name>', 'environment name')
  .option('-p, --password <password>', 'vault password (prompted if omitted)')
  .option('-f, --force', 'overwrite the existing local file without prompting')
  .action(decryptCommand);

program
  .command('rotate-key')
  .description('re-encrypt a vault file with a new password, salt and IV')
  .option('-e, --env <name>', 'environment name')
  .option('-o, --old-password <password>', 'current password (prompted if omitted)')
  .option('-n, --new-password <password>', 'new password (prompted if omitted)')
  .action(rotateKeyCommand);

program
  .command('diff')
  .description('compare key names between the vault and the local env file (values are never printed)')
  .option('-e, --env <name>', 'environment name')
  .option('-p, --password <password>', 'vault password (prompted if omitted)')
  .option('--exit-code', 'exit with status 1 when differences are found')
  .action(diffCommand);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof VaultError) {
    log.error(err.message);
    if (err.hint) console.error(chalk.dim(`  ${err.hint}`));
    process.exitCode = err.exitCode;
  } else {
    log.error(`Unexpected error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
}
