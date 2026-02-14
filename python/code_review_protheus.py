# -*- coding: utf-8 -*-
"""
Code Review Protheus Expert - Versão Melhorada (Legado por origem + Static var x Static Function)
Correções implementadas:
1) Diferenciação entre variáveis Static e Static Functions
2) Detecção de código legado (Private, variáveis longas, etc.) comparando também com origin/master
3) Análise de diff para identificar mudanças reais vs movimentações/identação
4) Validação inteligente: se já existia no fonte anterior (origin/master), trata como legado e NÃO acusa
5) **CORREÇÃO: Adiciona git pull antes do fetch para atualizar branch local**

Autor: Bruno Santana Gomes
Data: 2026-01-11
"""

import subprocess
import json
import sys
from pathlib import Path
import re
from datetime import datetime
import os
from collections import defaultdict
import webbrowser
import base64

# ============================================================
# Configuracoes
# ============================================================

if len(sys.argv) < 2:
    print("[ERRO] Uso: python code_review_protheus.py <REPO_PATH>")
    sys.exit(1)

REPO_PATH = sys.argv[1]
COMPARE_BRANCH = "origin/master"

os.chdir(REPO_PATH)
print(f"[INFO] Diretório atual: {os.getcwd()}")

PROJECT_EXTENSIONS = (".prw", ".prx", ".prg")
ADVPL_EXTENSIONS = (".prw", ".prx", ".ch")
CONTEXT_RADIUS = 3
HTML_OUTPUT_DIR = r"C:\Users\BRUNO~1.GOM\AppData\Local\Temp\code_review"
PROTHEUS_DOC_LOOKBACK = 40


# ============================================================
# Regex e Helpers
# ============================================================

ADVPL_ROUTINE_RE = re.compile(
    r"^\s*(user\s+function|static\s+function|static\s+procedure|class)\s+([A-Za-z_][A-Za-z0-9_]*)",
    re.IGNORECASE
)
PROTHEUS_DOC_RE = re.compile(r"\{\s*protheus\.doc\s*\}", re.IGNORECASE)
HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def esc(s):
    return "" if s is None else str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def safe_id(text):
    return re.sub(r"[^A-Za-z0-9_]+", "_", text or "").strip("_") or "x"


# ============================================================
# NOVAS FUNÇÕES PARA DETECÇÃO DE CÓDIGO LEGADO
# ============================================================

def strip_inline_comment_advpl(line: str) -> str:
    """
    Remove comentário inline iniciando com //, MAS sem quebrar URLs tipo http:// ou https://.
    Heurística:
    - Procura por '//' e só considera comentário se NÃO for precedido por ':' (evita '://').
    - Mantém o conteúdo antes do comentário.
    """
    if not line:
        return ""

    s = line
    idx = 0
    while True:
        pos = s.find("//", idx)
        if pos == -1:
            return s

        # Se for parte de '://', não é comentário
        if pos > 0 and s[pos - 1] == ":":
            idx = pos + 2
            continue

        # Caso comum: comentário mesmo
        return s[:pos]


def normalize_line(line):
    """
    Normaliza linha para comparação (ignora identação/variação de espaços e comentários).
    Evita cortar URLs com http:// ou https://.
    """
    if not line:
        return ""

    s = strip_inline_comment_advpl(line).strip()

    # Se depois de remover comentário ficou vazio, retorna vazio
    if not s:
        return ""

    # colapsa whitespace
    s = re.sub(r"\s+", " ", s)

    # remove espaços ao redor de tokens comuns que variam em reidentação
    s = re.sub(r"\s*(:=)\s*", r"\1", s)
    s = re.sub(r"\s*(,)\s*", r"\1", s)
    s = re.sub(r"\s*(\()\s*", r"\1", s)
    s = re.sub(r"\s*(\))\s*", r"\1", s)

    return s.upper()


def is_static_function_declaration(line):
    """
    Verifica se a linha contém declaração de Static Function (com espaços variáveis).

    Exemplos válidos:
    - Static Function NomeFuncao
    - Static     Function NomeFuncao  (múltiplos espaços)
    - Static Func NomeFuncao
    """
    patterns = [
        r'^\s*Static\s+Function\s+\w+',
        r'^\s*Static\s+Func\s+\w+',
    ]

    for pattern in patterns:
        if re.search(pattern, line or "", re.IGNORECASE):
            return True

    return False


def is_static_variable_declaration(line):
    """
    Verifica se a linha contém declaração de variável Static.
    Diferencia de Static Function.
    """
    if is_static_function_declaration(line):
        return False

    patterns = [
        r'^\s*Static\s+\w+\s*:=',                 # Static nVar := valor
        r'^\s*Static\s+\w+\s*$',                  # Static nVar
        r'^\s*Static\s+\w+\s*,',                  # Static nVar, nVar2
        r'^\s*Static\s+\w+\s+[Aa][Ss]\s+',        # Static nVar as Numeric
    ]

    for pattern in patterns:
        if re.search(pattern, line or "", re.IGNORECASE):
            return True

    return False


def build_removed_lines_map(file_data):
    """
    Cria um mapa de linhas removidas (normalizadas) para comparação rápida.
    """
    removed_map = {}
    for item in file_data.get("removed", []):
        normalized = normalize_line(item.get("text", ""))
        if normalized:
            removed_map.setdefault(normalized, []).append(item.get("text", ""))
    return removed_map


# ============================================================
# Git
# ============================================================

