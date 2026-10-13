/** Type-checks TypeScript files with the compiler API (tests only). */
import ts from 'typescript';

/** The diagnostics of a program of `files` with `options`, formatted one per line. */
export function typeErrors(files: string[], options: ts.CompilerOptions): string[] {
  const program = ts.createProgram(files, { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, ...options });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file === undefined || d.start === undefined) return text;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName}:${line + 1}:${character + 1}: ${text}`;
  });
}

export const NODE_NEXT: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

export const BUNDLER: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
};
