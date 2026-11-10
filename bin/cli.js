#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Command, InvalidArgumentError, Option } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';

import {
  CONFIG_FILENAME,
  DEFAULT_ENVIRONMENTS,
  ENV_NAME_PATTERN,
  listEnvironments,
  loadConfig,
  resolveEnvironment,
} from '../src/config.js';
import { ConfirmationRequiredError, VaultError, fileExists, hasDifferences, sanitizeForTerminal } from '../src/utils.js';
import {
  decryptEnvironment,
  diffEnvironment,
  encryptEnvironment,
  getVaultStatus,
  initVault,
  inspectVault,
  loadEnvelope,
  newPasswordProblem,
  readEnvironmentVariables,
  rotateEnvironmentKey,
  updateEnvironmentVariables,
  verifyPassword,
} from '../src/vault.js';
import { assertValidKey } from '../src/envfile.js';
import { isUiBuilt, openBrowser, startUiServer } from '../src/server.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const PASSWORD_ENV = 'DOTCRYPT_PASSWORD';
const NEW_PASSWORD_ENV = 'DOTCRYPT_NEW_PASSWORD';

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
    throw new VaultError(`${message} Confirmation required, but not running interactively.`, {
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
    if (hasDifferences(err.diff)) {
      log.info(`Changes: ${summarizeDiff(err.diff)}`);
      printDiff(err.diff, diffLabels);
    } else {
      log.info('All keys and values match; only comments or formatting differ.');
    }
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

  environments = environments.map((env) => env.trim()).filter(Boolean);
  if (environments.length === 0) throw new VaultError('At least one environment is required.');
  const invalid = environments.filter((env) => !ENV_NAME_PATTERN.test(env));
  if (invalid.length) {
    throw new VaultError(`Invalid environment name(s): ${invalid.map((env) => `"${env}"`).join(', ')}.`, {
      hint: 'Use 1-64 letters, digits, "-" or "_", starting and ending with a letter or digit.',
    });
  }
  if (defaultEnvironment !== undefined && !environments.includes(defaultEnvironment)) {
    throw new VaultError(`Default environment "${defaultEnvironment}" is not one of: ${environments.join(', ')}.`);
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
  log.info(`  2. dotcrypt encrypt -e ${config.defaultEnvironment}`);
  log.info(`  3. git add ${CONFIG_FILENAME} .gitignore *.enc && git commit`);
  log.info(`  Or run ${chalk.cyan('dotcrypt ui')} for a visual dashboard.`);
}

async function encryptCommand(opts) {
  const ctx = loadConfig();
  const env = await pickEnvironment(ctx, opts.env);
  if (!fileExists(env.plainPath)) {
    throw new VaultError(`Local file ${env.file} not found for environment "${env.name}".`);
  }

  // Inspect the existing vault file before prompting so we know whether this is a new password.
  const vaultState = inspectVault(ctx, env);
  if (vaultState.status === 'unreadable' && !opts.replace) {
    throw new VaultError(vaultState.problem, {
      hint: 'Fix the file (e.g. resolve a Git merge conflict), or use --replace to discard it and create a new one.',
    });
  }
  const hasValidVault = vaultState.status === 'valid';
  const passwordPrompted = opts.password === undefined && !process.env[PASSWORD_ENV];

  const password = await resolvePassword({
    flagValue: opts.password,
    flagName: '--password',
    envVar: PASSWORD_ENV,
    isNew: !hasValidVault,
    message: hasValidVault ? `Vault password for "${env.name}"` : `Choose a new vault password for "${env.name}"`,
  });

  const run = (replaceExisting) =>
    withOverwriteConfirmation(
      (overwrite) => encryptEnvironment(ctx, env.name, password, { overwrite, replaceExisting }),
      { force: Boolean(opts.force), diffLabels: { addedLabel: 'new in local', removedLabel: 'will be removed from vault' } },
    );

  let result;
  try {
    result = await run(vaultState.status === 'unreadable');
  } catch (err) {
    if (!(err instanceof ConfirmationRequiredError) || err.reason !== 'password-mismatch') throw err;
    if (!opts.replace) {
      throw new VaultError(err.message, {
        exitCode: 2,
        hint:
          'Check the password. To change it use "dotcrypt rotate-key"; ' +
          'to discard the existing vault file and start over use --replace.',
      });
    }
    // Replacing makes this the vault's new password, so treat it like one: a typo here would lock everyone out.
    assertNewPassword(password);
    await confirmOrAbort(
      `${env.encryptedFile} is protected by a different password. Discard it and re-encrypt ${env.file} with the password you entered?`,
      { force: opts.force },
    );
    if (passwordPrompted) {
      const { confirmation } = await ask({ type: 'password', name: 'confirmation', message: 'Re-enter the new password' });
      if (confirmation !== password) throw new VaultError('Passwords do not match. No files were changed.');
    }
    result = await run(true);
  }

  printWarnings(result.warnings);
  if (result.status === 'unchanged') {
    log.success(`${env.encryptedFile} is already up to date. Nothing to do.`);
    return;
  }
  log.success(`Encrypted ${env.file} -> ${env.encryptedFile}`);
  log.dim(`Share it with your team: ${shareCommand(env)}`);
}

function shareCommand(env) {
  return `git add ${env.encryptedFile} && git commit -m "Update ${env.name} secrets" && git push`;
}

const SYNC_TEXT = {
  synced: [chalk.green('✔'), 'Up to date'],
  'local-changes': [chalk.yellow('↑'), 'You have changes your team does not have'],
  'incoming-changes': [chalk.cyan('↓'), 'New changes from your team'],
  conflict: [chalk.red('!'), 'Changed both locally and by your team'],
  unknown: [chalk.dim('?'), 'Not checked yet on this machine'],
  'not-shared': [chalk.yellow('↑'), 'Not shared yet'],
  'not-downloaded': [chalk.cyan('↓'), 'Shared by your team, not on this machine yet'],
  empty: [chalk.dim('·'), 'No env file yet'],
  broken: [chalk.red('✖'), 'Encrypted file is unreadable'],
};

function nextStep(env) {
  const flag = `-e ${env.name}`;
  switch (env.sync) {
    case 'local-changes':
    case 'not-shared':
      return `dotcrypt encrypt ${flag}`;
    case 'incoming-changes':
    case 'not-downloaded':
      return `dotcrypt decrypt ${flag}`;
    case 'conflict':
      return `dotcrypt diff ${flag}, then keep yours (encrypt) or take theirs (decrypt)`;
    case 'unknown':
      return `dotcrypt diff ${flag}`;
    case 'empty':
      return `create ${env.file}, then dotcrypt encrypt ${flag}`;
    case 'broken':
      return env.vault.error ?? `${env.encryptedFile} belongs to "${env.vault.environment}"`;
    default:
      return null;
  }
}

function statusCommand() {
  const status = getVaultStatus(loadConfig());
  log.info(chalk.bold(status.vault.name) + chalk.dim(`  ${status.root}`));
  log.info('');
  const width = Math.max(...status.environments.map((env) => env.name.length + (env.isDefault ? 10 : 0)));
  for (const env of status.environments) {
    const share = env.vaultGit;
    const unsent = env.vault.exists && share.inRepo && (share.uncommitted || share.unpushed);
    const [icon, text] =
      env.sync === 'synced' && unsent ? [chalk.yellow('↑'), 'Encrypted, but not pushed to your team yet'] : SYNC_TEXT[env.sync];
    const label = env.isDefault ? `${env.name} ${chalk.dim('(default)')}` : env.name;
    const pad = ' '.repeat(width - env.name.length - (env.isDefault ? 10 : 0));
    log.info(`  ${icon} ${label}${pad}  ${text}`);
    const step = nextStep(env);
    if (step) log.dim(`      → ${step}`);
    if (env.git.tracked) log.warn(`    ${env.file} is TRACKED by Git! Run "git rm --cached ${env.file}" and rotate its secrets.`);
    if (unsent) {
      log.dim(`      → ${env.encryptedFile} is not pushed yet: ${share.uncommitted ? shareCommand(env) : 'git push'}`);
    }
    if (share.behind) log.dim(`      → a teammate pushed a newer ${env.encryptedFile}: git pull`);
  }
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

  const { diff, localExists, identical } = diffEnvironment(ctx, env.name, password);
  log.info(chalk.bold(`Comparing ${env.file} (local) with ${env.encryptedFile} (vault)`));
  if (!localExists) log.warn(`${env.file} does not exist locally; treating it as empty.`);

  if (!hasDifferences(diff)) {
    log.success(`In sync (${diff.unchanged} key${diff.unchanged === 1 ? '' : 's'}).`);
    if (localExists && !identical) log.dim('  Comments or formatting differ; encrypt/decrypt would still rewrite the file.');
    return;
  }
  printDiff(diff, { addedLabel: 'local only — not yet encrypted', removedLabel: 'vault only — missing locally' });
  log.info('');
  log.info(`${summarizeDiff(diff)}, ${diff.unchanged} unchanged`);
  if (opts.exitCode) process.exitCode = 1;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function vaultPassword(ctx, opts) {
  const env = await pickEnvironment(ctx, opts.env);
  loadEnvelope(ctx, env);
  const password = await resolvePassword({
    flagValue: opts.password,
    flagName: '--password',
    envVar: PASSWORD_ENV,
    message: `Vault password for "${env.name}"`,
  });
  return { env, password };
}

/** Parses KEY=value arguments. A bare KEY means "ask for the value" (hidden prompt, or stdin when piped). */
async function resolveAssignments(items) {
  const set = {};
  const asks = [];
  for (const item of items) {
    const eq = item.indexOf('=');
    const key = eq === -1 ? item : item.slice(0, eq);
    assertValidKey(key);
    if (eq === -1) asks.push(key);
    else set[key] = item.slice(eq + 1);
  }
  if (asks.length && !process.stdin.isTTY) {
    if (asks.length > 1) throw new VaultError('Only one value can be read from stdin.', { hint: 'Run one "set KEY" per variable.' });
    set[asks[0]] = await readStdin();
  } else {
    for (const key of asks) {
      const { value } = await ask({ type: 'password', name: 'value', message: `Value for ${key}` });
      set[key] = value;
    }
  }
  return set;
}

function reportVariableUpdate(env, result) {
  if (result.missing?.length) log.warn(`Not found in ${env.name}: ${result.missing.map(sanitizeForTerminal).join(', ')}`);
  if (result.status === 'unchanged') {
    log.success('Nothing changed.');
    return;
  }
  const parts = [];
  if (result.set.length) parts.push(`set ${result.set.join(', ')}`);
  if (result.unset.length) parts.push(`removed ${result.unset.join(', ')}`);
  const files = result.localUpdated ? `${env.encryptedFile} and ${env.file}` : env.encryptedFile;
  log.success(`${env.name}: ${parts.join('; ')} (updated ${files})`);
  printWarnings(result.warnings);
  log.dim(`Share it with your team: ${shareCommand(env)}`);
}

async function setCommand(assignments, opts) {
  const ctx = loadConfig();
  const set = await resolveAssignments(assignments);
  const { env, password } = await vaultPassword(ctx, opts);
  reportVariableUpdate(env, updateEnvironmentVariables(ctx, env.name, password, { set }));
}

async function unsetCommand(keys, opts) {
  keys.forEach(assertValidKey);
  const ctx = loadConfig();
  const { env, password } = await vaultPassword(ctx, opts);
  reportVariableUpdate(env, updateEnvironmentVariables(ctx, env.name, password, { unset: keys }));
}

async function getCommand(key, opts) {
  assertValidKey(key);
  const ctx = loadConfig();
  const { env, password } = await vaultPassword(ctx, opts);
  const vars = readEnvironmentVariables(ctx, env.name, password);
  if (!Object.hasOwn(vars, key)) {
    throw new VaultError(`${key} is not set in ${env.name}.`, { hint: `Set it with: dotcrypt set ${key} -e ${env.name}` });
  }
  process.stdout.write(process.stdout.isTTY ? `${vars[key]}\n` : vars[key]);
}

async function runCommand(command, opts) {
  const ctx = loadConfig();
  const { env, password } = await vaultPassword(ctx, opts);
  const vars = readEnvironmentVariables(ctx, env.name, password);

  const childEnv = { ...process.env };
  // The child gets the secrets, never the key that unlocks them.
  delete childEnv[PASSWORD_ENV];
  delete childEnv[NEW_PASSWORD_ENV];
  let injected = 0;
  for (const [key, value] of Object.entries(vars)) {
    if (!opts.override && Object.hasOwn(childEnv, key)) continue;
    childEnv[key] = value;
    injected += 1;
  }
  const skipped = Object.keys(vars).length - injected;
  if (!opts.quiet) {
    console.error(
      chalk.dim(
        `dotcrypt: injecting ${injected} variable${injected === 1 ? '' : 's'} from ${env.encryptedFile}` +
          (skipped ? ` (${skipped} already set in your shell; use --override to replace them)` : ''),
      ),
    );
  }

  const [bin, ...args] = command;
  const child = spawn(bin, args, { stdio: 'inherit', env: childEnv, shell: process.platform === 'win32' });
  const forward = (signal) => child.kill(signal);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, forward);

  const { code, signal } = await new Promise((resolve, reject) => {
    child.once('error', (err) =>
      reject(
        err.code === 'ENOENT'
          ? new VaultError(`Command not found: ${bin}`, { exitCode: 127 })
          : new VaultError(`Could not start ${bin}: ${err.message}`),
      ),
    );
    child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  }).finally(() => {
    for (const s of signals) process.off(s, forward);
  });
  process.exitCode = code ?? 128 + (os.constants.signals[signal] ?? 0);
}

async function uiCommand(opts) {
  if (!isUiBuilt()) {
    throw new VaultError('The dashboard has not been built yet.', {
      hint: 'Run "npm run build:ui" in the dotcrypt package directory.',
    });
  }
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
  .name('dotcrypt')
  .description('Securely sync .env environments across machines via Git using AES-256-GCM encrypted files.')
  .version(pkg.version, '-v, --version', 'output the version number')
  .enablePositionalOptions()
  .showHelpAfterError()
  .addHelpText(
    'after',
    `\nPasswords are read from (in order): the CLI flag, $${PASSWORD_ENV} ($${NEW_PASSWORD_ENV} for rotate-key's new password), or an interactive prompt.`,
  );

program
  .command('status')
  .description('show what changed and what to do next for each environment (no password needed)')
  .action(statusCommand);

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
  .option('-f, --force', 'overwrite the vault file without prompting')
  .option('--replace', 'discard an existing vault file that is unreadable or protected by a different password')
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
  .command('set')
  .description('set variables in the shared vault (and your local file), e.g. set API_URL=https://x')
  .argument('<KEY[=value]...>', 'variables to set; a bare KEY prompts for a hidden value or reads it from stdin')
  .option('-e, --env <name>', 'environment name')
  .option('-p, --password <password>', 'vault password (prompted if omitted)')
  .addHelpText(
    'after',
    '\nExamples:\n  $ dotcrypt set LOG_LEVEL=debug -e development\n  $ dotcrypt set STRIPE_KEY -e production        # hidden prompt, stays out of shell history\n  $ pbpaste | dotcrypt set STRIPE_KEY -e production',
  )
  .action(setCommand);

program
  .command('get')
  .description('print one variable from the shared vault')
  .argument('<KEY>', 'variable name')
  .option('-e, --env <name>', 'environment name')
  .option('-p, --password <password>', 'vault password (prompted if omitted)')
  .action(getCommand);

program
  .command('unset')
  .description('remove variables from the shared vault (and your local file)')
  .argument('<KEY...>', 'variables to remove')
  .option('-e, --env <name>', 'environment name')
  .option('-p, --password <password>', 'vault password (prompted if omitted)')
  .action(unsetCommand);

program
  .command('run')
  .description('run a command with the decrypted variables in its environment (nothing is written to disk)')
  .argument('<command...>', 'command to run, e.g. -- npm start')
  .option('-e, --env <name>', 'environment name')
  .option('-p, --password <password>', 'vault password (prompted if omitted)')
  .option('--override', 'let vault values replace variables already set in your shell')
  .option('-q, --quiet', 'do not print the injection summary')
  .passThroughOptions()
  .addHelpText(
    'after',
    `\nExamples:\n  $ dotcrypt run -e production -- npm start\n  $ ${PASSWORD_ENV}=... dotcrypt run -e staging -- node server.js`,
  )
  .action(runCommand);

program
  .command('ui')
  .description('open a local web dashboard (bound to 127.0.0.1, token-protected)')
  .addOption(new Option('--port <port>', 'port to listen on').argParser(parsePort).default(0, 'a random free port'))
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
