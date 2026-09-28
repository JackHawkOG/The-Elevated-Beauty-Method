import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const apiSource = fileURLToPath(new URL("../../artifacts/api-server/src/", import.meta.url));
const browserTests = fileURLToPath(new URL("../../artifacts/edu-portal/tests/", import.meta.url));
const suiteDirectories = ["routes", "lib"];

// Only these imports resolve to guards that validate the workspace development
// database target. A same-named local function or arbitrary import is not proof.
const liveGuards = new Map([
  ["./radiant-audit-fixtures", new Set(["requireAuditDevelopment"])],
  ["./community-fixtures", new Set(["requireCommunityDevelopment"])],
  ["./member-stories-fixtures", new Set(["requireStoryDevelopment"])],
]);
const maintenanceGuards = new Map([
  ["./radiant-audit-fixtures", "requireAuditDevelopment"],
  ["./community-fixtures", "requireCommunityDevelopment"],
  ["./member-stories-fixtures", "requireStoryDevelopment"],
  ["./member-progress-browser-environment", new Set(["progressBrowserEnvironment", "progressLeftoversEnvironment"])],
  ["./membership-counts-leftovers", "requirePaidTotalDevelopment"],
]);

function visit(node, predicate) {
  if (predicate(node)) return true;
  return ts.forEachChild(node, child => visit(child, predicate)) === true;
}

function visitOutsideFunctions(node, predicate) {
  if (ts.isFunctionLike(node)) return false;
  if (predicate(node)) return true;
  return ts.forEachChild(node, child => visitOutsideFunctions(child, predicate)) === true;
}

function calleeName(expression) {
  return ts.isIdentifier(expression) ? expression.text :
    ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
}

function bodyOf(callback, declarations) {
  if (ts.isIdentifier(callback)) return bodyOf(declarations.get(callback.text) ?? callback, declarations);
  if (ts.isFunctionDeclaration(callback) || ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    return callback.body && ts.isBlock(callback.body) ? callback.body : undefined;
  }
}

function firstGuard(body) {
  if (!body?.statements.length) return false;
  const first = body.statements[0];
  const expression = ts.isExpressionStatement(first) ? first.expression : undefined;
  const call = expression && ts.isAwaitExpression(expression) ? expression.expression : expression;
  return !!call && ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) && call.expression.text === "requireDevelopmentDatabase";
}