def _decode_git_output(raw: bytes) -> str:
    """Tenta decodificar saída do git: UTF-8 primeiro, fallback Latin1."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin1", errors="replace")


def run_git(cmd):
    """
    Executa git e retorna stdout. Em erro, encerra o script.
    """
    try:
        out = subprocess.check_output(["git"] + cmd, stderr=subprocess.STDOUT)
        return _decode_git_output(out).strip()
    except subprocess.CalledProcessError as e:
        print("[ERRO] Falha ao executar git:", " ".join(cmd))
        print(_decode_git_output(e.output) if isinstance(e.output, bytes) else e.output)
        sys.exit(1)


def run_git_safe(cmd):
    """
    Executa git e retorna (ok, stdout). Não encerra o script em erro.
    """
    try:
        out = subprocess.check_output(["git"] + cmd, stderr=subprocess.STDOUT)
        return True, _decode_git_output(out)
    except subprocess.CalledProcessError:
        return False, ""


def check_merge_conflicts(compare_branch):
    """
    Usa 'git merge-tree' para simular merge sem alterar a working tree.
    Retorna lista de arquivos com conflito. Requer git >= 2.38.
    """
    try:
        proc = subprocess.run(
            ["git", "merge-tree", "--write-tree", compare_branch, "HEAD"],
            capture_output=True
        )
        if proc.returncode == 0:
            return []  # merge limpo
        output = _decode_git_output(proc.stdout) + _decode_git_output(proc.stderr)
        conflicts = []
        for line in output.splitlines():
            m = re.match(r"^CONFLICT\s+\([^)]+\):\s+.*?(?:in|Merge conflict in)\s+(.+)$", line)
            if m:
                conflicts.append(m.group(1).strip())
        return conflicts
    except FileNotFoundError:
        print("[AVISO] git merge-tree nao disponivel, pulando verificacao de conflitos.")
        return []
    except Exception as exc:
        print(f"[AVISO] Erro ao verificar merge conflicts: {exc}")
        return []


def get_origin_remote_url() -> str:
    ok, out = run_git_safe(["remote", "get-url", "origin"])
    return out.strip() if ok else ""

def get_repo_display_name(repo_path: str) -> str:
    r"""
    Retorna o nome do repo a partir do caminho analisado.
    Ex: SEU_CAMINHO_PARA_REPOSITÓRIO_HML_LOCAL -> SEU_REPOSITÓRIO_BITBUCKET_HML
    """
    if not repo_path:
        return ""
    p = repo_path.rstrip("\\/ ")
    return os.path.basename(p)


def get_current_branch():
    return run_git(["rev-parse", "--abbrev-ref", "HEAD"])


def get_ahead_behind(compare_branch, current_branch):
    output = run_git([
        "rev-list",
        "--left-right",
        "--count",
        f"{compare_branch}...{current_branch}"
    ])
    behind, ahead = map(int, output.split())
    return ahead, behind


def get_project_files(base, branch):
    changed_files = run_git(["diff", "--name-only", f"{base}...{branch}"]).splitlines()
    project_files = [f for f in changed_files if f.lower().endswith(PROJECT_EXTENSIONS)]
    return project_files


def get_diff_full(base, files):
    if not files:
        return ""
    cmd = ["diff", f"{base}...HEAD", "--"] + files
    return run_git(cmd)


def get_file_content_at_ref(ref: str, file_path: str) -> str:
    """
    Lê o conteúdo do arquivo em um ref (ex: origin/master:path/arquivo.prw).
    Retorna string vazia se não existir.
    """
    ok, out = run_git_safe(["show", f"{ref}:{file_path}"])
    if not ok:
        return ""
    return out


def build_base_normalized_set(base_ref: str, file_path: str) -> set:
    """
    Set de linhas normalizadas do arquivo no base para comparação de legado.
    """
    content = get_file_content_at_ref(base_ref, file_path)
    if not content:
        return set()

    base_set = set()
    for ln in content.splitlines():
        n = normalize_line(ln)
        if n:
            base_set.add(n)
    return base_set


def base_has_identifier(base_content: str, identifier: str) -> bool:
    """
    Checa se um identificador existe no arquivo base (word boundary).
    Útil para variáveis > 10 chars mesmo quando a linha não bate 100%.
    """
    if not base_content or not identifier:
        return False
    return bool(re.search(rf"\b{re.escape(identifier)}\b", base_content, re.IGNORECASE))


def is_legacy_code(added_line_text, removed_lines_map, base_norm_set=None):
    """
    Legado se:
    - a linha (normalizada) aparece nas removidas do diff (movimento/identação), OU
    - a linha (normalizada) existe em qualquer lugar do arquivo no base (origin/master)
    """
    normalized_added = normalize_line(added_line_text)

    # linha vazia => não é "violação nova"
    if not normalized_added:
        return True

    # Comentário puro (depois de strip) => ignora
    if normalized_added.startswith("//"):
        return True

    if normalized_added in removed_lines_map:
        return True

    if base_norm_set and normalized_added in base_norm_set:
        return True

    return False


def update_repository():
    """
    Atualiza o repositório local seguindo a ordem correta:
    1. git fetch origin - baixa as mudanças remotas (atualiza refs como origin/master)
    2. git pull origin <branch> - atualiza a branch local atual com merge
    
    CORREÇÃO: Ordem correta de atualização do repositório
    """
    current_branch = get_current_branch()
    
    # PASSO 1: Fetch - atualiza referências remotas
    print("[INFO] Atualizando referências remotas (git fetch origin)...")
    run_git(["fetch", "origin"])
    print("[INFO] Referências remotas atualizadas (origin/master, etc)")
    
    # PASSO 2: Pull - atualiza branch local (usa git pull sem branch para evitar encoding)
    print(f"[INFO] Atualizando branch local '{current_branch}' (git pull)...")
    ok, output = run_git_safe(["pull"])
    
    if not ok:
        print("[AVISO] git pull falhou. Possíveis causas:")
        print("  - Branch não tem upstream configurado")
        print("  - Há conflitos locais")
        print("  - Sem conexão com o repositório remoto")
        print("[INFO] Continuando com as referências já atualizadas pelo fetch...")
    else:
        if "Already up to date" in output or "Já está atualizado" in output:
            print("[INFO] Branch local já está atualizada")
        else:
            print("[INFO] Branch local atualizada com sucesso")


# ============================================================
# Parsing Diff
# ============================================================

def parse_unified_diff(diff_text):
    result = {"files": {}}
    current_file = None
    old_line = new_line = None
    lines = diff_text.splitlines()

    for raw in lines:
        if raw.startswith("diff --git "):
            current_file = None
            old_line = new_line = None
            continue

        if raw.startswith("+++ b/"):
            current_file = raw.replace("+++ b/", "").strip()
            result["files"][current_file] = {"added": [], "removed": [], "all": []}
            continue

        m = HUNK_RE.match(raw)
        if m:
            old_line = int(m.group(1))
            new_line = int(m.group(3))
            continue

        if current_file is None:
            continue

        if raw.startswith("--- ") or raw.startswith("index ") or raw.startswith("new file") or raw.startswith("deleted file"):
            continue

        if raw.startswith("\\ No newline at end of file"):
            continue

        if old_line is None or new_line is None:
            continue

        sign = raw[:1]
        text = raw[1:] if len(raw) > 0 else ""

        if sign == "+":
            result["files"][current_file]["added"].append({"line_no": new_line, "text": text})
            result["files"][current_file]["all"].append({"sign": "+", "line_no": new_line, "text": text})
            new_line += 1
        elif sign == "-":
            result["files"][current_file]["removed"].append({"line_no": old_line, "text": text})
            result["files"][current_file]["all"].append({"sign": "-", "line_no": old_line, "text": text})
            old_line += 1
        else:
            result["files"][current_file]["all"].append({"sign": " ", "line_no": new_line, "text": text})
            old_line += 1
            new_line += 1

    return result


def add_context_to_violations(parsed, violations, radius=3):
    """Adiciona linhas de contexto ao redor no diff"""
    for v in violations:
        file_diff = parsed["files"].get(v["arquivo"], {})
        all_lines = file_diff.get("all", [])

        for occ in v.get("ocorrencias", []):
            line_no = occ.get("line_no")
            ctx_lines = []

            for l in all_lines:
                if line_no is not None and abs(l["line_no"] - line_no) <= radius:
                    ctx_lines.append(l)

            occ["contexto"] = ctx_lines

            if occ.get("is_legacy"):
                occ["legacy_info"] = "Código legado (já existia no fonte anterior: origin/master)"


# ============================================================
# Linguagem
# ============================================================

def detect_language_from_line(text):
    t = (text or "").lower()
    if re.search(r"\b(select|insert|update|delete|merge)\b", t):
        return "sql"
    return "advpl"


def extract_routine_info(line_text):
    m = ADVPL_ROUTINE_RE.search(line_text or "")
    if not m:
        return None
    return {"tipo": m.group(1).title(), "nome": m.group(2)}


def has_protheus_doc_near(file_all_lines, line_no, lookback=PROTHEUS_DOC_LOOKBACK):
    for x in file_all_lines:
        if line_no - lookback <= x["line_no"] <= line_no:
            if PROTHEUS_DOC_RE.search(x.get("text", "")):
                return True
    return False


# ============================================================
# Regras
# ============================================================

def compile_rule(rule):
    if rule.get("match") == "regex":
        flags = re.IGNORECASE if rule.get("ignore_case") else 0
        try:
            rule["_compiled"] = re.compile(rule.get("padrao", ""), flags)
        except Exception:
            rule["_compiled"] = None
    return rule


def line_matches_rule(rule, line_text):
    match_type = (rule.get("match") or "contains").lower()
    padrao = rule.get("padrao", "")

    if match_type == "contains":
        return padrao in (line_text or "")
    if match_type == "regex":
        return bool(rule.get("_compiled").search(line_text or "")) if rule.get("_compiled") else False
    return False


def analyze_rules_on_diff(parsed, rules):
    """
    Analisa as regras aplicadas no diff com DETECÇÃO DE CÓDIGO LEGADO:
    - Legado se a linha já existia no origin/master (mesmo sem aparecer como removed no diff)
    """
    violations = []
    compiled_rules = [compile_rule(dict(r)) for r in rules]

    for file_path, data in parsed["files"].items():
        file_lower = (file_path or "").lower()
        is_advpl = file_lower.endswith(ADVPL_EXTENSIONS)
        added_lines = data.get("added", [])

        # Mapa de removidas do diff (movimento/reidentação)
        removed_lines_map = build_removed_lines_map(data)

        # NOVO: base do arquivo (origin/master) para legado
        base_content = get_file_content_at_ref(COMPARE_BRANCH, file_path)
        base_norm_set = build_base_normalized_set(COMPARE_BRANCH, file_path)

        for rule in compiled_rules:
            rule_lang = (rule.get("linguagem") or "advpl").lower()
            if rule_lang == "advpl" and not is_advpl:
                continue

            rule_id = rule.get("id", "")

            # ======================================================
            # Normativa 3.1 - Protheus.doc
            # ======================================================
            if rule_id == "Normativa 3.1":
                file_all = data.get("all", [])

                for it in added_lines:
                    info = extract_routine_info(it.get("text", ""))
                    if not info:
                        continue

                    if not has_protheus_doc_near(file_all, it["line_no"], lookback=PROTHEUS_DOC_LOOKBACK):
                        # Aqui faz sentido continuar acusando se a rotina/classe foi adicionada de fato no diff
                        violations.append({
                            "id": rule.get("id"),
                            "descricao": rule.get("descricao"),
                            "severidade": rule.get("severidade"),
                            "arquivo": file_path,
                            "ocorrencias": [{
                                "line_no": it["line_no"],
                                "text": it.get("text", ""),
                                "info": f"Rotina/Classe '{info['nome']}' sem Protheus.doc",
                                "is_legacy": False
                            }]
                        })
                continue

            # ======================================================
            # Normativa 3.19 - Conditional
            # ======================================================
            if rule_id == "Normativa 3.19":
                has_class = any(
                    re.search(r"\bClass\b", line["text"] or "", re.IGNORECASE)
                    for line in added_lines
                )

                if has_class:
                    has_dummy = any(
                        re.search(r"^\s*User\s+Function\s+", line["text"] or "", re.IGNORECASE)
                        for line in added_lines
                    )

                    if not has_dummy:
                        violations.append({
                            "id": rule.get("id"),
                            "descricao": rule.get("descricao"),
                            "severidade": rule.get("severidade"),
                            "arquivo": file_path,
                            "ocorrencias": [{
                                "line_no": None,
                                "text": "(arquivo todo)",
                                "info": "Arquivo com 'Class' mas sem 'User Function' dummy",
                                "is_legacy": False
                            }]
                        })
                continue

            # ======================================================
            # Normativa 3.21-2 (Static)
            # - acusa apenas variáveis Static no escopo global
            # - ignora Static Function / Static Func
            # - se a linha já existia no base => legado
            # ======================================================
            if rule_id == "Normativa 3.21-2":
                found_occurrences = []

                for it in added_lines:
                    line_text = it.get("text", "")

                    if is_static_variable_declaration(line_text):
                        is_legacy = is_legacy_code(line_text, removed_lines_map, base_norm_set)
                        found_occurrences.append({
                            "line_no": it["line_no"],
                            "text": line_text,
                            "is_legacy": is_legacy
                        })

                real_violations = [occ for occ in found_occurrences if not occ.get("is_legacy")]
                legacy_code = [occ for occ in found_occurrences if occ.get("is_legacy")]

                if real_violations:
                    violations.append({
                        "id": rule.get("id"),
                        "descricao": rule.get("descricao"),
                        "severidade": rule.get("severidade"),
                        "arquivo": file_path,
                        "ocorrencias": real_violations,
                        "legacy_count": len(legacy_code)
                    })

                continue

            # ======================================================
            # Normativa 3.21-3 (Private)
            # - acusa apenas novos usos de Private
            # - se a linha já existia no base => legado
            # ======================================================
            if rule_id == "Normativa 3.21-3":
                found_occurrences = []

                for it in added_lines:
                    line_text = it.get("text", "")

                    if re.search(r'\bPrivate\b', line_text or "", re.IGNORECASE):
                        is_legacy = is_legacy_code(line_text, removed_lines_map, base_norm_set)
                        found_occurrences.append({
                            "line_no": it["line_no"],
                            "text": line_text,
                            "is_legacy": is_legacy
                        })

                real_violations = [occ for occ in found_occurrences if not occ.get("is_legacy")]
                legacy_code = [occ for occ in found_occurrences if occ.get("is_legacy")]

                if real_violations:
                    violations.append({
                        "id": rule.get("id"),
                        "descricao": (rule.get("descricao") or "") + " (novos usos apenas)",
                        "severidade": rule.get("severidade"),
                        "arquivo": file_path,
                        "ocorrencias": real_violations,
                        "legacy_count": len(legacy_code)
                    })

                continue

            # ======================================================
            # Normativa 3.23 (Variáveis > 10 chars)
            # - acusa apenas novas variáveis
            # - se o NOME já existia no base => legado (mesmo que a linha não bata igual)
            # ======================================================
            if rule_id == "Normativa 3.23":
                found_occurrences = []

                var_pattern = re.compile(
                    r'\b(Local|Private|Public|Static)\s+([A-Za-z][A-Za-z0-9_]{10,})\b',
                    re.IGNORECASE
                )

                for it in added_lines:
                    line_text = it.get("text", "")

                    for match in var_pattern.finditer(line_text or ""):
                        var_name = match.group(2)

                        is_legacy_line = is_legacy_code(line_text, removed_lines_map, base_norm_set)
                        is_legacy_name = base_has_identifier(base_content, var_name)
                        is_legacy = is_legacy_line or is_legacy_name

                        found_occurrences.append({
                            "line_no": it["line_no"],
                            "text": line_text,
                            "info": f"Variável '{var_name}' com {len(var_name)} caracteres",
                            "is_legacy": is_legacy
                        })

                real_violations = [occ for occ in found_occurrences if not occ.get("is_legacy")]
                legacy_code = [occ for occ in found_occurrences if occ.get("is_legacy")]

                if real_violations:
                    violations.append({
                        "id": rule.get("id"),
                        "descricao": (rule.get("descricao") or "") + " (novas variáveis apenas)",
                        "severidade": rule.get("severidade"),
                        "arquivo": file_path,
                        "ocorrencias": real_violations,
                        "legacy_count": len(legacy_code)
                    })

                continue

            # ======================================================
            # Regras genéricas (aplicadas normalmente)
            # - para alvo=added, se a linha já existia no base => legado => não acusa
            # ======================================================
            alvo = (rule.get("alvo") or "added").lower()
            target_lines = added_lines if alvo == "added" else data.get("removed", [])

            found_occurrences = []
            for it in target_lines:
                line_text = it.get("text", "")
                lang_line = detect_language_from_line(line_text)

                if rule_lang != "advpl" and lang_line != rule_lang:
                    continue

                if line_matches_rule(rule, line_text):
                    is_legacy = False
                    if alvo == "added":
                        is_legacy = is_legacy_code(line_text, removed_lines_map, base_norm_set)

                    found_occurrences.append({
                        "line_no": it["line_no"],
                        "text": line_text,
                        "is_legacy": is_legacy
                    })

            real_violations = [occ for occ in found_occurrences if not occ.get("is_legacy")]
            legacy_code = [occ for occ in found_occurrences if occ.get("is_legacy")]

            if real_violations:
                violations.append({
                    "id": rule.get("id"),
                    "descricao": rule.get("descricao"),
                    "severidade": rule.get("severidade"),
                    "arquivo": file_path,
                    "ocorrencias": real_violations,
                    "legacy_count": len(legacy_code)
                })

    return violations


# ============================================================
# HTML Report Generation
# ============================================================

def generate_html_report(meta, violations, html_file):
    """
    HTML GitHub-like com:
    - Dark/Light toggle
    - Watermark (identidade visual Petz Cobasi) via CSS var --brand-bg
    - Destaque roxo no contador de violações
    - Cores consistentes para severidade (ALTA/MEDIA/BAIXA) no cabeçalho, borda e badge
    - Mostra somente a linha do problema e botão "Ver contexto"
    """
    repo_display = meta.get("repo_display_name", "") or "(repo não identificado)"
    

    html = []
    html.append("<!DOCTYPE html>")
    html.append('<html lang="pt-BR">')
    html.append("<head>")
    html.append('<meta charset="UTF-8">')
    html.append('<meta name="viewport" content="width=device-width, initial-scale=1.0">')
    html.append(f"<title>Code Review PROTHEUS - {esc(meta.get('branch_atual'))}</title>")

    html.append("<style>")
    html.append(r"""
