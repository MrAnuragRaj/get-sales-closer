"""Apply Sprint 16-19 + P7 migrations"""
import sys, io, json, subprocess, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

PAT = 'sbp_f32d14e7ea407f3529d216501eda402ff3837654'
URL = 'https://api.supabase.com/v1/projects/klbwigcvrdfeeeeotehu/database/query'
TMPFILE = 'C:\\Windows\\Temp\\mgr_sql.json'

def clean_sql(sql):
    return ''.join(c if (ord(c) < 128 and c != '\r') else ' ' for c in sql)

def run_sql(sql, label=''):
    cleaned = clean_sql(sql.strip())
    body = json.dumps({'query': cleaned})
    with open(TMPFILE, 'w', encoding='ascii', errors='replace') as f:
        f.write(body)
    r = subprocess.run(['curl','-s','-X','POST',URL,
        '-H',f'Authorization: Bearer {PAT}','-H','Content-Type: application/json','-d',f'@{TMPFILE}'],
        capture_output=True, text=True)
    resp = r.stdout.strip()
    ok = resp in ('[]','null') or resp.startswith('[{')
    print(f'  {"OK " if ok else "ERR"} {label[:80]}')
    if not ok:
        print(f'      {resp[:400]}')
    return ok

def split_statements(sql):
    stmts = []
    current = []
    i = 0; n = len(sql)
    in_lc = False; in_dq = False; dq_tag = ''; in_sq = False
    while i < n:
        ch = sql[i]
        if in_lc:
            current.append(ch)
            if ch == '\n': in_lc = False
            i += 1; continue
        if in_dq:
            current.append(ch)
            if sql[i:i+len(dq_tag)] == dq_tag:
                current.extend(list(sql[i+1:i+len(dq_tag)]))
                i += len(dq_tag); in_dq = False; dq_tag = ''
                while i < n and sql[i] in ' \t': current.append(sql[i]); i += 1
                if i < n and sql[i] == ';':
                    current.append(';'); i += 1
                    stmt = ''.join(current).strip()
                    if stmt: stmts.append(stmt)
                    current = []
            else:
                i += 1
            continue
        if in_sq:
            current.append(ch)
            if ch == "'":
                if i+1 < n and sql[i+1] == "'": current.append(sql[i+1]); i += 2; continue
                else: in_sq = False
            i += 1; continue
        if ch == '-' and i+1 < n and sql[i+1] == '-':
            in_lc = True; current.append(ch); i += 1; continue
        if ch == "'":
            in_sq = True; current.append(ch); i += 1; continue
        if ch == '$':
            j = sql.find('$', i+1)
            if j != -1:
                inner = sql[i+1:j]
                if re.match(r'^[A-Za-z0-9_]*$', inner):
                    tag = sql[i:j+1]; in_dq = True; dq_tag = tag
                    current.extend(list(tag)); i = j+1; continue
        if ch == ';':
            current.append(ch)
            stmt = ''.join(current).strip()
            if stmt and stmt != ';': stmts.append(stmt)
            current = []; i += 1; continue
        current.append(ch); i += 1
    rem = ''.join(current).strip()
    if rem and rem != ';': stmts.append(rem)
    result = []
    for s in stmts:
        lines = s.strip().split('\n')
        if any(not l.strip().startswith('--') and l.strip() for l in lines):
            result.append(s)
    return result

BASE = r'C:\Users\anura\OneDrive\Desktop\YogMaya\SalesCloser\codes\get-sales-closer\supabase\migrations'

migrations = [
    (f'{BASE}\\20260523c_sprintA_validation.sql', 'Sprint A Validation: NOWAIT + Journey Provenance + Churn Visibility + Causal Exclusivity + Purge Detection'),
]

total_ok = total_err = 0

for mig_path, mig_label in migrations:
    print(f'\n{"="*60}')
    print(f'=== {mig_label} ===')
    print(f'{"="*60}')
    with open(mig_path, encoding='utf-8') as f:
        content = f.read()
    stmts = split_statements(clean_sql(content))
    print(f'{len(stmts)} statements')
    ok_count = err_count = 0
    for i, stmt in enumerate(stmts, 1):
        preview = stmt.strip().split('\n')[0][:65]
        ok = run_sql(stmt, f'[{i}/{len(stmts)}] {preview}')
        if ok: ok_count += 1
        else: err_count += 1
    print(f'  => {ok_count} ok, {err_count} errors')
    total_ok += ok_count
    total_err += err_count

print(f'\n{"="*60}')
print(f'TOTAL: {total_ok} ok, {total_err} errors')
print('Done.')
