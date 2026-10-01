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
  if (!callback) return undefined;
  if (ts.isIdentifier(callback)) {
    const declaration = declarations.get(callback.text);
    return declaration && declaration !== callback ? bodyOf(declaration, declarations) : undefined;
  }
  if (ts.isFunctionDeclaration(callback) || ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    return callback.body;
  }
}

function firstGuard(body) {
  if (!body?.statements?.length) return false;
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
  if (ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "test" &&
      ["only", "skip", "fixme"].includes(call.expression.name.text) && call.arguments[1] &&
      (ts.isArrowFunction(call.arguments[1]) || ts.isFunctionExpression(call.arguments[1]) ||
        ts.isIdentifier(call.arguments[1]))) return true;
  return ts.isCallExpression(call.expression) &&
    ts.isPropertyAccessExpression(call.expression.expression) &&
    ["each", "skipIf", "runIf"].includes(call.expression.expression.name.text) &&
    calleeName(call.expression.expression.expression) === "test";
}

function firstLiveGuard(body, guards) {
  if (!body?.statements) return false;
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

const browserActions = new Set([
  "click", "dblclick", "fill", "check", "uncheck", "setChecked", "selectOption",
  "press", "pressSequentially", "type", "tap", "dragTo", "dispatchEvent",
  "evaluate", "evaluateHandle",
]);
const writeMethods = new Set(["post", "put", "patch", "delete"]);

function isHttpWrite(node) {
  if (!ts.isCallExpression(node)) return false;
  if (writeMethods.has(calleeName(node.expression)) && ts.isPropertyAccessExpression(node.expression) &&
      /^(?:request|api|apiContext|apiRequest|requestContext)$/.test(calleeName(node.expression.expression))) return true;
  if (calleeName(node.expression) !== "fetch") return false;
  // A dynamic fetch method cannot be proven read-only.
  const options = node.arguments[1];
  if (!options) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  return options.properties.some(property =>
    ts.isSpreadAssignment(property) ||
    property.name && ts.isComputedPropertyName(property.name) ||
    property.name && (calleeName(property.name) === "method" ||
      ts.isStringLiteral(property.name) && property.name.text === "method") &&
      !ts.isPropertyAssignment(property) ||
    ts.isPropertyAssignment(property) &&
      (calleeName(property.name) === "method" || ts.isStringLiteral(property.name) && property.name.text === "method") &&
      (!ts.isStringLiteral(property.initializer) ||
        !["GET", "HEAD", "OPTIONS"].includes(property.initializer.text.toUpperCase())));
}

function isBrowserAction(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    browserActions.has(node.expression.name.text);
}

// Only a complete, non-forwarding API interception is evidence of mock-only UI
// work. A single endpoint mock (or a route.fetch/continue fallback) is not.
function isBlockingApiMock(statement, declarations) {
  const expression = ts.isExpressionStatement(statement) ? statement.expression : undefined;
  const call = expression && ts.isAwaitExpression(expression) ? expression.expression : undefined;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "route" || !ts.isIdentifier(call.expression.expression) ||
      !["page", "context"].includes(call.expression.expression.text) ||
      call.arguments.length !== 2) return false;
  const pattern = call.arguments[0];
  if (!pattern || !ts.isStringLiteral(pattern) ||
      !["**/api/**", "**/*"].includes(pattern.text)) return false;
  const callback = ts.isIdentifier(call.arguments[1])
    ? declarations.get(call.arguments[1].text) : call.arguments[1];
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return false;
  const parameter = callback.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return false;
  const body = callback.body;
  const terminal = node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === parameter.text &&
    ["fulfill", "abort"].includes(node.expression.name.text) &&
    !node.arguments.some(argument => visit(argument, child => ts.isCallExpression(child)));
  // Require a direct terminal call, not one hidden in a conditional branch.
  const unwrap = node => ts.isAwaitExpression(node) ? node.expression : node;
  const blocking = !ts.isBlock(body) ? terminal(unwrap(body)) : body.statements.length === 1 &&
    (ts.isExpressionStatement(body.statements[0]) && terminal(unwrap(body.statements[0].expression)) ||
      ts.isReturnStatement(body.statements[0]) && !!body.statements[0].expression &&
      terminal(unwrap(body.statements[0].expression)));
  return blocking ? call.expression.expression.text : false;
}

function actionRoot(node) {
  let expression = node.expression;
  while (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression) || ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return ts.isIdentifier(expression) ? expression.text : "";
}

function hasBrowserWrites(body, declarations, seen = new Set()) {
  if (!body || seen.has(body)) return false;
  seen.add(body);
  const mockedReceivers = new Set();
  for (const statement of ts.isBlock(body) ? body.statements : [body]) {
    const mockReceiver = isBlockingApiMock(statement, declarations);
    if (mockReceiver) {
      mockedReceivers.add(mockReceiver);
      // A context mock also covers its standard Playwright page fixture. Other
      // pages/locators are uncertain without data-flow analysis: require a guard.
      if (mockReceiver === "context") mockedReceivers.add("page");
      continue;
    }
    // A local helper may change routing. Do not let an isolation assumption
    // survive a helper invocation without proving its effects on every path.
    if (visit(statement, node => ts.isCallExpression(node) &&
        (["route", "unroute", "unrouteAll"].includes(calleeName(node.expression)) ||
          ts.isIdentifier(node.expression) && !!bodyOf(declarations.get(node.expression.text), declarations)))) {
      mockedReceivers.clear();
    }
    if (visit(statement, node => {
      if (isHttpWrite(node)) return true; // APIRequestContext bypasses page.route.
      if (isBrowserAction(node) && !mockedReceivers.has(actionRoot(node))) return true;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const helper = bodyOf(declarations.get(node.expression.text), declarations);
        if (helper && hasBrowserWrites(helper, declarations, seen)) return true;
      }
      return false;
    })) return true;
  }
  return false;
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
  const browserWrites = visit(ast, node => {
    if (!ts.isCallExpression(node)) return false;
    if (isTestRegistration(node)) return hasBrowserWrites(bodyOf(node.arguments[1], declarations), declarations);
    if (ts.isPropertyAccessExpression(node.expression) &&
        calleeName(node.expression.expression) === "test" &&
        ["beforeAll", "beforeEach", "afterAll", "afterEach"].includes(node.expression.name.text)) {
      return hasBrowserWrites(bodyOf(node.arguments[0], declarations), declarations);
    }
    return false;
  });
  const moduleWrites = ast.statements.some(statement =>
    (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement)) &&
    visitOutsideFunctions(statement, node => isHttpWrite(node) || isBrowserAction(node)));
  if ((!usesDatabase || dbMocked) && !usesPg && !createsUser && !browserWrites && !moduleWrites) return [];

  const issues = [];
  let registeredTests = 0;
  visit(ast, node => {
    if (!ts.isCallExpression(node)) return false;
    const call = node;
    const hook = ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "test" &&
      ["beforeAll", "beforeEach", "afterAll", "afterEach"].includes(call.expression.name.text);
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
  const isModuleFixtureWork = node => isFixtureCall(node) || isHttpWrite(node) || isBrowserAction(node) ||
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