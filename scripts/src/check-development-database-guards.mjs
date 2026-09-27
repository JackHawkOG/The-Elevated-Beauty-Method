import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const apiSource = fileURLToPath(new URL("../../artifacts/api-server/src/", import.meta.url));
const suiteDirectories = ["routes", "lib"];

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
  if (failures.length) {
    console.error(`Database safety check failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("API test database safety check passed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();