export function checkSuite(source, filename = "suite.test.ts") {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const dbNames = new Set();
  const workspaceDbNames = new Set();
  const dbNamespaces = new Set();
  const pgPoolConstructors = new Set();
  const declarations = new Map();
  let guardImported = false;
  let dbMocked = false;
  const tests = [];
  const setupHooks = [];
  const perTestHooks = [];
  const problems = [];

  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (module === "@workspace/db" && bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (!statement.importClause.isTypeOnly && !binding.isTypeOnly &&
              ["db", "pool"].includes(binding.propertyName?.text ?? binding.name.text)) {
            dbNames.add(binding.name.text);
            workspaceDbNames.add(binding.name.text);
          }
        }
      }
      if (module === "@workspace/db" && bindings && ts.isNamespaceImport(bindings) &&
          !statement.importClause.isTypeOnly) dbNamespaces.add(bindings.name.text);
      if (module === "pg" && bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (!statement.importClause.isTypeOnly && !binding.isTypeOnly &&
              (binding.propertyName?.text ?? binding.name.text) === "Pool") {
            pgPoolConstructors.add(binding.name.text);
          }
        }
      }
      if (module.endsWith("/test-development-database") && bindings && ts.isNamedImports(bindings)) {
        guardImported = bindings.elements.some(binding =>
          (binding.propertyName?.text ?? binding.name.text) === "requireDevelopmentDatabase" &&
          binding.name.text === "requireDevelopmentDatabase");
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          declarations.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  for (const [name, initializer] of declarations) {
    if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression) &&
        pgPoolConstructors.has(initializer.expression.text)) dbNames.add(name);
  }

  const isDbAction = node => ts.isCallExpression(node) && (
    (ts.isPropertyAccessExpression(node.expression) &&
      (ts.isIdentifier(node.expression.expression) && dbNames.has(node.expression.expression.text) ||
        ts.isPropertyAccessExpression(node.expression.expression) &&
        ts.isIdentifier(node.expression.expression.expression) &&
        dbNamespaces.has(node.expression.expression.expression.text) &&
        ["db", "pool"].includes(node.expression.expression.name.text)) &&
      ["insert", "update", "delete", "execute", "transaction", "query", "connect"].includes(node.expression.name.text)) ||
    /^ensure[A-Z].*Schema$/.test(calleeName(node.expression))
  );

  // A hoisted Vitest mock replaces the workspace DB, even if a suite imports it.
  visit(ast, node => {
    if (ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "vi" &&
        node.expression.name.text === "mock" &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "@workspace/db") dbMocked = true;
    return false;
  });
  if (dbMocked) {
    for (const name of workspaceDbNames) dbNames.delete(name);
    dbNamespaces.clear();
    if (!dbNames.size) return [];
  }

  const hasDatabaseWork = visit(ast, isDbAction);
  if (!hasDatabaseWork) return [];

  for (const statement of ast.statements) {
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const call = statement.expression;
      if (ts.isIdentifier(call.expression) && call.expression.text === "beforeAll") {
        setupHooks.push(bodyOf(call.arguments[0], declarations));
      } else if (ts.isIdentifier(call.expression) && call.expression.text === "beforeEach") {
        perTestHooks.push(bodyOf(call.arguments[0], declarations));
      } else if (ts.isIdentifier(call.expression) && ["test", "it"].includes(call.expression.text) ||
          ts.isCallExpression(call.expression) && ts.isPropertyAccessExpression(call.expression.expression) &&
          ["each", "skipIf", "runIf"].includes(call.expression.expression.name.text) &&
          ["test", "it"].includes(calleeName(call.expression.expression.expression))) {
        tests.push(bodyOf(call.arguments[1], declarations));
      }
    }
    // Only execution at module scope can run before Vitest's setup hook.
    if (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement)) {
      const initializer = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(decl => decl.initializer).filter(Boolean)
        : [statement.expression];
      if (initializer.some(expr => visitOutsideFunctions(expr, isDbAction))) {
        problems.push("database work runs at module scope before test setup");
      }
    }
  }

  if (!guardImported) problems.push("import requireDevelopmentDatabase from the shared test-development-database module");
  // Vitest runs setup hooks in registration order; a later guard cannot protect an earlier hook.
  const guardedSetup = firstGuard(setupHooks[0]);
  const guardedEach = !setupHooks.length && firstGuard(perTestHooks[0]);
  if (!guardedSetup && setupHooks.some(body => body && visit(body, isDbAction))) {
    problems.push("call requireDevelopmentDatabase() before database work in beforeAll");
  }
  if (!guardedSetup && !firstGuard(perTestHooks[0]) &&
      perTestHooks.some(body => body && visit(body, isDbAction))) {
    problems.push("call requireDevelopmentDatabase() before database work in beforeEach");
  }
  if (!guardedSetup && !guardedEach && (!tests.length ||
      tests.some(body => !body || visit(body, isDbAction) && !firstGuard(body)))) {
    problems.push("call requireDevelopmentDatabase() first in beforeAll, beforeEach, or at the start of every database test");
  }
  return problems;
}

function isLiveDatabaseModule(module) {
  return module === "@workspace/db" || /(?:^|\/)lib\/db\/src\/index(?:\.[cm]?[jt]s)?$/.test(module);
}

function isFixtureCall(node) {
  return ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === "createUser" && calleeName(node.expression.expression) === "users");
}

function isTestRegistration(call) {
  if (ts.isIdentifier(call.expression) && call.expression.text === "test") return true;
  return ts.isCallExpression(call.expression) &&
    ts.isPropertyAccessExpression(call.expression.expression) &&
    ["each", "skipIf", "runIf"].includes(call.expression.expression.name.text) &&
    calleeName(call.expression.expression.expression) === "test";
}

