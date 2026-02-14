/**
 * @file        RelatorioRotinaTool.ts
 * @description Ferramenta MCP para analise de rotinas Protheus: busca arquivos em
 *              repositorios locais, gera relatorios Markdown com diagramas Mermaid,
 *              obtem codigo-fonte e busca rotinas por tabela.
 * @author      <Bruno Santana Gomes>
 * @created     2025-01-11
 *
 * @dependencies
 *   - simple-git : operacoes Git (status, diff, branch) no repositorio local
 *   - McpTool    : interface padrao do servidor MCP para registro de ferramentas
 *
 * @remarks
 *   Parte do projeto mcp-protheus-expert (MCP Server para TOTVS Protheus).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import type { McpTool } from "../types/McpTool.ts";

/**
 * Prefixos de rotinas padrao TOTVS.
 * Lista compilada dos prefixos mais comuns de fontes padrao do Protheus.
 * Sera complementada dinamicamente apos analise do repositorio local.
 * Formato: Prefixo de 3-4 caracteres que identifica o modulo/area.
 */
const KNOWN_STANDARD_PREFIXES = [
  // SIGAFAT - Faturamento
  'FATA', 'FATC', 'FATR', 'FATM',
  'MATA', 'MATC', 'MATR', 'MATM',

  // SIGAFIN - Financeiro
  'FINA', 'FINC', 'FINR', 'FINM', 'FINXFUN',

  // SIGACOM - Compras
  'COMA', 'COMC', 'COMR', 'COMM',

  // SIGAGPE - Gestao de Pessoal
  'GPEA', 'GPEC', 'GPER', 'GPEM', 'GPEXFUN',

  // SIGAMNT - Manutencao de Ativos
  'MNTA', 'MNTC', 'MNTR', 'MNTM',

  // SIGAPCP - Planejamento e Controle de Producao
  'PCPA', 'PCPC', 'PCPR', 'PCPM',

  // SIGAQIE - Qualidade
  'QIEA', 'QIEC', 'QIER', 'QIEM', 'QIEXFUN',

  // SIGATEC - Field Service
  'TECA', 'TECC', 'TECR', 'TECM', 'TECXFUN',

  // SIGACRM - CRM
  'CRMA', 'CRMC', 'CRMR', 'CRMM',
  'TMKA', 'TMKC', 'TMKR', 'TMKM', // Telemarketing

  // SIGAJUR - Juridico
  'JURA', 'JURC', 'JURR', 'JURM',

  // SIGAVEI - Veiculos
  'VEICA', 'VEICC', 'VEICR',
  'OFIA', 'OFIC', 'OFIR', 'OFIM', // Oficina

  // SIGACTB - Contabilidade
  'CTBA', 'CTBC', 'CTBR', 'CTBM', 'CTBXFUN',

  // SIGAEST - Estoque/Custos
  'ESTA', 'ESTC', 'ESTR', 'ESTM',

  // SIGALOJ - Lojas
  'LOJA', 'LOJC', 'LOJR', 'LOJM',

  // SIGAPON - Ponto Eletronico
  'PONA', 'PONC', 'PONR', 'PONM', 'PONXFUN',

  // SIGAFAS - Faturamento de Servicos
  'FISA', 'FISC', 'FISR', 'FISM',

  // Framework e Bibliotecas
  'FWMVC', 'FWBROWSE', 'FWFORM',
  'APCFG', 'APWIZ',
  'CFGA', 'CFGC', 'CFGR', 'CFGM', 'CFGX',

  // BI e Relatorios
  'BIXA', 'BIXC',

  // Funcoes Genericas
  'AGRA', 'AGRC', 'AGRR', // Agronegocio
  'OMSA', 'OMSC', 'OMSR', // OMS
  'WFFA', 'WFFC', // Workflow
  'EICA', 'EICC', // EAI - Enterprise Application Integration
];

/**
 * Interface para resultado normalizado do nome da rotina
 */
interface NormalizedRoutine {
  original: string;
  baseName: string;           // Nome sem extensao
  baseNameUpper: string;      // Nome em maiuscula sem extensao
  withPrefix: string;         // Com U_ se nao tiver
  withoutPrefix: string;      // Sem U_ se tiver
  variations: string[];       // Todas as variacoes possiveis
}

/**
 * Interface para resultado de busca por tabela
 */
interface TableSearchResult {
  routine: string;
  file: string;
  filePath: string;
  usageType: 'Browse' | 'Report' | 'Integration' | 'CRUD' | 'Query' | 'Other';
  references: number;
  hasBrowse: boolean;
  hasInsert: boolean;
  hasUpdate: boolean;
  hasDelete: boolean;
  userFunctions: string[];
  staticFunctions: string[];
}

/**
 * Interface para parametros da ferramenta
 */
interface RelatorioRotinaParams {
  routine?: string;
  action?: 'status' | 'analyzeRoutine' | 'renderReportMarkdown' | 'getSourceCode' | 'searchByTable';
  env?: 'HML' | 'PRD' | 'TOTVS' | 'AUTO' | 'STANDARD';
  baseBranch?: string;
  repoPath?: string;
  mermaidMode?: 'auto' | 'confluence-safe' | 'off';

  /** Incluir codigo-fonte no relatorio Markdown */
  includeSource?: boolean;
  /** Limite de caracteres do codigo-fonte retornado */
  maxSourceChars?: number;
  /** Encoding para leitura do codigo-fonte */
  sourceEncoding?: 'utf-8' | 'latin1';

