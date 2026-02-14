/**
 * @file        CodeReviewTool.ts
 * @description Ferramenta MCP que executa o Code Review Protheus Expert para uma branch,
 *              gerando e abrindo um relatorio HTML, com complemento opcional de trechos
 *              da Normativa para as regras de violacao encontradas.
 * @author      <Bruno Santana Gomes>
 * @created     2025-01-11
 *
 * @dependencies
 *   - NormativaTool : consulta a normativa para complementar violacoes
 *   - McpTool       : interface padrao do servidor MCP para registro de ferramentas
 *   - child_process : execucao do script Python de code review
 *
 * @remarks
 *   Parte do projeto mcp-protheus-expert (MCP Server para TOTVS Protheus).
 */

import path from "path";
import { spawn } from "child_process";
import { McpTool } from "../types/McpTool.js";
import { fileURLToPath } from "url";

// Import direto do tool (mesma pasta)
import NormativaTool from "./NormativaTool.js";

/**
 * Executa um comando externo como processo filho e retorna saida completa.
 *
 * @param cmd  - Comando a executar (ex: 'git', 'python')
 * @param args - Lista de argumentos do comando
 * @param cwd  - Diretorio de trabalho para execucao
 * @returns Objeto com codigo de saida, stdout e stderr
 */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? 0, out, err }));
  });
}

/**
 * Extrai um objeto JSON da saida stdout apos o marcador "[JSON_RESULT]".
 * Busca a primeira linha que inicia com "{" apos o marcador.
 *
 * @param stdout - Saida padrao completa do processo
 * @returns Objeto JSON parseado, ou null se nao encontrado/invalido
 */
function extractJsonResult(stdout: string) {
  const marker = "[JSON_RESULT]";
  const idx = stdout.indexOf(marker);
  if (idx < 0) return null;

  const after = stdout.slice(idx + marker.length).trim();
  const firstLine = after.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (!firstLine) return null;

  try {
    return JSON.parse(firstLine);
  } catch {
    return null;
  }
}

/**
 * Extrai um bloco JSON da saida stdout apos um marcador customizado.
 * Busca a primeira linha que inicia com "[" ou "{" apos o marcador.
 *
 * @param stdout - Saida padrao completa do processo
 * @param marker - Marcador de texto que precede o bloco JSON (ex: "[JSON_VIOLATIONS]")
 * @returns Objeto ou array JSON parseado, ou null se nao encontrado/invalido
 */
function extractJsonBlock(stdout: string, marker: string) {
  const idx = stdout.indexOf(marker);
  if (idx < 0) return null;

  const after = stdout.slice(idx + marker.length).trim();
  const firstJsonLine = after
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("[") || l.trim().startsWith("{"));

  if (!firstJsonLine) return null;

  try {
    return JSON.parse(firstJsonLine);
  } catch {
    return null;
  }
}

/**
 * Definicao da ferramenta MCP de Code Review.
 * Expoe o schema de entrada e o metodo run() para o servidor MCP.
 */
const CodeReviewTool: McpTool = {
  name: "code_review_protheus",
  description:
    'Executa o Code Review Protheus Expert (gera e abre HTML) para uma branch em HML ou PRD, e complementa com trechos da Normativa para as regras encontradas.',

  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Branch para validar (ex: SPCD-1946)" },
      ambiente: { type: "string", enum: ["HML", "PRD"], description: "Ambiente do repositório local" },
      incluirNormativa: {
        type: "boolean",
        description: "Quando true, busca trechos da Normativa para as regras encontradas (limite 8).",
        default: true
      }
    },
    required: ["branch", "ambiente"],
    additionalProperties: false
  },

  async run({
    branch,
    ambiente,
    incluirNormativa = true
  }: {
    branch: string;
    ambiente: "HML" | "PRD";
    incluirNormativa?: boolean;
  }) {
    const repoPath =
      ambiente === "HML"
        ? process.env.REPO_HML
        : ambiente === "PRD"
        ? process.env.REPO_PRD
        : "";

    if (!repoPath) {
      throw new Error(
        `RepoPath não configurado para ambiente ${ambiente}. Configure REPO_${ambiente} no .env`
      );
    }

    const pythonExe = process.env.PYTHON_EXE || "python";

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Caminho do script Python (localizado em /python na raiz do projeto)
    const scriptPath = path.resolve(__dirname, "../../python/code_review_protheus.py");

    // 1) Faz fetch e checkout da branch no repositorio local
    const fetch = await runCmd("git", ["fetch", "origin"], repoPath);
    if (fetch.code !== 0) {
      throw new Error(`Falha no git fetch\n${fetch.out}\n${fetch.err}`);
    }

    const co = await runCmd("git", ["checkout", branch], repoPath);
    if (co.code !== 0) {
      throw new Error(`Falha no git checkout ${branch}\n${co.out}\n${co.err}`);
    }

    // 2) Executa o script Python de code review (compara HEAD com origin/master)
    const r = await runCmd(pythonExe, [scriptPath, repoPath], repoPath);

    const json = extractJsonResult(r.out);
    const violations = extractJsonBlock(r.out, "[JSON_VIOLATIONS]") as any[] | null;

    // 3) Monta referencia ao arquivo HTML gerado pelo script Python
    const htmlFile = json?.html_file;
    const openCmd = htmlFile ? `start "" "${htmlFile}"` : null;

    // 4) Complementa com trechos da Normativa para cada regra violada (limite de 8 regras)
    let normativaHints: any[] = [];
    if (incluirNormativa && violations && violations.length) {
      const unique = new Map<string, string>();
      for (const v of violations) {
        const id = String(v?.id || "").trim();
        const desc = String(v?.descricao || "").trim();
        if (id && !unique.has(id)) unique.set(id, desc || id);
      }

      const items = Array.from(unique.entries()).slice(0, 8);
      for (const [id, text] of items) {
        try {
          const resp = await NormativaTool.run({ question: text });
          normativaHints.push({ id, query: text, resp });
        } catch (e: any) {
          normativaHints.push({ id, query: text, error: e?.message || String(e) });
        }
      }
    }

    return {
      ok: true,
      ambiente,
      branch,
      repoPath,
      htmlFile,
      openCmd,
      summary: json ?? null,
      violations: violations ?? null,
      normativaHints,
      logs: {
        stdout_tail: r.out.slice(-4000),
        stderr_tail: r.err.slice(-4000)
      }
    };
  }
};

export default CodeReviewTool;