function firstLiveGuard(body, guards) {
  if (!body) return false;
  const statements = body.statements.filter(statement =>
    !(ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
      ts.isPropertyAccessExpression(statement.expression.expression) &&
      ts.isIdentifier(statement.expression.expression.expression) &&
      statement.expression.expression.expression.text === "test" &&
      statement.expression.expression.name.text === "setTimeout"));
  const first = statements[0];
  const expression = first && ts.isExpressionStatement(first) ? first.expression : undefined;
  const call = expression && ts.isAwaitExpression(expression) ? expression.expression : expression;
  return !!call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) &&
    guards.has(call.expression.text) && call.arguments.length === 0;
}

export function checkLiveSuite(source, filename = "browser-live.spec.ts") {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const guards = new Set();
  const declarations = new Map();
  const dbNames = new Set(["db", "pool"]);
  let usesDatabase = false;
  let usesPg = false;
  let dbMocked = false;
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text;
      if (isLiveDatabaseModule(module)) {
        usesDatabase = true;
        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
          for (const binding of statement.importClause.namedBindings.elements) {
            if (["db", "pool"].includes(binding.propertyName?.text ?? binding.name.text)) {
              dbNames.add(binding.name.text);
            }
          }
        }
      }
      if (module === "pg") usesPg = true;
      const allowed = liveGuards.get(module);
      if (allowed && statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const binding of statement.importClause.namedBindings.elements) {
          if (!statement.importClause.isTypeOnly && !binding.isTypeOnly &&
              allowed.has(binding.propertyName?.text ?? binding.name.text)) guards.add(binding.name.text);
        }
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) declarations.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          declarations.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  visit(ast, node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
        isLiveDatabaseModule(node.arguments[0].text)) usesDatabase = true;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "vi" &&
        node.expression.name.text === "mock" && node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) && isLiveDatabaseModule(node.arguments[0].text)) dbMocked = true;
    return false;
  });
  // The Clerk fixture path also writes app users through the API, even when a
  // browser spec never imports the database directly.
  const createsUser = visit(ast, isFixtureCall);
  if ((!usesDatabase || dbMocked) && !usesPg && !createsUser) return [];

  const issues = [];
  let registeredTests = 0;
  visit(ast, node => {
    if (!ts.isCallExpression(node)) return false;
    const call = node;
    const hook = ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "test" &&
      ["beforeAll", "beforeEach"].includes(call.expression.name.text);
    if (hook) {
      if (!firstLiveGuard(bodyOf(call.arguments[0], declarations), guards)) {
        issues.push(`${call.expression.name.text} must begin with a workspace development database guard`);
      }
    } else if (isTestRegistration(call)) {
      registeredTests++;
      if (!firstLiveGuard(bodyOf(call.arguments[1], declarations), guards)) {
        issues.push(`live test must call a workspace development database guard before fixture or cleanup work`);
      }
    }
    return false;
  });
  if (!registeredTests) issues.push("database fixture work has no guarded live test");
  // A setup hook cannot protect work executed while loading the spec.
  const isModuleFixtureWork = node => isFixtureCall(node) ||
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && dbNames.has(node.expression.expression.text) &&
    ["insert", "update", "delete", "execute", "transaction", "query", "connect"].includes(node.expression.name.text);
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement)) {
      const expressions = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(decl => decl.initializer).filter(Boolean)
        : [statement.expression];
      if (expressions.some(expr => visitOutsideFunctions(expr, isModuleFixtureWork))) {
        issues.push("fixture work runs at module scope before the development guard");
      }
    }
  }
  return issues;
}