  /** Nome da tabela para busca (action 'searchByTable') */
  table?: string;
  /** Incluir rotinas padrao TOTVS nos resultados */
  includeStandard?: boolean;
  /** Numero maximo de resultados */
  maxResults?: number;
}

/**
 * Classe principal da ferramenta Relatorio_Rotina
 */
export class RelatorioRotinaTool {
  private standardPrefixCache: Map<string, boolean> = new Map();
  private discoveredPrefixes: Set<string> = new Set();

  /**
   * Debug logger: nunca escreve em stdout (para nao quebrar MCP stdio).
   * Ative com MCP_DEBUG=1 no .env.
   */
  private debug(message: string): void {
    if (process.env.MCP_DEBUG === '1') {
      console.error(`[RelatorioRotinaTool] ${message}`);
    }
  }

  /**
   * Normaliza o nome da rotina para todas as variacoes possiveis.
   * Gera combinacoes com/sem prefixo U_ e com diversas extensoes (.prw, .tlpp, .prx).
   *
   * @param routine - Nome original da rotina (ex: "U_PCMCTF43.prw")
   * @returns Objeto NormalizedRoutine com nome base, variacoes e formas normalizadas
   * @throws Error se o nome da rotina for invalido ou vazio
   */
  private normalizeRoutineName(routine: string): NormalizedRoutine {
    // VALIDACAO CRITICA: Garantir que routine nao seja undefined/null
    if (!routine || typeof routine !== 'string') {
      throw new Error(`Nome da rotina invalido: ${routine}. Forneca um nome de rotina valido.`);
    }

    const original = routine.trim();

    if (!original) {
      throw new Error('Nome da rotina nao pode ser vazio.');
    }

    // Remover extensao
    const baseName = original.replace(/\.(prw|tlpp|prx)$/i, '');
    const baseNameUpper = baseName.toUpperCase();

    // Verificar se tem prefixo U_
    const hasPrefix = baseNameUpper.startsWith('U_');
    const withoutPrefix = hasPrefix ? baseNameUpper.substring(2) : baseNameUpper;
    const withPrefix = hasPrefix ? baseNameUpper : `U_${baseNameUpper}`;

    // Gerar todas as variacoes
    const variations: string[] = [];

    // Variacoes do nome base
    variations.push(baseName);
    variations.push(baseNameUpper);
    variations.push(withPrefix);
    variations.push(withoutPrefix);

    // Variacoes com extensoes
    const extensions = ['.prw', '.PRW', '.tlpp', '.TLPP', '.prx', '.PRX'];
    for (const ext of extensions) {
      variations.push(baseName + ext);
      variations.push(baseNameUpper + ext);
      variations.push(withPrefix + ext);
      variations.push(withoutPrefix + ext);
    }

    // Remover duplicatas mantendo ordem
    const uniqueVariations = [...new Set(variations)];

    return {
      original,
      baseName,
      baseNameUpper,
      withPrefix,
      withoutPrefix,
      variations: uniqueVariations
    };
  }

  /**
   * Detecta se uma rotina e padrao TOTVS baseado em multiplos criterios:
   * prefixo U_, lista de prefixos conhecidos, conteudo do arquivo e padrao de nomenclatura.
   *
   * @param routineName - Nome da rotina (ex: "MATA010")
   * @param filePath    - Caminho opcional do arquivo para analise de conteudo
   * @returns true se a rotina for identificada como padrao TOTVS
   */
  private async isStandardRoutine(
    routineName: string,
    filePath?: string
  ): Promise<boolean> {
    const upperName = routineName.toUpperCase().replace(/^U_/, '');

    // Verificar cache
    if (this.standardPrefixCache.has(upperName)) {
      return this.standardPrefixCache.get(upperName)!;
    }

    let isStandard = false;

    // Criterio 1: Verifica se comeca com U_ (definitivamente custom)
    if (routineName.toUpperCase().startsWith('U_')) {
      isStandard = false;
    }
    // Criterio 2: Verifica contra lista de prefixos conhecidos
    else if (this.matchesKnownPrefix(upperName)) {
      isStandard = true;
    }
    // Criterio 3: Se temos o arquivo, verificar conteudo
    else if (filePath) {
      isStandard = await this.analyzeFileContent(filePath);
    }
    // Criterio 4: Padrao de nomenclatura (4 letras + numero)
    else if (/^[A-Z]{4}\d{3}/.test(upperName)) {
      isStandard = true;
    }

    // Armazenar no cache
    this.standardPrefixCache.set(upperName, isStandard);

    return isStandard;
  }

  /**
   * Verifica se o nome corresponde a algum prefixo conhecido (estatico ou descoberto).
   *
   * @param routineName - Nome da rotina em maiusculas, sem prefixo U_
   * @returns true se corresponder a algum prefixo da lista
   */
  private matchesKnownPrefix(routineName: string): boolean {
    const allPrefixes = [
      ...KNOWN_STANDARD_PREFIXES,
      ...Array.from(this.discoveredPrefixes)
    ];

    return allPrefixes.some(prefix =>
      routineName.startsWith(prefix.toUpperCase())
    );
  }

