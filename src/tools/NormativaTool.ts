/**
 * @file        NormativaTool.ts
 * @description Ferramenta MCP que consulta a Normativa de desenvolvimento (.docx),
 *              recortando as secoes de "Regras para Desenvolvimento" (topicos 3 ate 4.99)
 *              e retornando trechos relevantes para uma pergunta.
 * @author      <Bruno Santana Gomes>
 * @created     2025-01-11
 *
 * @dependencies
 *   - mammoth : extracao de texto bruto de arquivos .docx
 *   - McpTool : interface padrao do servidor MCP para registro de ferramentas
 *
 * @remarks
 *   Parte do projeto mcp-protheus-expert (MCP Server para TOTVS Protheus).
 */

import fs from "fs";
import path from "path";
import mammoth from "mammoth";
import { fileURLToPath } from "url";
import { McpTool } from "../types/McpTool.js";

/** Secao de desenvolvimento extraida do documento normativo */
type DevSection = {
  /** Titulo da secao */
  title: string;
  /** Texto completo da secao */
  text: string;
};

/**
 * Normaliza uma string para comparacao: minusculas, sem acentos, espacos simplificados.
 *
 * @param s - String a normalizar
 * @returns String normalizada para busca/comparacao
 */
function normalize(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza texto extraido de documento Word: unifica quebras de linha,
 * remove espacos nao-quebraveis e reduz linhas em branco consecutivas.
 *
 * @param raw - Texto bruto extraido pelo mammoth
 * @returns Texto limpo e normalizado
 */
function normalizeDocText(raw: string): string {
  return (raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Resolve o caminho raiz do projeto a partir da localizacao deste arquivo.
 * Sobe dois niveis a partir de dist/tools/ para chegar a raiz do projeto.
 *
 * @returns Caminho absoluto da raiz do projeto
 */
function getProjectRootFromThisFile(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const maybeProject = path.resolve(__dirname, "../..");
  return path.resolve(maybeProject, "..");
}

/**
 * Resolve o caminho do arquivo .docx da normativa.
 * Prioriza a variavel de ambiente NORMATIVE_DOCX_PATH; caso nao definida,
 * busca automaticamente na pasta "normative/" da raiz do projeto.
 *
 * @returns Caminho absoluto do arquivo .docx da normativa
 * @throws Error se a pasta ou arquivo nao for encontrado
 */
function resolveNormativeDocxPath(): string {
  const envPath = process.env.NORMATIVE_DOCX_PATH?.trim();
  if (envPath) return envPath;

  const projectRoot = getProjectRootFromThisFile();
  const normativeDir = path.resolve(projectRoot, "normative");

  if (!fs.existsSync(normativeDir)) {
    throw new Error(`Pasta não encontrada: ${normativeDir} (projectRoot=${projectRoot})`);
  }

  const docxs = fs.readdirSync(normativeDir).filter((f) => f.toLowerCase().endsWith(".docx"));

  if (docxs.length === 0) {
    throw new Error(`Nenhum .docx encontrado em: ${normativeDir}`);
  }

  const preferred =
    docxs.find((f) => normalize(f).includes("normativ")) ||
    docxs.find((f) => normalize(f).includes("normativa")) ||
    docxs[0];

  return path.resolve(normativeDir, preferred);
}

/** Informacoes de debug do recorte de texto */
type CutDebug = Record<string, unknown>;

/** Resultado do recorte de secao de desenvolvimento: sucesso com chunk ou falha com erro */
type CutResult =
  | {
      ok: true;
      chunk: string;
      startIndex: number;
      endIndex: number;
      strategy: string;
      debug?: CutDebug;
    }
  | {
      ok: false;
      error: string;
      debug?: CutDebug;
    };

/**
 * Gera regex para detectar titulo de capitulo numerado no texto extraido.
 * Aceita variacoes de pontuacao apos o numero (ponto, parentese, dois-pontos, hifen).
 *
 * @param n - Numero do capitulo
 * @returns RegExp que detecta o inicio do capitulo
 */
function chapterHeadingRe(n: number): RegExp {
  // Aceita: "5.", "5 -", "5 ?", "5:", "5)" ou "5 " (sem pontuação)
  return new RegExp(`(^|\\n)\\s*${n}\\s*(?:[\\.|\\)|:|-|?|?])?\\s+`, "im");
}

/**
 * Corrige numeracao de lista quando o mammoth reseta a numeracao multinivel.
 * Se o chunk tiver muitos "1.x" e quase nenhum "3.x", re-etiqueta "1.x" para "3.x".
 * Nao mexe em 10.x etc.
 *
 * @param chunk - Trecho de texto a verificar e possivelmente corrigir
 * @returns Objeto com texto corrigido, flag indicando se a correcao foi aplicada e estatisticas
 */
function fixListNumberingIfNeeded(chunk: string): { text: string; applied: boolean; stats: any } {
  const text = chunk;

  const count = (re: RegExp) => (text.match(re) || []).length;

  // Comeco de linha: "1.1", "1.2" etc.
  const oneDot = count(/(^|\n)\s*1\.\d+\b/gm);
  const threeDot = count(/(^|\n)\s*3\.\d+\b/gm);

  // Heuristica: muitos 1.x e quase nenhum 3.x -> provavelmente era 3.x no doc
  const shouldFix = oneDot >= 3 && threeDot <= 1;

  if (!shouldFix) {
    return { text, applied: false, stats: { oneDot, threeDot } };
  }

  const fixed = text.replace(/(^|\n)(\s*)1\.(\d+\b)/gm, (_m, p1, p2, p3) => `${p1}${p2}3.${p3}`);

  return { text: fixed, applied: true, stats: { oneDot, threeDot } };
}

/**
 * Recorte robusto do trecho de "Regras para Desenvolvimento" baseado em titulos.
 * Estrategias em ordem: titulo exato, fallback para capitulo 3.
 * Fim: inicio do capitulo 4 (Protheus + S.O. LINUX) ou capitulo 5.
 *
 * @param fullText - Texto completo extraido do documento
 * @returns CutResult com o chunk recortado em caso de sucesso, ou erro com debug
 */
function cutDevelopmentChunk(fullText: string): CutResult {
  const text = normalizeDocText(fullText);

  // Inicio por titulo (mesmo se "3." virar outra coisa)
  const startByTitle = /(^|\n)\s*(?:3\s*(?:[\.|\)|:|-|?|?])?\s*)?regras[\s\n]+para[\s\n]+desenvolvimento\s*:?\s*(\n|$)/im;

  // Fim por titulo do capitulo 4 (muito mais estavel que "4.")
  const endByLinuxTitle =
    /(^|\n)\s*(?:4\s*(?:[\.|\)|:|-|?|?])?\s*)?regras[\s\n]+para[\s\n]+desenvolvimento[\s\n]+protheus[\s\n]*\+[\s\n]*s\.?o\.?\s*linux\b/im;

  const endBy5 = chapterHeadingRe(5);

  let startMatch = startByTitle.exec(text);
  let strategy = "title_start";
  if (!startMatch || startMatch.index == null) {
    const start3 = chapterHeadingRe(3);
    startMatch = start3.exec(text);
    strategy = "chapter3_fallback";
  }

    if (!startMatch || startMatch.index == null) {
    return {
      ok: false,
      error:
        "Não consegui localizar o início das regras de desenvolvimento no texto extraído (nem por título, nem por capítulo).",
      debug: { hint: "Pode haver formatação como tabelas/caixas de texto/listas multinível que o mammoth extrai diferente." },
    };
  }

  const startIndex = startMatch.index + (startMatch[1] ? startMatch[1].length : 0);
  const after = text.slice(startIndex);

  const eLinux = endByLinuxTitle.exec(after);
  const e5 = endBy5.exec(after);

  // Escolhe o primeiro fim valido (o mais cedo)
  const ends = [eLinux, e5].filter(Boolean) as RegExpExecArray[];
  const endIndex = ends.length ? startIndex + Math.min(...ends.map((m) => m.index)) : text.length;

  const chunk = text.slice(startIndex, endIndex).trim();
  if (!chunk) {
    return {
      ok: false,
      error: "Localizei o início das regras, mas o recorte resultou vazio.",
      debug: { strategy, startIndex, endIndex },
    };
  }

  return { ok: true, chunk, startIndex, endIndex, strategy };
}

/**
 * Pontua um trecho de texto por relevancia em relacao a uma consulta.
 * Tokeniza a consulta e soma pontos por cada token encontrado no trecho.
 *
 * @param chunk - Trecho de texto a pontuar
 * @param query - Pergunta ou consulta do usuario
 * @returns Pontuacao numerica (maior = mais relevante)
 */
function scoreChunk(chunk: string, query: string): number {
  const q = normalize(query);
  const c = normalize(chunk);

  if (!q || !c) return 0;

  const tokens = q
    .split(" ")
    .filter((t) => t.length >= 3)
    .slice(0, 20);

  let score = 0;
  for (const t of tokens) {
    if (c.includes(t)) score += 2;
  }
  if (c.includes(q)) score += 10;

  return score;
}

/**
 * Seleciona os melhores trechos de texto para responder a uma pergunta.
 * Divide o texto em blocos (por paragrafos), pontua cada um e retorna os top 5.
 *
 * @param text     - Texto completo da secao de desenvolvimento
 * @param question - Pergunta do usuario
 * @returns Lista dos 5 trechos mais relevantes (pode ser menos se nao houver)
 */
function pickBestExcerpts(text: string, question: string) {
  const blocks = text
    .split(/\n\s*\n/g)
    .map((b) => b.trim())
    .filter(Boolean);

  const ranked = blocks
    .map((b) => ({ b, s: scoreChunk(b, question) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);

  return ranked.map((x) => x.b);
}

/**
 * Definicao da ferramenta MCP de consulta a Normativa.
 * Expoe o schema de entrada e o metodo run() para o servidor MCP.
 */
export const NormativaTool: McpTool = {
  name: "normativa",
  description:
    "Consulta a Normativa (.docx) apenas nas seções de Desenvolvimento (tópicos 3 até 4.99). Retorna trechos relevantes.",

  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Pergunta sobre a normativa (somente desenvolvimento)" },
    },
    required: ["question"],
    additionalProperties: false,
  },

  async run({ question }: { question: string }) {
    const docxPath = resolveNormativeDocxPath();

    if (!fs.existsSync(docxPath)) {
      throw new Error(`Arquivo .docx não encontrado: ${docxPath}`);
    }

    const { value } = await mammoth.extractRawText({ path: docxPath });
    const fullTextRaw = (value || "").trim();

    if (!fullTextRaw) {
      throw new Error("O .docx foi lido, mas não retornou texto (vazio).");
    }

    const cut = cutDevelopmentChunk(fullTextRaw);

    if (!cut.ok) {
      return {
        ok: false,
        file: docxPath,
        message:
          "Não consegui localizar a seção de Desenvolvimento para recortar (3 até 4.99). Verifique o texto extraído do DOCX.",
        debug: cut.debug,
      };
    }

    // Corrige a numeracao interna (quando o mammoth 'resetar' para 1.x)
    const numberingFix = fixListNumberingIfNeeded(cut.chunk);
    const devText = numberingFix.text;

    const devSections: DevSection[] = [
      {
        title: "Seções 3 até 4.99 (Desenvolvimento)",
        text: devText,
      },
    ];

    const excerpts = pickBestExcerpts(devText, question);

    return {
      ok: true,
      file: docxPath,
      scope: "topicos_3_ate_4_99",
      question,
      sections: devSections.map((s) => ({
        title: s.title,
        chars: s.text.length,
      })),
      debug: {
        sliceStrategy: cut.strategy,
        startIndex: cut.startIndex,
        endIndex: cut.endIndex,
        numberingFixApplied: numberingFix.applied,
        numberingFixStats: numberingFix.stats,
      },
      answer:
        excerpts.length > 0
          ? "Encontrei estes trechos da normativa (somente desenvolvimento) relacionados à sua pergunta:"
          : "Não encontrei trechos claramente relevantes dentro das seções 3 até 4.99.",
      excerpts,
    };
  },
};

export default NormativaTool;
