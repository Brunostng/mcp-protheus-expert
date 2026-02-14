/**
 * @file        TotvsTdnTool.ts
 * @description Ferramenta MCP que consulta a documentacao oficial TOTVS no TDN
 *              (TOTVS Developer Network), retornando resumo nao-tecnico, resumo
 *              tecnico e exemplos de codigo para funcoes e classes do Protheus.
 * @author      <Bruno Santana Gomes>
 * @created     2025-01-11
 *
 * @dependencies
 *   - axios   : requisicoes HTTP para buscar paginas do TDN
 *   - cheerio : parser HTML para extrair conteudo estruturado das paginas
 *   - McpTool : interface padrao do servidor MCP para registro de ferramentas
 *
 * @remarks
 *   Parte do projeto mcp-protheus-expert (MCP Server para TOTVS Protheus).
 */

import axios from "axios";
import { load } from "cheerio";
import { McpTool } from "../types/McpTool.js";

/** Resultado de uma consulta ao TDN */
type TdnResult = {
  /** Indica se a consulta obteve sucesso */
  ok: boolean;
  /** Titulo da pagina encontrada no TDN */
  title?: string;
  /** Resumo nao-tecnico (para leigos) */
  summary?: string;
  /** Resumo tecnico detalhado */
  technical?: string;
  /** Exemplos de codigo extraidos */
  examples?: string[];
  /** Links de referencia */
  links?: string[];
  /** Texto bruto dos primeiros paragrafos */
  rawExtract?: string;
  /** Mensagem de erro quando ok=false */
  message?: string;
};

/** URL base do espaco "framework" no TDN (documentacao publica da TOTVS) */
const BASE_FRAMEWORK =
  "https://tdn.totvs.com/display/public/framework";

/**
 * Definicao da ferramenta MCP de consulta ao TDN.
 * Expoe o schema de entrada e o metodo run() para o servidor MCP.
 */
export const TotvsTdnTool: McpTool = {
  name: "Totvs_Tdn_Consulta",
  description:
    "Consulta documentação oficial TOTVS (TDN) sobre Protheus, Framework, classes e funções padrão. Retorna explicação não técnica, técnica e exemplos.",

  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Nome da função/classe Protheus (ex: FwTemporaryTable, FWFormView, FWAdapterBase)",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },

  async run({ query }: { query: string }): Promise<TdnResult> {
    try {
      const html = await searchTDN(query);
      const parsed = parseTDN(html, query);

      if (!parsed.title) {
        return {
          ok: false,
          message:
            "Não encontrei uma página específica no TDN para essa pesquisa. Tente outro termo ou verifique se a função é oficial.",
        };
      }

      return {
        ok: true,
        ...parsed,
      };
    } catch (err: any) {
      return {
        ok: false,
        message: `Erro ao consultar o TDN: ${err.message}`,
      };
    }
  },
};

export default TotvsTdnTool;

/**
 * Busca uma pagina no TDN (TOTVS Developer Network) usando o parametro de pesquisa.
 *
 * @param query - Termo de busca (nome da funcao/classe, ex: "FwTemporaryTable")
 * @returns HTML completo da pagina retornada pelo TDN
 */
export async function searchTDN(query: string): Promise<string> {
  const url = `${BASE_FRAMEWORK}?search=${encodeURIComponent(query)}`;
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "mcp-protheus-expert",
    },
    timeout: 15000,
  });
  return res.data;
}

/**
 * Faz parse do HTML retornado pelo TDN e extrai titulo, paragrafos e exemplos de codigo.
 *
 * @param html  - Conteudo HTML completo da pagina
 * @param query - Termo original da busca (usado para gerar resumos)
 * @returns Objeto com titulo, resumo nao-tecnico, resumo tecnico, exemplos e links
 */
function parseTDN(html: string, query: string) {
  const $ = load(html);

  // Titulo da pagina
  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim();

  // Corpo principal do conteudo
  const content = $("#main-content, .wiki-content").first();

  const paragraphs: string[] = [];
  const examples: string[] = [];

  content.find("p").each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 40) paragraphs.push(t);
  });

  content.find("pre, code").each((_, el) => {
    const c = $(el).text().trim();
    if (c.length > 20) examples.push(c);
  });

  const links = [
    `${BASE_FRAMEWORK}?search=${encodeURIComponent(query)}`,
  ];

  return {
    title,
    summary: buildNonTechnicalSummary(query, paragraphs),
    technical: buildTechnicalSummary(query, paragraphs),
    examples: examples.slice(0, 5),
    links,
    rawExtract: paragraphs.slice(0, 10).join("\n\n"),
  };
}

/**
 * Constroi um resumo nao-tecnico (para leigos) a partir dos paragrafos extraidos.
 *
 * @param query - Nome da funcao/classe consultada
 * @param p     - Lista de paragrafos extraidos do TDN
 * @returns Texto formatado em Markdown com resumo simplificado, ou string vazia
 */
function buildNonTechnicalSummary(query: string, p: string[]) {
  if (!p.length) return "";

  return [
    `**O que é:**`,
    `${query} é um recurso padrão do Framework Protheus documentado pela TOTVS.`,
    "",
    `**Em termos simples:**`,
    p.slice(0, 2).map((x) => `- ${x}`).join("\n"),
  ].join("\n");
}

/**
 * Constroi um resumo tecnico detalhado a partir dos paragrafos extraidos.
 *
 * @param query - Nome da funcao/classe consultada
 * @param p     - Lista de paragrafos extraidos do TDN
 * @returns Texto formatado em Markdown com descricao tecnica, ou string vazia
 */
function buildTechnicalSummary(query: string, p: string[]) {
  if (!p.length) return "";

  return [
    `**Descrição técnica:**`,
    p.slice(0, 4).join("\n\n"),
  ].join("\n");
}