:root{
  --bg: #f6f8fa;
  --panel: #ffffff;
  --panel2: #f6f8fa;
  --text: #1f2328;
  --muted: #57606a;
  --border: #d0d7de;
  --accent: #0969da; /* github blue */

  /* Destaque roxo (contador de violações) */
  --violet: #a855f7;
  --violet-soft: rgba(168,85,247,.16);

  /* Severidades */
  --sev-high: #ef4444;        /* ALTA */
  --sev-high-soft: rgba(239,68,68,.14);

  --sev-med: #f59e0b;         /* MEDIA */
  --sev-med-soft: rgba(245,158,11,.16);

  --sev-low: #22c55e;         /* BAIXA */
  --sev-low-soft: rgba(34,197,94,.14);

  --sev-crit: #dc2626;        /* CRITICA (merge conflict) */
  --sev-crit-soft: rgba(220,38,38,.18);

  --codebg: #0b1020;
  --codetext: #e6edf3;
  --addedbg: rgba(46,160,67,.15);
  --removedbg: rgba(248,81,73,.15);
}

[data-theme="dark"]{
  --bg: #0d1117;
  --panel: #161b22;
  --panel2: #0d1117;
  --text: #e6edf3;
  --muted: #8b949e;
  --border: #30363d;
  --accent: #2f81f7;

  --violet: #c084fc;
  --violet-soft: rgba(192,132,252,.16);

  --sev-high: #ff5a5f;
  --sev-high-soft: rgba(255,90,95,.18);

  --sev-med: #fbbf24;
  --sev-med-soft: rgba(251,191,36,.18);

  --sev-low: #2ea043;
  --sev-low-soft: rgba(46,160,67,.18);

  --sev-crit: #ff3333;
  --sev-crit-soft: rgba(255,51,51,.22);

  --addedbg: rgba(46,160,67,.18);
  --removedbg: rgba(248,81,73,.18);
  --brand-opacity: .08; /* dark */
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body{
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
  background: var(--bg);
  color: var(--text);
  padding: 20px;
}

.container{
  position: relative;
  z-index: 1;
  max-width: 1400px;
  margin: 0 auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.header{
  padding: 22px 26px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, var(--panel) 0%, var(--panel2) 100%);
}

.header h1{ font-size: 1.8em; margin-bottom: 6px; }
.header p{ color: var(--muted); }

.meta-info{
  padding: 18px 26px;
  border-bottom: 1px solid var(--border);
  background: var(--panel2);
}

.meta-grid{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

.meta-item{
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
}

.meta-label{
  font-size: .78em;
  text-transform: uppercase;
  letter-spacing: .04em;
  color: var(--muted);
  margin-bottom: 6px;
}

.meta-value{
  color: var(--text);
  font-size: 1.02em;
  word-break: break-word;
}

.summary{
  padding: 18px 26px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  background: var(--panel);
}

.summary-box{
  min-width: 170px;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--panel2);
}

.summary-box.primary{
  border-color: rgba(168,85,247,.45);
  box-shadow: 0 0 0 3px var(--violet-soft);
}

.summary-number{
  font-size: 2.15em;
  font-weight: 900;
  display: block;
  color: var(--violet);
  text-shadow: 0 0 18px var(--violet-soft);
}

.summary-label{ color: var(--muted); margin-top: 4px; font-size: .92em; }

.controls{
  padding: 14px 26px;
  border-bottom: 1px solid var(--border);
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--panel2);
}

