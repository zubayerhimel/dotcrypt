#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';

import { CONFIG_FILENAME, DEFAULT_ENVIRONMENTS, listEnvironments, loadConfig, resolveEnvironment } from '../src/config.js';
import { ConfirmationRequiredError, VaultError, fileExists, hasDifferences, sanitizeForTerminal } from '../src/utils.js';
import {
  decryptEnvironment,
  diffEnvironment,
  encryptEnvironment,
  initVault,
  loadEnvelope,
  newPasswordProblem,
  rotateEnvironmentKey,
  verifyPassword,
} from '../src/vault.js';
import { openBrowser, startUiServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const PASSWORD_ENV = 'DOTENV_VAULT_PASSWORD';
const NEW_PASSWORD_ENV = 'DOTENV_VAULT_NEW_PASSWORD';

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

function summarizeDiff({ added, removed, changed }) {
  return `${added.length} added, ${removed.length} removed, ${changed.length} changed`;
}

function printDiff(diff, { addedLabel, removedLabel }) {
  for (const key of diff.added) log.info(chalk.green(`  + ${sanitizeForTerminal(key)}`) + chalk.dim(`  (${addedLabel})`));
  for (const key of diff.removed) log.info(chalk.red(`  - ${sanitizeForTerminal(key)}`) + chalk.dim(`  (${removedLabel})`));
  for (const key of diff.changed) log.info(chalk.yellow(`  ~ ${sanitizeForTerminal(key)}`) + chalk.dim('  (value differs)'));
}

function printWarnings(warnings = []) {
  for (const warning of warnings) log.warn(warning);
}

/** Runs an operation; on an "overwrite" confirmation, shows the key diff, asks, and retries with overwrite. */
async function withOverwriteConfirmation(run, { force, diffLabels }) {
  try {
    return run(force);
  } catch (err) {
    if (!(err instanceof ConfirmationRequiredError) || err.reason !== 'overwrite') throw err;
    log.info(`Changes: ${summarizeDiff(err.diff)}`);
    printDiff(err.diff, diffLabels);
    await confirmOrAbort(err.message);
    return run(true);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function initCommand(opts) {
  const root = process.cwd();
  let overwrite = Boolean(opts.force);
  if (fs.existsSync(path.join(root, CONFIG_FILENAME))) {
    await confirmOrAbort(`${CONFIG_FILENAME} already exists. Overwrite it?`, { force: opts.force });
    overwrite = true;
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

  const { config, gitignoreAdded, warnings } = initVault(root, { name, environments, defaultEnvironment, overwrite });
  log.success(`Wrote ${CONFIG_FILENAME}`);
  if (gitignoreAdded.length) log.success(`Updated .gitignore with: ${gitignoreAdded.join(', ')}`);
  else log.success('.gitignore already protects plaintext env files');
  printWarnings(warnings);

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
  log.info(`  Or run ${chalk.cyan('dotenv-vault-cli ui')} for a visual dashboard.`);
}

async function encryptCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  if (!fileExists(env.plainPath)) {
    throw new VaultError(`Local file ${env.file} not found for environment "${env.name}".`);
  }

  // Inspect the existing vault file before prompting so we know whether this is a new password.
  let hasValidVault = false;
  if (fileExists(env.encPath)) {
    try {
      loadEnvelope(ctx, env);
      hasValidVault = true;
    } catch (err) {
      if (!opts.force) throw new VaultError(err.message, { hint: 'Use --force to replace it.' });
    }
  }

  const password = await resolvePassword({
    flagValue: opts.password,
    flagName: '--password',
    envVar: PASSWORD_ENV,
    isNew: !hasValidVault,
    message: hasValidVault ? `Vault password for "${env.name}"` : `Choose a new vault password for "${env.name}"`,
  });

  let result;
  try {
    result = await withOverwriteConfirmation(
      (overwrite) => encryptEnvironment(ctx, env.name, password, { overwrite, replaceExisting: Boolean(opts.force) }),
      { force: Boolean(opts.force), diffLabels: { addedLabel: 'new in local', removedLabel: 'will be removed from vault' } },
    );
  } catch (err) {
    if (err instanceof ConfirmationRequiredError && err.reason === 'password-mismatch') {
      throw new VaultError(err.message, {
        exitCode: 2,
        hint: 'To change the password use "dotenv-vault-cli rotate-key". Use --force to replace the file anyway.',
      });
    }
    throw err;
  }

  printWarnings(result.warnings);
  if (result.status === 'unchanged') {
    log.success(`${env.encryptedFile} is already up to date. Nothing to do.`);
    return;
  }
  log.success(`Encrypted ${env.file} -> ${env.encryptedFile}`);
  log.dim(`Commit ${env.encryptedFile} to share it with your team.`);
}

async function decryptCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  loadEnvelope(ctx, env); // fail fast before asking for a password
  const password = await resolvePassword({
    flagValue: opts.password,
    flagName: '--password',
    envVar: PASSWORD_ENV,
    message: `Vault password for "${env.name}"`,
  });

  const result = await withOverwriteConfirmation(
    (overwrite) => decryptEnvironment(ctx, env.name, password, { overwrite }),
    {
      force: Boolean(opts.force),
      diffLabels: { addedLabel: 'local only — will be lost', removedLabel: 'will be restored from vault' },
    },
  );

  if (result.status === 'unchanged') log.success(`${env.file} is already up to date. Nothing to do.`);
  else log.success(`Decrypted ${env.encryptedFile} -> ${env.file}`);
  printWarnings(result.warnings);
}

async function rotateKeyCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  loadEnvelope(ctx, env);

  const oldPassword = await resolvePassword({
    flagValue: opts.oldPassword,
    flagName: '--old-password',
    envVar: PASSWORD_ENV,
    message: `Current password for "${env.name}"`,
  });
  verifyPassword(ctx, env.name, oldPassword);

  const newPassword = await resolvePassword({
    flagValue: opts.newPassword,
    flagName: '--new-password',
    envVar: NEW_PASSWORD_ENV,
    isNew: true,
    message: `New password for "${env.name}"`,
  });

  rotateEnvironmentKey(ctx, env.name, oldPassword, newPassword);
  log.success(`Rotated password for ${env.encryptedFile} (fresh salt and IV).`);
  log.dim('Commit the updated file and share the new password with your team over a secure channel.');
}

async function diffCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  loadEnvelope(ctx, env);
  const password = await resolvePassword({
    flagValue: opts.password,
    flagName: '--password',
    envVar: PASSWORD_ENV,
    message: `Vault password for "${env.name}"`,
  });

  const { diff, localExists } = diffEnvironment(ctx, env.name, password);
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

async function uiCommand(opts) {
  const timestamp = () => new Date().toLocaleTimeString();
  const ui = await startUiServer({
    port: opts.port,
    onLog: (msg) => log.dim(`[${timestamp()}] ${sanitizeForTerminal(msg)}`),
  });

  log.success(`Dashboard running for ${ui.projectDir}`);
  log.info(`  ${chalk.cyan(ui.url)}`);
  log.dim('  The URL contains a secret session token. Do not share it. Press Ctrl+C to stop.');
  if (opts.open) openBrowser(ui.url);

  await new Promise((resolve) => {
    const stop = () => {
      log.dim('\nStopping dashboard…');
      ui.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InvalidArgumentError('Port must be 0-65535.');
  return port;
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

program
  .command('ui')
  .description('open a local web dashboard (bound to 127.0.0.1, token-protected)')
  .option('--port <port>', 'port to listen on (default: a random free port)', parsePort, 0)
  .option('--no-open', 'do not open the browser automatically')
  .action(uiCommand);

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
