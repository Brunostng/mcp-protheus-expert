/**
 * @file        bitbucketTool.ts
 * @description Ferramenta MCP para integracao com a API do Bitbucket Cloud:
 *              lista Pull Requests abertos e commits de um PR especifico,
 *              filtrando por ambiente (HML/PRD).
 * @author      <Bruno Santana Gomes>
 * @created     2025-01-11
 *
 * @dependencies
 *   - axios   : cliente HTTP para chamadas a API REST do Bitbucket
 *   - McpTool : interface padrao do servidor MCP para registro de ferramentas
 *
 * @remarks
 *   Parte do projeto mcp-protheus-expert (MCP Server para TOTVS Protheus).
 *   Requer variaveis BITBUCKET_USER, BITBUCKET_APP_PASSWORD, BITBUCKET_WORKSPACE
 *   e BITBUCKET_REPO_HML / BITBUCKET_REPO_PRD no ambiente.
 */

import axios, { AxiosError } from "axios";
import { McpTool } from "../types/McpTool.js";

/** URL base da API REST v2.0 do Bitbucket Cloud */
const BITBUCKET_API = "https://api.bitbucket.org/2.0";

/** Informacoes resumidas de um Pull Request do Bitbucket */
export interface PullRequestInfo {
  /** ID numerico do PR */
  id: number;
  /** Titulo do PR */
  title: string;
  /** Estado atual (OPEN, MERGED, DECLINED, etc.) */
  state: string;
  /** Nome da branch de origem */
  sourceBranch: string;
  /** Nome da branch de destino */
  targetBranch: string;
  /** Nome do autor do PR */
  author: string;
  /** Lista de nomes dos revisores */
  reviewers: string[];
  /** Data de criacao (ISO 8601) */
  createdOn: string;
  /** Data da ultima atualizacao (ISO 8601) */
  updatedOn?: string;
  /** Link HTML para visualizacao no navegador */
  linkHtml?: string;
}

/** Informacoes resumidas de um commit dentro de um PR */
export interface CommitInfo {
  /** Hash completo do commit */
  hash: string;
  /** Mensagem do commit */
  message: string;
  /** Nome do autor */
  author: string;
  /** Data do commit (ISO 8601) */
  date: string;
  /** Link HTML para visualizacao no navegador */
  linkHtml?: string;
}

/**
 * Cria e retorna uma instancia Axios configurada para a API do Bitbucket.
 * Usa autenticacao basica com BITBUCKET_USER e BITBUCKET_APP_PASSWORD.
 *
 * @returns Instancia Axios configurada com baseURL, auth e timeout
 * @throws Error se as credenciais nao estiverem definidas no ambiente
 */
function bitbucketClient() {
  const user = process.env.BITBUCKET_USER;
  const password = process.env.BITBUCKET_APP_PASSWORD;

  if (!user || !password) {
    throw new Error(
      "Credenciais do Bitbucket não configuradas. Defina BITBUCKET_USER e BITBUCKET_APP_PASSWORD no env do MCP (claude_desktop_config.json)."
    );
  }

  return axios.create({
    baseURL: BITBUCKET_API,
    auth: { username: user, password },
    headers: {
      Accept: "application/json"
    },
    timeout: 30_000
  });
}

/**
 * Lista Pull Requests abertos no repositorio, com filtros opcionais.
 * Usa a query `q` da API do Bitbucket para filtragem no servidor.
 * Suporta paginacao automatica.
 *
 * @param params - Objeto com workspace, repo e filtros opcionais de branch
 * @returns Lista de PullRequestInfo com dados resumidos de cada PR
 */
async function listOpenPullRequests(params: {
  workspace: string;
  repo: string;
  sourceBranch?: string;
  targetBranch?: string;
}): Promise<PullRequestInfo[]> {
  const client = bitbucketClient();

  const parts: string[] = [`state="OPEN"`];
  if (params.targetBranch) parts.push(`destination.branch.name="${params.targetBranch}"`);
  if (params.sourceBranch) parts.push(`source.branch.name="${params.sourceBranch}"`);

  const q = parts.join(" AND ");

  const out: PullRequestInfo[] = [];
  let url = `/repositories/${params.workspace}/${params.repo}/pullrequests`;
  let next: string | undefined;

  do {
    const resp = await client.get(next ?? url, {
      params: next ? undefined : { q, pagelen: 50 }
    });

    const values = resp.data?.values ?? [];
    for (const pr of values) {
      out.push({
        id: pr.id,
        title: pr.title,
        state: pr.state,
        sourceBranch: pr.source?.branch?.name ?? "",
        targetBranch: pr.destination?.branch?.name ?? "",
        author: pr.author?.display_name ?? "desconhecido",
        reviewers: (pr.reviewers ?? []).map((r: any) => r.display_name),
        createdOn: pr.created_on,
        updatedOn: pr.updated_on,
        linkHtml: pr.links?.html?.href
      });
    }

    next = resp.data?.next; // paginacao
  } while (next);

  return out;
}