  /**
   * Analisa o conteudo do arquivo para determinar se e padrao TOTVS ou custom.
   * Inspeciona as primeiras 200 linhas buscando indicadores de cada tipo.
   *
   * @param filePath - Caminho absoluto do arquivo .prw/.tlpp/.prx
   * @returns true se o conteudo indicar rotina padrao TOTVS
   */
  private async analyzeFileContent(filePath: string): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // Pegar primeiras 200 linhas para analise
      const lines = content.split('\n').slice(0, 200);
      const contentStr = lines.join('\n').toUpperCase();

      // Indicadores de rotina CUSTOM
      const customIndicators = [
        /USER\s+FUNCTION/i,
        /FUNCTION\s+U_/i,
        /STATIC\s+FUNCTION\s+U_/i,
      ];

      // Se encontrar qualquer indicador de custom, nao e padrao
      for (const indicator of customIndicators) {
        if (indicator.test(contentStr)) {
          return false;
        }
      }

      // Indicadores de rotina PADRAO
      const standardIndicators = [
        /FUNCTION\s+[A-Z]{4}\d{3}/i,
        /#INCLUDE\s+"PROTHEUS\.CH"/i,
        /#INCLUDE\s+"RWMAKE\.CH"/i,
        /STATIC\s+FUNCTION\s+MENU/i,
        /WSSERVICE\s+/i,
        /WSRESTFUL\s+/i,
      ];

      // Se encontrar indicadores de padrao, provavelmente e padrao
      for (const indicator of standardIndicators) {
        if (indicator.test(contentStr)) {
          return true;
        }
      }