.controls label{ color: var(--muted); font-size: .95em; }

.controls select, .controls input{
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  color: var(--text);
  font-size: 1em;
}

.controls input{ flex: 1; min-width: 280px; }

#statusText{ margin-left: auto; color: var(--muted); font-weight: 600; }

.theme-toggle{
  display:flex; align-items:center; gap:8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  user-select:none;
  cursor:pointer;
}
.theme-dot{ width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
.theme-toggle span{ color: var(--muted); font-weight: 600; font-size:.92em; }

.content{ padding: 22px 26px; }

.file-block{
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow:hidden;
  margin-bottom: 16px;
  background: var(--panel);
}

.file-header{
  padding: 12px 14px;
  display:flex;
  justify-content: space-between;
  align-items:center;
  background: var(--panel2);
  border-bottom: 1px solid var(--border);
  font-weight: 700;
}

.file-badge{
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 10px;
  color: var(--muted);
  font-weight: 700;
  font-size: .86em;
}

.violation-item{
  margin: 12px;
  border: 1px solid var(--border);
  border-left: 6px solid var(--sev-high);
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
}
.violation-item.sev-ALTA{ border-left-color: var(--sev-high); }
.violation-item.sev-MEDIA{ border-left-color: var(--sev-med); }
.violation-item.sev-BAIXA{ border-left-color: var(--sev-low); }
.violation-item.sev-CRITICA{ border-left-color: var(--sev-crit); border-left-width: 8px; }

.violation-item.sev-ALTA .violation-header{ background: linear-gradient(90deg, var(--sev-high-soft), var(--panel2) 55%); }
.violation-item.sev-MEDIA .violation-header{ background: linear-gradient(90deg, var(--sev-med-soft), var(--panel2) 55%); }
.violation-item.sev-BAIXA .violation-header{ background: linear-gradient(90deg, var(--sev-low-soft), var(--panel2) 55%); }
.violation-item.sev-CRITICA .violation-header{ background: linear-gradient(90deg, var(--sev-crit-soft), var(--panel2) 55%); }

.violation-header{
  padding: 12px 14px;
  display:flex;
  justify-content: space-between;
  align-items:center;
  gap: 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
}

.violation-title{
  font-weight: 800;
  font-size: 1.02em;
  flex: 1;
  min-width: 240px;
}

.badges{ display:flex; gap: 8px; flex-wrap: wrap; }

.badge{
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  padding: 4px 10px;
  border-radius: 999px;
  font-size: .8em;
  font-weight: 800;
  text-transform: uppercase;
}

.badge-sev{
  border-color: transparent;
  color: #fff;
}
.badge-sev.sev-ALTA{ background: var(--sev-high); }
.badge-sev.sev-MEDIA{ background: var(--sev-med); color: #111827; }
.badge-sev.sev-BAIXA{ background: var(--sev-low); }
.badge-sev.sev-CRITICA{ background: var(--sev-crit); }

/* Banner de RECUSADO */
.refused-banner{
  margin: 18px 26px;
  padding: 18px 22px;
  border: 2px solid var(--sev-crit);
  border-radius: 12px;
  background: var(--sev-crit-soft);
  text-align: center;
}
.refused-banner-title{
  font-size: 1.6em;
  font-weight: 900;
  color: var(--sev-crit);
  margin-bottom: 6px;
}
.refused-banner-text{
  color: var(--text);
  font-size: 1em;
}

.occurrence{
  padding: 12px 14px;
  border-top: 1px solid var(--border);
}

.occurrence-header{
  display:flex;
  justify-content: space-between;
  align-items:center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.line-number{ color: var(--accent); font-weight: 900; }

.code-block{
  background: var(--codebg);
  color: var(--codetext);
  border: 1px solid #111827;
  padding: 12px;
  border-radius: 12px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace;
  font-size: .92em;
  line-height: 1.5;
}

.code-line{
  display:block;
  padding: 2px 0;
  white-space: pre;
}

.code-line.added{
  background: var(--addedbg);
  border-left: 3px solid #2ea043;
  padding-left: 10px;
}

.code-line.removed{
  background: var(--removedbg);
  border-left: 3px solid #f85149;
  padding-left: 10px;
}

.ctx-btn{
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  padding: 6px 10px;
  border-radius: 10px;
  font-weight: 800;
  cursor: pointer;
  font-size: .85em;
}
.ctx-btn:hover{ border-color: var(--accent); color: var(--text); }

.ctx-wrap{ margin-top: 10px; display:none; }
.ctx-wrap.open{ display:block; }

.btn-top{
  position: fixed;
  bottom: 26px;
  right: 26px;
  width: 48px; height: 48px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  font-size: 1.2em;
  cursor:pointer;
  display:none;
  box-shadow: 0 10px 30px rgba(0,0,0,.25);
}
.btn-top:hover{ border-color: var(--accent); }

.hidden{ display:none !important; }

.empty-state{
  text-align:center;
  padding: 48px 10px;
  color: var(--muted);
}
.empty-state-icon{ font-size: 3.2em; margin-bottom: 14px; }
.empty-state-text{ font-size: 1.25em; font-weight: 900; color: var(--text); margin-bottom: 6px; }
.empty-state-subtext{ color: var(--muted); }
""")

    html.append("</style>")
    html.append("</head>")
    html.append("<body>")

    html.append('<div class="container">')

    html.append('<div class="header">')
    html.append('<h1>📋 Code Review PROTHEUS</h1>')
    html.append(f'<p>Branch: <strong>{esc(meta.get("branch_atual"))}</strong></p>')
    html.append('</div>')

    # META: "Repositório (origin)" mostra o repo_display_name
    html.append('<div class="meta-info">')
    html.append('<div class="meta-grid">')

    html.append('<div class="meta-item">')
    html.append('<div class="meta-label">Repositório (origin)</div>')
    html.append(f'<div class="meta-value">{esc(repo_display)}</div>')
    html.append('</div>')

    html.append('<div class="meta-item">')
    html.append('<div class="meta-label">Branch Comparada</div>')
    html.append(f'<div class="meta-value">{esc(meta.get("compare_branch"))}</div>')
    html.append('</div>')

    html.append('<div class="meta-item">')
    html.append('<div class="meta-label">Commits à Frente</div>')
    html.append(f'<div class="meta-value">{meta.get("ahead_commits", 0)}</div>')
    html.append('</div>')

    html.append('<div class="meta-item">')
    html.append('<div class="meta-label">Arquivos Alterados</div>')
    html.append(f'<div class="meta-value">{meta.get("arquivos_alterados", 0)}</div>')
    html.append('</div>')

    html.append('<div class="meta-item">')
    html.append('<div class="meta-label">Data da Execução</div>')
    html.append(f'<div class="meta-value">{esc(meta.get("data_execucao"))}</div>')
    html.append('</div>')

    html.append('</div>')
    html.append('</div>')

    # Banner RECUSADO (merge conflicts)
    conflict_files = meta.get("conflict_files", [])
    if conflict_files:
        html.append('<div class="refused-banner">')
        html.append('<div class="refused-banner-title">RECUSADO - Merge Conflicts Detectados</div>')
        html.append(f'<div class="refused-banner-text">{len(conflict_files)} arquivo(s) possuem conflitos com <strong>{esc(meta.get("compare_branch"))}</strong>.<br>')
        html.append('O DEV deve atualizar a branch (merge/rebase de master) e resolver os conflitos antes de reenviar.</div>')
        html.append('<div style="margin-top:12px;text-align:left;max-width:700px;margin-left:auto;margin-right:auto;">')
        for cf in conflict_files:
            html.append(f'<div style="font-family:monospace;font-size:.92em;padding:3px 0;color:var(--sev-crit);">&#x26A0; {esc(cf)}</div>')
        html.append('</div>')
        html.append('</div>')

    # Summary
    total_violations = len(violations)
    total_legacy = sum(v.get("legacy_count", 0) for v in violations)

    severity_counts = defaultdict(int)
    for v in violations:
        sev = v.get("severidade", "MEDIA")
        severity_counts[sev] += len(v.get("ocorrencias", []))

    html.append('<div class="summary">')
    html.append(f'<div class="summary-box primary"><span class="summary-number">{total_violations}</span><div class="summary-label">Violações Ativas</div></div>')
    if severity_counts.get("CRITICA", 0) > 0:
        html.append(f'<div class="summary-box"><span class="summary-number" style="color:var(--sev-crit);text-shadow:0 0 14px var(--sev-crit-soft);">{severity_counts.get("CRITICA", 0)}</span><div class="summary-label">Merge Conflicts</div></div>')
    html.append(f'<div class="summary-box"><span class="summary-number" style="color:var(--sev-high);text-shadow:0 0 14px var(--sev-high-soft);">{severity_counts.get("ALTA", 0)}</span><div class="summary-label">Alta Severidade</div></div>')
    html.append(f'<div class="summary-box"><span class="summary-number" style="color:var(--sev-med);text-shadow:0 0 14px var(--sev-med-soft);">{severity_counts.get("MEDIA", 0)}</span><div class="summary-label">Média Severidade</div></div>')
    html.append(f'<div class="summary-box"><span class="summary-number" style="color:var(--sev-low);text-shadow:0 0 14px var(--sev-low-soft);">{severity_counts.get("BAIXA", 0)}</span><div class="summary-label">Baixa Severidade</div></div>')
    html.append(f'<div class="summary-box"><span class="summary-number" style="color:var(--muted);text-shadow:none;">{total_legacy}</span><div class="summary-label">Código Legado Detectado</div></div>')
    html.append('</div>')

    # Controls + Theme Toggle
    html.append('<div class="controls">')
    html.append('<label for="sevFilter">Severidade:</label>')
    html.append('<select id="sevFilter">')
    html.append('<option value="">Todas</option>')
    html.append('<option value="CRITICA">Crítica (Conflicts)</option>')
    html.append('<option value="ALTA">Alta</option>')
    html.append('<option value="MEDIA">Média</option>')
    html.append('<option value="BAIXA">Baixa</option>')
    html.append('</select>')
    html.append('<input type="text" id="searchBox" placeholder="🔍 Buscar no código ou descrição...">')
    html.append('<div class="theme-toggle" id="themeToggle" title="Alternar tema">')
    html.append('<div class="theme-dot"></div><span id="themeLabel">Dark</span>')
    html.append('</div>')
    html.append('<span id="statusText"></span>')
    html.append('</div>')

    html.append('<div class="content">')

    if not violations:
        html.append('<div class="empty-state">')
        html.append('<div class="empty-state-icon">✅</div>')
        html.append('<div class="empty-state-text">Nenhuma Violação Encontrada!</div>')
        html.append('<div class="empty-state-subtext">Seu código está em conformidade com a Normativa PROTHEUS.</div>')
        html.append('</div>')
    else:
        violations_by_file = defaultdict(list)
        for v in violations:
            violations_by_file[v["arquivo"]].append(v)

        for file_path, file_violations in violations_by_file.items():
            html.append(f'<div class="file-block" data-file="{esc(file_path)}">')
            html.append('<div class="file-header">')
            html.append(f'<span>{esc(file_path)}</span>')
            html.append(f'<span class="file-badge">{len(file_violations)} violações</span>')
            html.append('</div>')

            for v in file_violations:
                sev = v.get("severidade", "MEDIA")  # "ALTA" | "MEDIA" | "BAIXA"
                rule_id = v.get("id", "")
                desc = v.get("descricao", "")
                legacy_count = v.get("legacy_count", 0)

                html.append(f'<div class="violation-item sev-{esc(sev)}" data-severity="{esc(sev)}" data-rule="{esc(rule_id)}">')
                html.append('<div class="violation-header">')
                html.append(f'<div class="violation-title">{esc(desc)}</div>')
                html.append('<div class="badges">')
                html.append(f'<span class="badge">{esc(rule_id)}</span>')
                html.append(f'<span class="badge badge-sev sev-{esc(sev)}">{esc(sev)}</span>')
                if legacy_count > 0:
                    html.append(f'<span class="badge">+{legacy_count} legado</span>')
                html.append('</div>')
                html.append('</div>')

                # mostra SÓ a linha do problema (+) e botão para contexto
                for occ_idx, occ in enumerate(v.get("ocorrencias", [])):
                    line_no = occ.get("line_no")
                    text = occ.get("text", "")
                    info = occ.get("info", "")
                    ctx = occ.get("contexto", []) or []
                    ctx_id = safe_id(f"{file_path}_{rule_id}_{line_no}_{occ_idx}")

                    html.append(f'<div class="occurrence" data-text="{esc(text)}">')
                    html.append('<div class="occurrence-header">')
                    if line_no:
                        html.append(f'<span class="line-number">Linha {line_no}</span>')
                    if info:
                        html.append(f'<span style="color: var(--muted); font-size: .92em;">{esc(info)}</span>')
                    if ctx:
                        html.append(f'<button class="ctx-btn" type="button" data-ctx="{ctx_id}">Ver contexto</button>')
                    html.append('</div>')

                    html.append('<div class="code-block">')
                    html.append(f'<span class="code-line added">+ {esc(text)}</span>')
                    html.append('</div>')

                    if ctx:
                        html.append(f'<div class="ctx-wrap" id="{ctx_id}">')
                        html.append('<div class="code-block" style="margin-top:10px;">')
                        for c in ctx:
                            sign = c.get("sign", " ")
                            c_text = esc(c.get("text", ""))
                            c_class = "added" if sign == "+" else ("removed" if sign == "-" else "")
                            html.append(f'<span class="code-line {c_class}">{sign} {c_text}</span>')
                        html.append('</div>')
                        html.append('</div>')

                    html.append('</div>')

                html.append('</div>')

            html.append('</div>')

    html.append('</div>')
    html.append('</div>')

    html.append('<button class="btn-top" id="btnTop">↑</button>')

    html.append('<script>')
    html.append(r"""
(function(){
  const root = document.documentElement;
  const sevFilter = document.getElementById('sevFilter');
  const searchBox = document.getElementById('searchBox');
  const statusText = document.getElementById('statusText');
  const btnTop = document.getElementById('btnTop');
  const themeToggle = document.getElementById('themeToggle');
  const themeLabel = document.getElementById('themeLabel');

  function normalize(s){ return (s||'').toUpperCase().trim(); }

  function setTheme(t){
    if(t === 'dark'){
      root.setAttribute('data-theme','dark');
      themeLabel.textContent = 'Dark';
    }else{
      root.removeAttribute('data-theme');
      themeLabel.textContent = 'Light';
    }
    localStorage.setItem('cr_theme', t);
  }

  const saved = localStorage.getItem('cr_theme');
  if(saved) setTheme(saved);
  else setTheme('dark'); // default

  themeToggle.addEventListener('click', ()=>{
    const current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
  });

  function applyFilters(){
    const sev = sevFilter.value;
    const q = normalize(searchBox.value);

    const blocks = document.querySelectorAll('.file-block');
    let shown = 0;

    blocks.forEach(block=>{
      let anyShownInFile = false;
      const violations = block.querySelectorAll('.violation-item');

      violations.forEach(v=>{
        let showViolation = true;

        if(sev && v.getAttribute('data-severity') !== sev) showViolation = false;

        const vText = normalize(v.textContent);

        if(q && vText.indexOf(q) === -1) {
          let occMatch = false;
          const occs = v.querySelectorAll('.occurrence');
          occs.forEach(o=>{
            const oText = normalize(o.getAttribute('data-text'));
            if(oText.indexOf(q) !== -1) occMatch = true;
          });
          if(!occMatch) showViolation = false;
        }

        if(showViolation){
          v.classList.remove('hidden');
          anyShownInFile = true;
          shown++;
        }else{
          v.classList.add('hidden');
        }
      });

      if(anyShownInFile) block.classList.remove('hidden');
      else block.classList.add('hidden');
    });

    statusText.textContent = shown ? (shown + ' violação(ões) visível(is)') : 'Nenhuma violação com esse filtro';
  }

  sevFilter.addEventListener('change', applyFilters);
  searchBox.addEventListener('input', applyFilters);

  window.addEventListener('scroll', function(){
    btnTop.style.display = (window.pageYOffset > 300) ? 'block' : 'none';
  });

  btnTop.addEventListener('click', function(){
    window.scrollTo({top:0, behavior:'smooth'});
  });

  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-ctx]');
    if(!btn) return;
    const id = btn.getAttribute('data-ctx');
    const el = document.getElementById(id);
    if(!el) return;
    const open = el.classList.toggle('open');
    btn.textContent = open ? 'Ocultar contexto' : 'Ver contexto';
  });

  applyFilters();
})();
""")
    html.append('</script>')

    html.append("</body>")
    html.append("</html>")

    with open(html_file, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(html))





# ============================================================
# Rules loader
# ============================================================

def _build_conflict_violations(conflict_files):
    """
    Constroi violacoes de merge conflict no formato padrao do code review.
    Cada arquivo com conflito gera uma violacao com severidade CRITICA.
    """
    if not conflict_files:
        return []
    violations = []
    for cfile in conflict_files:
        violations.append({
            "id": "MERGE_CONFLICT",
            "descricao": "Merge conflict detectado - branch desatualizada com master",
            "severidade": "CRITICA",
            "arquivo": cfile,
            "ocorrencias": [{
                "line_no": None,
                "text": "(arquivo inteiro)",
                "info": f"O arquivo '{cfile}' possui conflitos com {COMPARE_BRANCH}. "
                        "O DEV deve atualizar a branch (merge/rebase de master) e resolver os conflitos antes de reenviar.",
                "is_legacy": False,
                "contexto": []
            }],
            "legacy_count": 0
        })
    return violations


def load_rules():
    script_dir = Path(__file__).resolve().parent
    rules_path = script_dir / "rules.json"

    if not rules_path.exists():
        print(f"[ERRO] rules.json nao encontrado em: {rules_path}")
        sys.exit(1)

    try:
        with open(rules_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except UnicodeDecodeError:
        with open(rules_path, "r", encoding="cp1252") as f:
            return json.load(f)


# ============================================================
# Main
# ============================================================

def main():
    os.chdir(REPO_PATH)
    print(f"[INFO] Diretório atual: {os.getcwd()}")

    os.makedirs(HTML_OUTPUT_DIR, exist_ok=True)

    CURRENT_BRANCH = get_current_branch()
    print(f"[INFO] Branch atual: {CURRENT_BRANCH}")
    print(f"[INFO] Comparando contra: {COMPARE_BRANCH}")

    # CORREÇÃO: Atualiza repositório (pull + fetch)
    update_repository()

    # Verifica merge conflicts contra a branch de comparação
    conflict_files = check_merge_conflicts(COMPARE_BRANCH)
    if conflict_files:
        print(f"[AVISO] Merge conflicts detectados em {len(conflict_files)} arquivo(s):")
        for cf in conflict_files:
            print(f"  - {cf}")
    else:
        print("[INFO] Nenhum merge conflict detectado.")

    # Usa HEAD em vez do nome da branch para evitar problemas de encoding
    ahead, behind = get_ahead_behind(COMPARE_BRANCH, "HEAD")
    print(f"[INFO] Commits à frente (analisados): {ahead}")
    print(f"[INFO] Commits atrás (ignorado): {behind}")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    html_file = os.path.join(
        HTML_OUTPUT_DIR,
        f"code_review_{CURRENT_BRANCH}_{timestamp}.html"
    )

    repo_display = get_repo_display_name(REPO_PATH)

    # EARLY EXIT: nenhum commit aberto
    if ahead == 0:
        print("[INFO] Nenhum commit aberto para validação.")
        violations = []

        # Mesmo sem commits, verifica conflitos
        conflict_violations = _build_conflict_violations(conflict_files)
        violations.extend(conflict_violations)

        has_conflicts = len(conflict_files) > 0
        review_status = "RECUSADO" if has_conflicts else "OK"

        meta = {
            "branch_atual": CURRENT_BRANCH,
            "compare_branch": COMPARE_BRANCH,
            "ahead_commits": ahead,
            "behind_commits": behind,
            "arquivos_alterados": 0,
            "arquivos_listados": [],
            "arquivos_advpl": [],
            "data_execucao": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
            "conflict_files": conflict_files,

            # se quiser manter origin_url no meta (não aparece no HTML, mas ok)
            "origin_url": get_origin_remote_url(),
        }

        # >>> adiciona DEPOIS que meta existe
        meta["repo_display_name"] = repo_display
        
        generate_html_report(meta, violations, html_file)
        print(f"[INFO] HTML gerado em: {html_file}")

        try:
            webbrowser.open(f"file:///{html_file}")
        except Exception:
            pass

        print("[JSON_RESULT]")
        print(json.dumps({
            "status": review_status,
            "branch": CURRENT_BRANCH,
            "compare_branch": COMPARE_BRANCH,
            "ahead_commits": ahead,
            "behind_commits": behind,
            "arquivos_alterados": 0,
            "violacoes": len(violations),
            "merge_conflicts": len(conflict_files),
            "legacy_code_count": 0,
            "html_file": html_file
        }, ensure_ascii=False))

        print("[JSON_VIOLATIONS]")
        print(json.dumps(violations, ensure_ascii=False))

        msg_suffix = " (RECUSADO - merge conflicts)" if has_conflicts else " (sem commits abertos)"
        print(f"[INFO] Code Review finalizado{msg_suffix}.")
        return

    # COMMITS AHEAD: validar
    project_files = get_project_files(COMPARE_BRANCH, "HEAD")
    print(f"[INFO] Arquivos do projeto modificados: {len(project_files)}")

    advpl_files = [f for f in project_files if f.lower().endswith(".prw")]

    rules = load_rules()
    diff_text = get_diff_full(COMPARE_BRANCH, advpl_files)
    parsed = parse_unified_diff(diff_text)

    print("[INFO] Analisando regras com detecção de código legado (origin/master)...")
    violations = analyze_rules_on_diff(parsed, rules)
    add_context_to_violations(parsed, violations, CONTEXT_RADIUS)

    # Adiciona violações de merge conflict (antes das violações de regras)
    conflict_violations = _build_conflict_violations(conflict_files)
    violations = conflict_violations + violations

    has_conflicts = len(conflict_files) > 0
    total_legacy = sum(v.get("legacy_count", 0) for v in violations)
    rule_violations = [v for v in violations if v.get("id") != "MERGE_CONFLICT"]

    print(f"[INFO] Violações ativas encontradas: {len(rule_violations)}")
    if has_conflicts:
        print(f"[AVISO] Merge conflicts: {len(conflict_files)} arquivo(s) - REVIEW RECUSADO")
    print(f"[INFO] Código legado detectado: {total_legacy} ocorrências (não-contabilizadas como violações)")

    review_status = "RECUSADO" if has_conflicts else ("OK" if len(rule_violations) == 0 else "OK")

    meta = {
        "branch_atual": CURRENT_BRANCH,
        "compare_branch": COMPARE_BRANCH,
        "ahead_commits": ahead,
        "behind_commits": behind,
        "arquivos_alterados": len(project_files),
        "arquivos_listados": project_files,
        "arquivos_advpl": advpl_files,
        "data_execucao": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        "conflict_files": conflict_files,

        "origin_url": get_origin_remote_url(),
    }

    # >>> adiciona DEPOIS que meta existe
    meta["repo_display_name"] = repo_display
    
    generate_html_report(meta, violations, html_file)
    print(f"[INFO] HTML gerado em: {html_file}")

    try:
        webbrowser.open(f"file:///{html_file}")
    except Exception:
        pass

    print("[JSON_RESULT]")
    print(json.dumps({
        "status": review_status,
        "branch": CURRENT_BRANCH,
        "compare_branch": COMPARE_BRANCH,
        "ahead_commits": ahead,
        "behind_commits": behind,
        "arquivos_alterados": len(project_files),
        "violacoes": len(violations),
        "merge_conflicts": len(conflict_files),
        "legacy_code_count": total_legacy,
        "html_file": html_file
    }, ensure_ascii=False))

    print("[JSON_VIOLATIONS]")
    print(json.dumps(violations, ensure_ascii=False))

    msg_suffix = " (RECUSADO - merge conflicts)" if has_conflicts else " com sucesso"
    print(f"[INFO] Code Review finalizado{msg_suffix}.")


if __name__ == "__main__":
    main()