/**
 * Lista todos os commits de um Pull Request especifico.
 * Suporta paginacao automatica.
 *
 * @param params - Objeto com workspace, repo e ID do PR
 * @returns Lista de CommitInfo com dados de cada commit
 */
async function listPullRequestCommits(params: {
  workspace: string;
  repo: string;
  prId: number;
}): Promise<CommitInfo[]> {
  const client = bitbucketClient();

  const out: CommitInfo[] = [];
  let url = `/repositories/${params.workspace}/${params.repo}/pullrequests/${params.prId}/commits`;
  let next: string | undefined;

  do {
    const resp = await client.get(next ?? url, {
      params: next ? undefined : { pagelen: 50 }
    });

    const values = resp.data?.values ?? [];
    for (const c of values) {
      out.push({
        hash: c.hash,
        message: (c.message ?? "").trim(),
        author: c.author?.user?.display_name || c.author?.raw || "desconhecido",
        date: c.date,
        linkHtml: c.links?.html?.href
      });
    }

    next = resp.data?.next;
  } while (next);

  return out;
}

/**
 * Formata um erro Axios em objeto legivel com status, mensagem e detalhes.
 *
 * @param e - Erro capturado (esperado AxiosError, mas aceita unknown)
 * @returns Objeto com mensagem, status HTTP e detalhes do erro
 */
function formatAxiosError(e: unknown) {
  const err = e as AxiosError<any>;
  const status = err.response?.status;
  const statusText = err.response?.statusText;
  const data = err.response?.data;

  return {
    mensagem: "Falha ao chamar a API do Bitbucket.",
    status,
    statusText,
    detalhe: data ?? err.message
  };
}

/**
 * Definicao da ferramenta MCP de integracao com Bitbucket.
 * Expoe o schema de entrada e o metodo run() para o servidor MCP.
 */
const bitbucketTool: McpTool = {
  name: "bitbucket_protheus",
  description:
    "Bitbucket (PT-BR): lista PRs abertos e commits de PR. Usa BITBUCKET_USER/BITBUCKET_APP_PASSWORD e seleciona repo por ambiente (HML/PRD).",

  inputSchema: {
    type: "object",
    properties: {
      ambiente: { type: "string", enum: ["HML", "PRD"], description: "Ambiente do repositório (HML ou PRD)" },
      action: { type: "string", enum: ["list_open_prs", "list_pr_commits"], description: "Ação a executar" },

      sourceBranch: { type: "string", description: "Branch de origem (ex: SPCD-1946)" },
      targetBranch: { type: "string", description: "Branch destino (ex: master)" },
      prId: { type: "number", description: "ID do PR (para listar commits)" },

      workspace: { type: "string", description: "Override opcional do workspace" },
      repo: { type: "string", description: "Override opcional do repo" }
    },
    required: ["ambiente", "action"],
    additionalProperties: false
  },

  async run(input: any) {
    const { ambiente, action, sourceBranch, targetBranch, prId } = input as {
      ambiente: "HML" | "PRD";
      action: "list_open_prs" | "list_pr_commits";
      sourceBranch?: string;
      targetBranch?: string;
      prId?: number;
      workspace?: string;
      repo?: string;
    };

    const workspace = input.workspace || process.env.BITBUCKET_WORKSPACE;
    const repo =
      input.repo ||
      (ambiente === "HML" ? process.env.BITBUCKET_REPO_HML : process.env.BITBUCKET_REPO_PRD);

    if (!workspace) {
      throw new Error("BITBUCKET_WORKSPACE não está configurado no env do MCP.");
    }
    if (!repo) {
      throw new Error("BITBUCKET_REPO_HML / BITBUCKET_REPO_PRD não está configurado no env do MCP.");
    }

    try {
      if (action === "list_open_prs") {
        const prs = await listOpenPullRequests({ workspace, repo, sourceBranch, targetBranch });
        return { ok: true, ambiente, workspace, repo, total: prs.length, prs };
      }

      if (action === "list_pr_commits") {
        if (!prId) throw new Error("Informe prId quando action=list_pr_commits");
        const commits = await listPullRequestCommits({ workspace, repo, prId });
        return { ok: true, ambiente, workspace, repo, prId, total: commits.length, commits };
      }

      throw new Error(`Ação inválida: ${action}`);
    } catch (e) {
      const detalhes = formatAxiosError(e);
      return { ok: false, ambiente, workspace, repo, erro: detalhes };
    }
  }
};

export default bitbucketTool;