// Maintenance commands are executed directly, without a Vitest/Playwright setup
// hook. Only a known imported guard called in main can protect a live DB import.
export function checkMaintenanceCommand(source, filename = "fixture-cleanup.ts") {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const guards = new Set();
  let usesDatabase = false;
  let staticDatabaseImport = false;
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (isLiveDatabaseModule(module) || module === "pg") {
      if (!statement.importClause?.isTypeOnly) {
        usesDatabase = true;
        staticDatabaseImport = true;
      }
    }
    const allowed = maintenanceGuards.get(module);
    if (allowed && statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings) && !statement.importClause.isTypeOnly) {
      for (const binding of statement.importClause.namedBindings.elements) {
        if (!binding.isTypeOnly && (allowed instanceof Set
          ? allowed.has(binding.propertyName?.text ?? binding.name.text)
          : (binding.propertyName?.text ?? binding.name.text) === allowed)) {
          guards.add(binding.name.text);
        }
      }
    }
  }
  const databaseImports = [];
  const clerkDeletions = [];
  visit(ast, node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
        (isLiveDatabaseModule(node.arguments[0].text) || node.arguments[0].text === "pg")) {
      usesDatabase = true;
      databaseImports.push(node);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "deleteUser" &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "users") {
      clerkDeletions.push(node);
    }
    return false;
  });
  if (!usesDatabase && !clerkDeletions.length) return [];
  const issues = [];
  if (staticDatabaseImport) issues.push("import the live database dynamically after the development guard");
  const main = ast.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "main");
  if (!main?.body) return [...issues, "put a workspace development database guard in main before connecting"];
  const guardStatement = main.body.statements.find(statement =>
    ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) &&
    guards.has(statement.expression.expression.text) &&
    statement.expression.arguments.length === 0);
  if (!guardStatement) return [...issues, "call an imported workspace development database guard in main"];
  // Before the guard, only argument parsing and a usage check may run.
  for (const statement of main.body.statements) {
    if (statement === guardStatement) break;
    const isArgs = ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.every(declaration =>
        !!declaration.initializer &&
        (ts.isCallExpression(declaration.initializer) &&
          (calleeName(declaration.initializer.expression) === "slice" ||
           calleeName(declaration.initializer.expression) === "confirmedRun")));
    const isUsage = ts.isIfStatement(statement) && !statement.elseStatement &&
      ts.isBlock(statement.thenStatement) &&
      statement.thenStatement.statements.length === 1 &&
      ts.isThrowStatement(statement.thenStatement.statements[0]);
    if (!isArgs && !isUsage) {
      issues.push("call the development guard before client or database work in main");
      break;
    }
  }
  if (databaseImports.some(node => {
    let parent = node.parent;
    while (parent && parent !== ast && parent !== main) {
      if (ts.isFunctionLike(parent)) return false;
      parent = parent.parent;
    }
    return parent === main && node.getStart(ast) < guardStatement.getStart(ast);
  })) {
    issues.push("open the live database only after the development guard");
  }
  // A helper can be called from main after its guard, but module-scope connection
  // work runs before main; never permit a live import at module scope.
  if (databaseImports.some(node => {
    let parent = node.parent;
    while (parent && parent !== ast) {
      if (ts.isFunctionLike(parent)) return false;
      parent = parent.parent;
    }
    return true;
  })) issues.push("do not open the live database at module scope");
  if (clerkDeletions.some(node => {
    let parent = node.parent;
    while (parent && parent !== ast) {
      if (ts.isFunctionLike(parent)) return false;
      parent = parent.parent;
    }
    return true;
  })) issues.push("do not delete Clerk users at module scope");
  return issues;
}

async function main() {
  const failures = [];
  for (const directory of suiteDirectories) {
    const folder = path.join(apiSource, directory);
    for (const name of (await readdir(folder)).filter(name => /\.test\.tsx?$/.test(name))) {
      const filename = path.join(folder, name);
      const issues = checkSuite(await readFile(filename, "utf8"), filename);
      for (const issue of issues) failures.push(`${path.relative(process.cwd(), filename)}: ${issue}`);
    }
  }
  for (const name of (await readdir(browserTests)).filter(name => /-live\.spec\.tsx?$/.test(name))) {
    const filename = path.join(browserTests, name);
    const issues = checkLiveSuite(await readFile(filename, "utf8"), filename);
    for (const issue of issues) failures.push(`${path.relative(process.cwd(), filename)}: ${issue}`);
  }
  for (const folder of [path.join(apiSource, "routes"), browserTests, path.dirname(fileURLToPath(import.meta.url))]) {
    for (const name of (await readdir(folder)).filter(name =>
      /(?:cleanup|maintenance|(?:^|-)cli)\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name))) {
      const filename = path.join(folder, name);
      const issues = checkMaintenanceCommand(await readFile(filename, "utf8"), filename);
      for (const issue of issues) failures.push(`${path.relative(process.cwd(), filename)}: ${issue}`);
    }
  }
  if (failures.length) {
    console.error(`Database safety check failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("API, live browser test, and maintenance command database safety check passed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();