      // Padrao: se nao encontrou nada definitivo, assumir como padrao
      return true;

    } catch (error) {
      console.error(`Erro ao analisar arquivo ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Varre o repositorio TOTVS padrao e descobre novos prefixos de rotinas.
   * Popula o Set `discoveredPrefixes` com prefixos de 3-4 caracteres encontrados.
   *
   * @param repoPath - Caminho raiz do repositorio TOTVS padrao
   */
  private async discoverStandardPrefixes(repoPath: string): Promise<void> {
    try {
      const files = await this.getAllFilesRecursive(repoPath, ['.prw', '.tlpp', '.prx']);

      for (const file of files) {
        const fileName = path.basename(file, path.extname(file));
        const isStandard = await this.analyzeFileContent(file);

        if (isStandard) {
          // Extrair prefixo (3-4 primeiras letras)
          const match = fileName.match(/^([A-Z]{3,4})/);
          if (match) {
            this.discoveredPrefixes.add(match[1]);
          }
        }
      }

      this.debug(`Descobertos ${this.discoveredPrefixes.size} prefixos no repositorio TOTVS`);

    } catch (error) {
      console.error('Erro ao descobrir prefixos:', error);
    }
  }

  /**
   * Busca recursiva de arquivos com extensoes especificas.
   * Ignora pastas comuns (node_modules, .git, bin, obj, backup).
   *
   * @param dir          - Diretorio inicial para a busca
   * @param extensions   - Lista de extensoes a procurar (ex: ['.prw', '.tlpp'])
   * @param maxDepth     - Profundidade maxima de recursao (padrao: 5)
   * @param currentDepth - Profundidade atual (uso interno na recursao)
   * @returns Lista de caminhos absolutos dos arquivos encontrados
   */
  private async getAllFilesRecursive(
    dir: string,
    extensions: string[],
    maxDepth: number = 5,
    currentDepth: number = 0
  ): Promise<string[]> {
    if (currentDepth > maxDepth) {
      return [];
    }

    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // Ignorar pastas comuns que nao tem fontes
          const ignoreDirs = ['node_modules', '.git', 'bin', 'obj', 'backup'];
          if (!ignoreDirs.includes(entry.name.toLowerCase())) {
            const subFiles = await this.getAllFilesRecursive(
              fullPath,
              extensions,
              maxDepth,
              currentDepth + 1
            );
            files.push(...subFiles);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`Erro ao ler diretorio ${dir}:`, error);
    }

    return files;
  }

  /**
   * Busca arquivo de rotina no repositorio, tentando todas as variacoes do nome.
   * Primeiro tenta busca direta na raiz, depois busca recursiva em subpastas.
   *
   * @param repoPath   - Caminho raiz do repositorio
   * @param normalized - Objeto com nome normalizado e suas variacoes
   * @returns Caminho absoluto do arquivo encontrado, ou null se nao encontrado
   */
  private async findRoutineFile(
    repoPath: string,
    normalized: NormalizedRoutine
  ): Promise<string | null> {
    // 1. Busca direta na raiz
    for (const variation of normalized.variations) {
      const directPath = path.join(repoPath, variation);
      if (await this.fileExists(directPath)) {
        return directPath;
      }
    }

    // 2. Busca recursiva em subpastas
    const allFiles = await this.getAllFilesRecursive(repoPath, ['.prw', '.tlpp', '.prx'], 3);

    for (const filePath of allFiles) {
      const fileName = path.basename(filePath);
      const fileNameUpper = fileName.toUpperCase();

      for (const variation of normalized.variations) {
        if (fileNameUpper === variation.toUpperCase()) {
          return filePath;
        }
      }
    }

    return null;
  }

  /**
   * Verifica se um arquivo existe no sistema de arquivos.
   *
   * @param filePath - Caminho absoluto do arquivo
   * @returns true se o arquivo existir e for acessivel
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Obtem caminho do repositorio baseado no ambiente
   */
  private getRepoPath(env: string): string {
    const envVarMap: Record<string, string> = {
      'HML': 'REPO_HML',
      'PRD': 'REPO_PRD',
      'TOTVS': 'REPO_TOTVS_STANDARD',
      'STANDARD': 'REPO_TOTVS_STANDARD',
      'TOTVS_STANDARD': 'REPO_TOTVS_STANDARD'
    };

    const envVar = envVarMap[env.toUpperCase()];
    const repoPath = envVar ? process.env[envVar] : '';

    if (!repoPath) {
      throw new Error(`Variavel de ambiente ${envVar} nao configurada para ambiente ${env}`);
    }

    return repoPath;
  }

  /**
   * Detecta ambiente baseado no nome da rotina (para modo AUTO)
   */
  private detectEnvironment(routineName: string): string {
    // Por padrao, se comecar com U_, provavelmente e HML ou PRD
    if (routineName.startsWith('U_')) {
      return 'HML'; // Preferencia para HML em modo AUTO
    }

    return 'STANDARD';
  }

  /**
   * NOVA FUNCIONALIDADE: Busca rotinas que usam uma tabela especifica
   */
  private async executeSearchByTable(
    tableName: string,
    repoPath: string,
    includeStandard: boolean = false,
    maxResults: number = 50
  ): Promise<any> {
    try {
      this.debug(`Buscando rotinas que usam a tabela: ${tableName}`);
      
      const results: TableSearchResult[] = [];
      const tableUpper = tableName.toUpperCase();

      // Buscar todos os arquivos .prw, .tlpp, .prx
      const allFiles = await this.getAllFilesRecursive(repoPath, ['.prw', '.tlpp', '.prx'], 5);
      this.debug(`Total de arquivos encontrados: ${allFiles.length}`);

      for (const filePath of allFiles) {
        try {
          // Ler arquivo
          const content = await fs.readFile(filePath, 'latin1');
          const contentUpper = content.toUpperCase();

          // Verificar se tabela e referenciada
          if (!this.hasTableReference(contentUpper, tableUpper)) {
            continue;
          }

          // Extrair nome da rotina
          const fileName = path.basename(filePath, path.extname(filePath));
          
          // Verificar se e rotina padrao
          const isStandard = await this.isStandardRoutine(fileName, filePath);
          
          // Pular rotinas padrão se não solicitado
          if (isStandard && !includeStandard) {
            continue;
          }

          // Analisar uso da tabela
          const analysis = this.analyzeTableUsage(content, tableUpper);

          results.push({
            routine: fileName,
            file: path.basename(filePath),
            filePath: filePath,
            usageType: analysis.usageType,
            references: analysis.references,
            hasBrowse: analysis.hasBrowse,
            hasInsert: analysis.hasInsert,
            hasUpdate: analysis.hasUpdate,
            hasDelete: analysis.hasDelete,
            userFunctions: analysis.userFunctions,
            staticFunctions: analysis.staticFunctions
          });

          // Limitar resultados
          if (results.length >= maxResults) {
            break;
          }

        } catch (error) {
          this.debug(`Erro ao processar arquivo ${filePath}: ${error}`);
        }
      }

      // Ordenar por relevância (Browse > CRUD > Query > Other)
      results.sort((a, b) => {
        const typeOrder = { 'Browse': 1, 'CRUD': 2, 'Query': 3, 'Report': 4, 'Integration': 5, 'Other': 6 };
        const orderA = typeOrder[a.usageType] || 99;
        const orderB = typeOrder[b.usageType] || 99;
        
        if (orderA !== orderB) return orderA - orderB;
        return b.references - a.references;
      });

      return {
        ok: true,
        table: tableName,
        totalFound: results.length,
        results: results,
        summary: {
          browseRoutines: results.filter(r => r.usageType === 'Browse').length,
          crudRoutines: results.filter(r => r.usageType === 'CRUD').length,
          reportRoutines: results.filter(r => r.usageType === 'Report').length,
          otherRoutines: results.filter(r => !['Browse', 'CRUD', 'Report'].includes(r.usageType)).length
        }
      };

    } catch (error: any) {
      return {
        ok: false,
        message: `Erro ao buscar rotinas por tabela: ${error.message}`,
        stack: error.stack
      };
    }
  }

  /**
   * Verifica se o conteúdo tem referência à tabela
   */
  private hasTableReference(contentUpper: string, tableUpper: string): boolean {
    const patterns = [
      new RegExp(`\\b${tableUpper}\\b`),                              // Palavra exata
      new RegExp(`DBSELECTAREA\\s*\\(\\s*["']${tableUpper}["']`),    // DbSelectArea("XXX")
      new RegExp(`\\(["']${tableUpper}["']\\)`),                      // ("XXX")
      new RegExp(`${tableUpper}->`)                                    // XXX->
    ];

    return patterns.some(pattern => pattern.test(contentUpper));
  }

  /**
   * Analisa como a tabela está sendo usada
   */
  private analyzeTableUsage(content: string, tableUpper: string): {
    usageType: 'Browse' | 'Report' | 'Integration' | 'CRUD' | 'Query' | 'Other';
    references: number;
    hasBrowse: boolean;
    hasInsert: boolean;
    hasUpdate: boolean;
    hasDelete: boolean;
    userFunctions: string[];
    staticFunctions: string[];
  } {
    const contentUpper = content.toUpperCase();
    
    // Contar referências
    const references = (contentUpper.match(new RegExp(`\\b${tableUpper}\\b`, 'g')) || []).length;

    // Detectar browse
    const browseKeywords = [
      'MBROWSE', 'FWMBROWSE', 'FWMARKBROWSE', 'MSSELECT'
    ];
    const hasBrowse = browseKeywords.some(kw => contentUpper.includes(kw));

    // Detectar operações CRUD
    const hasInsert = /RECLOCK\s*\(\s*["']?\w+["']?\s*,\s*\.T\./i.test(content) || 
                     contentUpper.includes('DBAPPEND');
    
    const hasUpdate = /RECLOCK\s*\(\s*["']?\w+["']?\s*,\s*\.F\./i.test(content);
    
    const hasDelete = contentUpper.includes('DBDELETE') || 
                     /RECLOCK.*DBDELETE/s.test(contentUpper);

    // Extrair funções
    const userFunctions: string[] = [];
    const staticFunctions: string[] = [];
    
    const userFuncMatches = content.matchAll(/USER\s+FUNCTION\s+(\w+)/gi);
    for (const match of userFuncMatches) {
      userFunctions.push(match[1]);
    }

    const staticFuncMatches = content.matchAll(/STATIC\s+FUNCTION\s+(\w+)/gi);
    for (const match of staticFuncMatches) {
      staticFunctions.push(match[1]);
    }

    // Determinar tipo de uso
    let usageType: 'Browse' | 'Report' | 'Integration' | 'CRUD' | 'Query' | 'Other';
    
    if (hasBrowse) {
      usageType = 'Browse';
    } else if (hasInsert || hasUpdate || hasDelete) {
      usageType = 'CRUD';
    } else if (contentUpper.includes('TCQUERY') || contentUpper.includes('SELECT ')) {
      usageType = 'Query';
    } else if (contentUpper.includes('TMSPRINTER') || contentUpper.includes('TREPORT')) {
      usageType = 'Report';
    } else if (contentUpper.includes('WSSERVICE') || contentUpper.includes('WSRESTFUL')) {
      usageType = 'Integration';
    } else {
      usageType = 'Other';
    }

    return {
      usageType,
      references,
      hasBrowse,
      hasInsert,
      hasUpdate,
      hasDelete,
      userFunctions: [...new Set(userFunctions)],
      staticFunctions: [...new Set(staticFunctions)]
    };
  }

  /**
   * Executa analise de status da rotina (git)
   */
  private async executeStatus(
    filePath: string,
    repoPath: string,
    baseBranch: string = 'origin/master'
  ): Promise<any> {
    try {
      const git: SimpleGit = simpleGit(repoPath);
      const relativePath = path.relative(repoPath, filePath);

      // Status do arquivo
      const status = await git.status([relativePath]);

      // Diff com branch base
      const diff = await git.diff([baseBranch, '--', relativePath]);

      return {
        ok: true,
        file: relativePath,
        status: status.files.find(f => f.path === relativePath) || 'unchanged',
        diff: diff || 'No changes',
        branch: await git.revparse(['--abbrev-ref', 'HEAD'])
      };

    } catch (error) {
      return {
        ok: false,
        message: `Erro ao obter status git: ${error}`
      };
    }
  }

  /**
   * Le arquivo texto com encoding configuravel.
   * Padrao: latin1 (pratico para Windows-1252 em muitos fontes .PRW).
   */
  private async readTextFile(filePath: string, encoding: 'utf-8' | 'latin1' = 'latin1'): Promise<string> {
    return fs.readFile(filePath, { encoding });
  }

  /**
   * Trunca o texto no meio para evitar estourar limite do MCP/LLM.
   */
  private truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (!maxChars || maxChars <= 0) return { text, truncated: false };
    if (text.length <= maxChars) return { text, truncated: false };

    const head = Math.floor(maxChars * 0.6);
    const tail = maxChars - head;

    return {
      text:
        text.slice(0, head) +
        "\n\n/* ...TRUNCADO PELO MCP (codigo omitido para respeitar limite)... */\n\n" +
        text.slice(text.length - tail),
      truncated: true
    };
  }

  /**
   * Executa analise da rotina (estrutura, funcoes, etc)
   */
  private async executeAnalyzeRoutine(filePath: string): Promise<any> {
    try {
      // Mantive utf-8 como estava, por ser analise estrutural (pouco sensivel)
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Analise basica
      const analysis = {
        totalLines: lines.length,
        functions: [] as any[],
        includes: [] as string[],
        tables: [] as string[],
        userFunctions: [] as string[],
        staticFunctions: [] as string[]
      };

      // Extrair informacoes
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim().toUpperCase();

        // Includes
        if (line.startsWith('#INCLUDE')) {
          const match = line.match(/#INCLUDE\s+"([^"]+)"/i);
          if (match) {
            analysis.includes.push(match[1]);
          }
        }

        // User Functions
        if (line.includes('USER FUNCTION')) {
          const match = line.match(/USER\s+FUNCTION\s+(\w+)/i);
          if (match) {
            analysis.userFunctions.push(match[1]);
          }
        }

        // Static Functions
        if (line.includes('STATIC FUNCTION')) {
          const match = line.match(/STATIC\s+FUNCTION\s+(\w+)/i);
          if (match) {
            analysis.staticFunctions.push(match[1]);
          }
        }

        // Tabelas (DbSelectArea, (cAlias), etc)
        const tableMatch =
          line.match(/DBSELECTAREA\s*\(\s*["']([A-Z0-9]+)["']\s*\)/i) ||
          line.match(/\(["']([A-Z0-9]{2,3})["']\)/);
        if (tableMatch && tableMatch[1].length <= 3) {
          analysis.tables.push(tableMatch[1]);
        }
      }

      // Remover duplicatas
      analysis.includes = [...new Set(analysis.includes)];
      analysis.tables = [...new Set(analysis.tables)];
      analysis.userFunctions = [...new Set(analysis.userFunctions)];
      analysis.staticFunctions = [...new Set(analysis.staticFunctions)];

      return {
        ok: true,
        analysis
      };

    } catch (error) {
      return {
        ok: false,
        message: `Erro ao analisar rotina: ${error}`
      };
    }
  }

  /**
   * Retorna o codigo-fonte da rotina (path + sourceCode) com limite opcional.
   */
  private async executeGetSourceCode(
    filePath: string,
    encoding: 'utf-8' | 'latin1' = 'latin1',
    maxSourceChars: number = 180000
  ): Promise<any> {
    try {
      const raw = await this.readTextFile(filePath, encoding);
      const { text, truncated } = this.truncateMiddle(raw, maxSourceChars);

      return {
        ok: true,
        path: filePath,
        encoding,
        truncated,
        sourceCode: text
      };
    } catch (error) {
      return {
        ok: false,
        message: `Erro ao ler codigo-fonte: ${error}`
      };
    }
  }

  /**
   * Gera relatorio em Markdown com diagrama Mermaid
   * Pode incluir o codigo-fonte no relatorio via includeSource.
   */
  private async executeRenderReportMarkdown(
    filePath: string,
    routine: string,
    mermaidMode: string = 'auto',
    includeSource: boolean = false,
    maxSourceChars: number = 180000,
    sourceEncoding: 'utf-8' | 'latin1' = 'latin1'
  ): Promise<any> {
    try {
      // Analise da rotina
      const analysisResult = await this.executeAnalyzeRoutine(filePath);

      if (!analysisResult.ok) {
        return analysisResult;
      }

      const analysis = analysisResult.analysis;

      // Gerar Markdown
      let markdown = `# Relatorio da Rotina: ${routine}\n\n`;
      markdown += `**Arquivo:** \`${path.basename(filePath)}\`\n\n`;
      markdown += `---\n\n`;

      // Estatisticas
      markdown += `## Estatisticas\n\n`;
      markdown += `- Total de Linhas: ${analysis.totalLines}\n`;
      markdown += `- User Functions: ${analysis.userFunctions.length}\n`;
      markdown += `- Static Functions: ${analysis.staticFunctions.length}\n`;
      markdown += `- Tabelas Utilizadas: ${analysis.tables.length}\n`;
      markdown += `- Includes: ${analysis.includes.length}\n\n`;

      // Functions
      if (analysis.userFunctions.length > 0) {
        markdown += `## User Functions\n\n`;
        for (const func of analysis.userFunctions) {
          markdown += `- \`${func}()\`\n`;
        }
        markdown += `\n`;
      }

      if (analysis.staticFunctions.length > 0) {
        markdown += `## Static Functions\n\n`;
        for (const func of analysis.staticFunctions) {
          markdown += `- \`${func}()\`\n`;
        }
        markdown += `\n`;
      }

      // Tabelas
      if (analysis.tables.length > 0) {
        markdown += `## Tabelas Utilizadas\n\n`;
        for (const table of analysis.tables) {
          markdown += `- ${table}\n`;
        }
        markdown += `\n`;
      }

      // Includes
      if (analysis.includes.length > 0) {
        markdown += `## Includes\n\n`;
        for (const inc of analysis.includes) {
          markdown += `- \`${inc}\`\n`;
        }
        markdown += `\n`;
      }

      // Diagrama Mermaid (se solicitado)
      if (mermaidMode !== 'off') {
        markdown += `## Diagrama de Fluxo\n\n`;
        markdown += `\`\`\`mermaid\n`;
        markdown += `graph TD\n`;
        markdown += `    Start([Inicio]) --> Main[${routine}]\n`;

        if (analysis.userFunctions.length > 0) {
          analysis.userFunctions.forEach((func: string, idx: number) => {
            markdown += `    Main --> UF${idx}[${func}]\n`;
          });
        }

        if (analysis.staticFunctions.length > 0) {
          analysis.staticFunctions.forEach((func: string, idx: number) => {
            markdown += `    Main --> SF${idx}[${func}]\n`;
          });
        }

        markdown += `    Main --> End([Fim])\n`;
        markdown += `\`\`\`\n\n`;
      }

      // Codigo-fonte (se solicitado)
      let sourceMeta: any = undefined;
      if (includeSource) {
        const src = await this.executeGetSourceCode(filePath, sourceEncoding, maxSourceChars);
        if (src.ok) {
          sourceMeta = { path: src.path, encoding: src.encoding, truncated: src.truncated, maxSourceChars };

          markdown += `---\n\n## Codigo-fonte\n\n`;
          if (src.truncated) {
            markdown += `Aviso: Codigo truncado para caber no limite (${maxSourceChars} caracteres).\n\n`;
          }
          markdown += `\`\`\`advpl\n${src.sourceCode}\n\`\`\`\n\n`;
        } else {
          markdown += `---\n\n## Codigo-fonte\n\n`;
          markdown += `Nao foi possivel carregar o codigo-fonte: ${src.message}\n\n`;
        }
      }

      return {
        ok: true,
        markdown,
        outputPath: filePath.replace(/\.(prw|tlpp|prx)$/i, '_report.md'),
        ...(sourceMeta ? { sourceMeta } : {})
      };

    } catch (error) {
      return {
        ok: false,
        message: `Erro ao gerar relatorio: ${error}`
      };
    }
  }

  /**
   * Metodo principal de execucao
   */
  async execute(params: RelatorioRotinaParams): Promise<any> {
    try {
      // Valores padrao para parametros opcionais
      const {
        routine,
        env = 'AUTO',
        action = 'renderReportMarkdown',
        repoPath: manualRepoPath,
        baseBranch = 'origin/master',
        mermaidMode = 'auto',

        // Novos
        includeSource = false,
        maxSourceChars = 180000,
        sourceEncoding = 'latin1',

        // Busca por tabela
        table,
        includeStandard = false,
        maxResults = 50
      } = params;

      // NOVA ACTION: searchByTable
      if (action === 'searchByTable') {
        if (!table) {
          return {
            ok: false,
            message: 'Parametro "table" e obrigatorio para action "searchByTable".',
            example: {
              action: 'searchByTable',
              table: 'PD3',
              env: 'HML',
              includeStandard: false,
              maxResults: 50
            }
          };
        }

        // Determinar repositorio
        let finalRepoPath: string;
        let finalEnv: string;

        if (manualRepoPath) {
          finalRepoPath = manualRepoPath;
          finalEnv = 'MANUAL';
        } else {
          finalEnv = env === 'AUTO' ? 'HML' : env;
          try {
            finalRepoPath = this.getRepoPath(finalEnv);
          } catch (error: any) {
            return {
              ok: false,
              env: finalEnv,
              message: `Repositorio ${finalEnv} nao configurado: ${error.message}`
            };
          }
        }

        // Executar busca
        const result = await this.executeSearchByTable(table, finalRepoPath, includeStandard, maxResults);
        return {
          ...result,
          metadata: {
            table,
            env: finalEnv,
            repoPath: finalRepoPath,
            includeStandard,
            maxResults
          }
        };
      }

      // Validacao critica para outras actions
      if (!routine) {
        return {
          ok: false,
          message: 'Parametro "routine" e obrigatorio. Forneca o nome da rotina que deseja analisar.',
          example: {
            routine: 'PCMCTF43',
            env: 'HML',
            action: 'renderReportMarkdown'
          }
        };
      }

      this.debug(`Processando rotina: ${routine}`);
      this.debug(`Ambiente: ${env}`);
      this.debug(`Acao: ${action}`);

      // 1. Normalizar nome da rotina
      const normalized = this.normalizeRoutineName(routine);
      this.debug(`Nome normalizado: ${normalized.baseNameUpper}`);

      // 2. Determinar repositorio
      let finalRepoPath: string;
      let finalEnv: string;
      let isStandard = false;

      if (manualRepoPath) {
        // Override manual fornecido
        finalRepoPath = manualRepoPath;
        finalEnv = 'MANUAL';
        this.debug(`Usando caminho manual: ${finalRepoPath}`);
      } else {
        // Detectar se e rotina padrao
        isStandard = await this.isStandardRoutine(normalized.baseNameUpper);
        this.debug(`E rotina padrao? ${isStandard ? 'SIM' : 'NAO'}`);

        if (isStandard) {
          // Rotina padrao TOTVS
          finalEnv = 'STANDARD';

          try {
            finalRepoPath = this.getRepoPath('STANDARD');
            this.debug(`Repositorio TOTVS: ${finalRepoPath}`);

            // Descobrir novos prefixos na primeira vez
            if (this.discoveredPrefixes.size === 0) {
              this.debug(`Descobrindo prefixos no repositorio TOTVS...`);
              await this.discoverStandardPrefixes(finalRepoPath);
            }

          } catch (error: any) {
            return {
              ok: false,
              env: 'STANDARD',
              routine: routine,
              message: `Repositorio de rotinas padrao nao configurado.\n\n` +
                `Configure a variavel REPO_TOTVS_STANDARD no arquivo .env\n` +
                `Exemplo: REPO_TOTVS_STANDARD=C:\\caminho\\para\\fontes\\totvs\n\n` +
                `Erro: ${error.message}`,
              debug: {
                normalized,
                isStandard,
                missingEnvVar: 'REPO_TOTVS_STANDARD'
              }
            };
          }
        } else {
          // Rotina customizada
          if (env === 'AUTO') {
            finalEnv = this.detectEnvironment(normalized.baseNameUpper);
            this.debug(`Ambiente detectado automaticamente: ${finalEnv}`);
          } else {
            finalEnv = env;
          }

          try {
            finalRepoPath = this.getRepoPath(finalEnv);
            this.debug(`Repositorio ${finalEnv}: ${finalRepoPath}`);
          } catch (error: any) {
            return {
              ok: false,
              env: finalEnv,
              routine: routine,
              message: `Repositorio ${finalEnv} nao configurado: ${error.message}`,
              debug: { normalized, isStandard }
            };
          }
        }
      }

      // 3. Buscar arquivo
      this.debug(`Procurando arquivo no repositorio...`);
      const filePath = await this.findRoutineFile(finalRepoPath, normalized);

      if (!filePath) {
        return {
          ok: false,
          env: finalEnv,
          repoPath: finalRepoPath,
          routine: routine,
          message: `Rotina "${routine}" nao encontrada em ${finalEnv}.\n\n` +
            `Caminho pesquisado: ${finalRepoPath}\n` +
            `Variacoes procuradas:\n${normalized.variations.slice(0, 10).map(v => `  - ${v}`).join('\n')}\n` +
            (normalized.variations.length > 10 ? `  ... e mais ${normalized.variations.length - 10} variacoes` : ''),
          debug: {
            normalized,
            isStandard,
            searchedPath: finalRepoPath,
            searchedVariations: normalized.variations
          }
        };
      }

      this.debug(`Arquivo encontrado: ${filePath}`);

      // 4. Executar acao solicitada
      this.debug(`Executando acao: ${action}`);

      let result: any;

      switch (action) {
        case 'status':
          result = await this.executeStatus(filePath, finalRepoPath, baseBranch);
          break;

        case 'analyzeRoutine':
          result = await this.executeAnalyzeRoutine(filePath);
          break;

        case 'renderReportMarkdown':
          result = await this.executeRenderReportMarkdown(
            filePath,
            routine,
            mermaidMode || 'auto',
            includeSource,
            maxSourceChars,
            sourceEncoding
          );
          break;

        case 'getSourceCode':
          result = await this.executeGetSourceCode(filePath, sourceEncoding, maxSourceChars);
          break;

        default:
          return {
            ok: false,
            message: `Acao invalida: ${action}`
          };
      }

      // 5. Adicionar metadados ao resultado
      return {
        ...result,
        metadata: {
          routine: routine,
          normalizedName: normalized.baseNameUpper,
          env: finalEnv,
          repoPath: finalRepoPath,
          filePath: filePath,
          isStandard: isStandard,
          action: action,
          includeSource,
          maxSourceChars,
          sourceEncoding
        }
      };

    } catch (error: any) {
      console.error(`Erro na execucao:`, error);
      return {
        ok: false,
        message: `Erro inesperado: ${error.message}`,
        stack: error.stack
      };
    }
  }
}

// Instancia unica
const relatorioRotinaTool = new RelatorioRotinaTool();

/**
 * Wrapper MCP (objeto no formato McpTool)
 * - Mantem a classe interna com execute()
 * - Expoe run() pro servidor MCP
 * - Com schema JSON
 */
const RelatorioRotinaMcpTool: McpTool = {
  name: "RelatorioRotinaTool",
  description:
    "Analisa rotinas Protheus (status git, analise de fonte e geracao de relatorio Markdown/Mermaid), buscando no repositorio configurado por variaveis .env.",

  inputSchema: {
    type: "object",
    properties: {
      routine: {
        type: "string",
        description: "Nome da rotina Protheus a ser analisada (ex: PCMCTF43, U_PCMACD05). Obrigatorio para actions diferentes de 'searchByTable'."
      },
      action: {
        type: "string",
        enum: ["status", "analyzeRoutine", "renderReportMarkdown", "getSourceCode", "searchByTable"],
        description: "Acao a executar. Padrao: 'renderReportMarkdown'",
        default: "renderReportMarkdown"
      },
      env: {
        type: "string",
        enum: ["HML", "PRD", "TOTVS", "AUTO", "STANDARD"],
        description: "Ambiente do repositorio. AUTO detecta automaticamente. Padrao: 'AUTO'",
        default: "AUTO"
      },
      baseBranch: {
        type: "string",
        description: "Branch base para comparacao git (usado em 'status'). Padrao: 'origin/master'",
        default: "origin/master"
      },
      repoPath: {
        type: "string",
        description: "Caminho manual do repositorio (opcional, sobrescreve deteccao automatica)"
      },
      mermaidMode: {
        type: "string",
        enum: ["auto", "confluence-safe", "off"],
        description: "Modo de geracao de diagrama Mermaid. Padrao: 'auto'",
        default: "auto"
      },
      includeSource: {
        type: "boolean",
        description: "Se true, inclui o codigo-fonte no relatorio Markdown (apenas em 'renderReportMarkdown').",
        default: false
      },
      maxSourceChars: {
        type: "number",
        description: "Limite de caracteres do codigo-fonte retornado. Padrao: 180000.",
        default: 180000
      },
      sourceEncoding: {
        type: "string",
        enum: ["utf-8", "latin1"],
        description: "Encoding usado para ler o fonte. 'latin1' e recomendado para Windows-1252. Padrao: 'latin1'.",
        default: "latin1"
      },
      table: {
        type: "string",
        description: "Nome da tabela para buscar rotinas que a utilizam (obrigatorio para action 'searchByTable'). Ex: 'PD3', 'SA1', 'SC5'"
      },
      includeStandard: {
        type: "boolean",
        description: "Se true, inclui rotinas padrão TOTVS nos resultados da busca por tabela. Padrao: false",
        default: false
      },
      maxResults: {
        type: "number",
        description: "Numero maximo de resultados para busca por tabela. Padrao: 50",
        default: 50
      }
    },
    required: [],
    additionalProperties: false
  },

  async run(input: any) {
    const params = (input?.params ?? input) as RelatorioRotinaParams;
    return await relatorioRotinaTool.execute(params);
  },
};

export default RelatorioRotinaMcpTool;

// Opcional: reusar por fora
export { relatorioRotinaTool };

// Exportar funcao para uso em MCP Server
export async function executeRelatorioRotina(params: RelatorioRotinaParams): Promise<any> {
  return await relatorioRotinaTool.execute(params);
}