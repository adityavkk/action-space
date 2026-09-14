import ts from "typescript";
import { Fault } from "../domain.js";
export function prepare(code: string, maxBytes: number): string {
  if (!code.trim() || Buffer.byteLength(code) > maxBytes)
    throw new Fault("SOURCE_LIMIT");
  const source = `const __action = async function() {\n${code}\n};`;
  const file = ts.createSourceFile(
    "agent.js",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const diagnostics =
    ts.transpileModule(source, {
      fileName: "agent.js",
      compilerOptions: { target: ts.ScriptTarget.ES2022, allowJs: true },
      reportDiagnostics: true,
    }).diagnostics ?? [];
  const statement = file.statements[0];
  if (
    diagnostics.length ||
    file.statements.length !== 1 ||
    !statement ||
    !ts.isVariableStatement(statement)
  )
    throw new Fault("INVALID_SOURCE");
  const declaration = statement.declarationList.declarations;
  if (
    declaration.length !== 1 ||
    !declaration[0]?.initializer ||
    !ts.isFunctionExpression(declaration[0].initializer)
  )
    throw new Fault("INVALID_SOURCE");
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      node.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isTypeNode(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      throw new Fault("IMPORT_OR_TYPESCRIPT_DENIED");
    ts.forEachChild(node, visit);
  }
  visit(file);
  return `(async function(){\n${code}\n})()`;
}
