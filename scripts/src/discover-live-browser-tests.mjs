import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { minimatch } from "minimatch";

const selectionKeys = new Set(["testDir", "testMatch", "testIgnore", "projects"]);

// Read selection only; never import a config or execute a spec while checking
// safety. Unknown selection expressions must fail, not silently omit files.
async function readSelection(filename, stack = new Set()) {
  if (stack.has(filename)) throw new Error(`Circular live configuration: ${filename}`);
  const nextStack = new Set([...stack, filename]);
  const source = await readFile(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot safely parse live configuration: ${filename}`);
  const imports = new Map();
  const declarations = new Map();
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.name &&
        ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.set(statement.importClause.name.text, statement.moduleSpecifier.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          declarations.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }
  const unsupported = () => {
    throw new Error(`Cannot safely discover live browser tests from ${filename}: unsupported selection expression`);
  };
  function value(node, seen = new Set()) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return value(node.expression, seen);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isRegularExpressionLiteral(node)) {
      const end = node.text.lastIndexOf("/");
      return new RegExp(node.text.slice(1, end), node.text.slice(end + 1));
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(element => value(element, seen));
    if (ts.isIdentifier(node) && declarations.has(node.text) && !seen.has(node.text)) {
      return value(declarations.get(node.text), new Set([...seen, node.text]));
    }
    return unsupported();
  }
  async function selection(node, seen = new Set()) {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return selection(node.expression, seen);
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      if (declarations.has(node.text)) {
        return selection(declarations.get(node.text), new Set([...seen, node.text]));
      }
      const module = imports.get(node.text);
      if (module?.startsWith(".")) {
        let target = path.resolve(path.dirname(filename), module);
        if (!/\.[cm]?[jt]sx?$/.test(target)) target += ".ts";
        return readSelection(target, nextStack);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "defineConfig" && node.arguments.length) {
      const result = {};
      for (const argument of node.arguments) Object.assign(result, await selection(argument, seen));
      return result;
    }
    if (!ts.isObjectLiteralExpression(node)) return unsupported();
    const result = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        Object.assign(result, await selection(property.expression, seen));
        continue;
      }
      if (!property.name || ts.isComputedPropertyName(property.name)) return unsupported();
      const key = property.name.text;
      if (!selectionKeys.has(key)) continue;
      const expression = ts.isPropertyAssignment(property) ? property.initializer :
        ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      if (!expression) return unsupported();
      if (key === "projects") {
        if (!ts.isArrayLiteralExpression(expression)) return unsupported();
        result.projects = await Promise.all(expression.elements.map(element => selection(element, seen)));
      } else {
        result[key] = value(expression);
        if (key === "testDir") {
          if (typeof result[key] !== "string") return unsupported();
        }
      }
    }
    return result;
  }
  const exported = ast.statements.find(statement => ts.isExportAssignment(statement) && !statement.isExportEquals);
  if (!exported) return unsupported();
  return selection(exported.expression);
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") files.push(...await filesUnder(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function matches(filename, patterns) {
  return (Array.isArray(patterns) ? patterns : [patterns]).some(pattern => {
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(filename);
    }
    if (typeof pattern !== "string") throw new Error("Unsupported live browser test pattern");
    return minimatch(filename, pattern.startsWith("**/") ? pattern : `**/${pattern}`,
      { nocase: true, dot: true });
  });
}

export async function discoverLiveBrowserTests(root) {
  const selected = new Set();
  const browserDirectory = path.join(root, "artifacts/edu-portal/tests");
  // Preserve coverage of legacy live specs, even if no configuration selects them.
  for (const filename of await filesUnder(browserDirectory)) {
    if (/-live\.spec\.tsx?$/.test(filename)) selected.add(filename);
  }
  for (const name of (await readdir(root)).filter(name => /^playwright\..*-live\.config\.ts$/.test(name))) {
    const config = await readSelection(path.join(root, name));
    for (const project of config.projects ?? [{}]) {
      const selection = { ...config, ...project };
      // Playwright resolves inherited relative paths against the entry config,
      // not the module that originally declared the selection.
      const directory = path.resolve(root, selection.testDir ?? ".");
      for (const filename of await filesUnder(directory)) {
        if (matches(filename, selection.testMatch ?? "**/*.@(spec|test).?(c|m)[jt]s?(x)") &&
            !matches(filename, selection.testIgnore ?? [])) selected.add(filename);
      }
    }
  }
  return [...selected].sort();
}