import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const ACTIONS = ["Create", "Read", "Write", "Delete", "Append", "AppendTo", "Assign", "Share"];
const PRIV_RE = /^prv(Create|Read|Write|Delete|AppendTo|Append|Assign|Share)(.+)$/;
const servers = new Map();

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { shell: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
            err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout),
        );
    });
}

// Parsea tablas de ancho fijo de pac usando la posición de cada cabecera.
function parseTable(text, firstHeader, names) {
    const lines = text.split(/\r?\n/);
    const hi = lines.findIndex((l) => l.trimStart().startsWith(firstHeader));
    if (hi < 0) return [];
    const header = lines[hi];
    const cols = names
        ? names.map((n) => ({ name: n, start: header.indexOf(n) }))
        : [...header.matchAll(/\S+(?: \S+)*/g)].map((m) => ({ name: m[0], start: m.index }));
    const rows = [];
    for (const line of lines.slice(hi + 1)) {
        if (!line.trim()) continue;
        const row = {};
        cols.forEach((c, i) => {
            row[c.name] = line.slice(c.start, i + 1 < cols.length ? cols[i + 1].start : undefined).trim();
        });
        rows.push(row);
    }
    return rows;
}

async function profiles() {
    const out = await run("pac", ["auth", "list"]);
    return parseTable(out, "Index", ["Index", "Active", "Kind", "Name", "User", "Cloud", "Type", "Environment", "Environment Url", "ERP URL"]).map((r) => ({
        index: Number(r.Index.replace(/[\[\]]/g, "")),
        active: r.Active === "*",
        name: r.Name,
        user: r.User,
        environment: r.Environment,
        url: (r["Environment Url"] || "").replace(/\/$/, ""),
    }));
}

async function solutions(url) {
    const out = await run("pac", ["solution", "list", "--environment", url]);
    return parseTable(out, "Unique Name").map((r) => ({
        unique: r["Unique Name"],
        friendly: r["Friendly Name"],
        version: r.Version,
        managed: r.Managed === "True",
    }));
}

async function dv(url, token, path) {
    const r = await fetch(`${url}/api/data/v9.2/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
}

async function roles(url, unique) {
    let token;
    try {
        token = (await run("az", ["account", "get-access-token", "--resource", url, "--query", "accessToken", "-o", "tsv"])).trim();
    } catch (e) {
        throw new Error(`No se pudo obtener token con 'az' para ${url}. Ejecuta 'az login' con la misma cuenta del perfil PAC. ${e.message}`);
    }
    // Los privilegios usan el SchemaName (p. ej. "User"); se traduce al nombre lógico (systemuser).
    const logical = new Map(
        (await dv(url, token, "EntityDefinitions?$select=LogicalName,SchemaName")).value.map((e) => [e.SchemaName.toLowerCase(), e.LogicalName]),
    );
    logical.set("user", "systemuser");
    const sol = (await dv(url, token, `solutions?$select=solutionid&$filter=uniquename eq '${unique.replace(/'/g, "''")}'`)).value[0];
    if (!sol) throw new Error("Solución no encontrada");
    const comps = (await dv(url, token, `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${sol.solutionid} and componenttype eq 20`)).value;
    const out = [];
    for (const c of comps) {
        const role = (await dv(url, token, `roles(${c.objectid})?$select=name`));
        const [deps, names] = await Promise.all([
            dv(url, token, `RetrieveRolePrivilegesRole(RoleId=${c.objectid})`),
            dv(url, token, `roles(${c.objectid})/roleprivileges_association?$select=privilegeid,name`),
        ]);
        const byId = new Map(names.value.map((p) => [p.privilegeid, p.name]));
        const tables = {};
        for (const p of deps.RolePrivileges) {
            const m = PRIV_RE.exec(byId.get(p.PrivilegeId) || "");
            if (m) (tables[logical.get(m[2].toLowerCase()) || m[2]] ||= {})[m[1]] = p.Depth;
        }
        out.push({ name: role.name, tables });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { actions: ACTIONS, roles: out };
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Permisos de roles</title>
<style>
body{font-family:var(--font-sans,system-ui);background:var(--background-color-default,#fff);color:var(--text-color-default,#222);padding:12px;margin:0}
label{display:block;margin:10px 0 3px;font-weight:600;font-size:13px}
select,input{width:100%;box-sizing:border-box;padding:5px;font:inherit;background:transparent;color:inherit;border:1px solid #8886;border-radius:4px}
h2{margin:16px 0 6px}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #8884;padding:4px 8px;text-align:center;font-size:12px}
td:first-child,th:first-child{text-align:left}
.none{opacity:.3}.Global{background:#2e7d3233}.Deep{background:#1565c033}.Local{background:#f9a82533}.Basic{background:#ef6c0033}
.legend span{padding:2px 8px;margin-right:6px;border:1px solid #8884;font-size:12px}.err{color:#d33;margin-top:8px}
</style></head><body>
<label>1. Perfil de PAC</label><select id="prof"></select>
<label>2. Solución <small id="cnt"></small></label>
<input id="filter" placeholder="Filtrar por nombre…" disabled><select id="sol" size="6" disabled></select>
<label>Filtrar tablas <button id="refresh" disabled style="margin-left:8px">↻ Actualizar permisos</button></label><input id="tfilter" placeholder="p. ej. ovg_" disabled>
<div class="legend" style="margin-top:10px"><span class="Global">Global</span><span class="Deep">Deep</span><span class="Local">Local</span><span class="Basic">Basic</span><span class="none">Sin permiso</span></div>
<div id="out"></div><div id="err" class="err"></div>
<script>
const $=id=>document.getElementById(id);let profs=[],sols=[],data=null;
const j=async u=>{const r=await fetch(u);const d=await r.json();if(d.error)throw new Error(d.error);return d};
const fail=e=>{$('err').textContent=e?e.message:''};
async function init(){try{profs=await j('/profiles');
  $('prof').innerHTML='<option value="">— elige un perfil —</option>'+profs.map(p=>'<option value="'+p.index+'">'+p.name+' · '+p.environment+' ('+p.user+')'+(p.active?' *':'')+'</option>').join('');
  const a=profs.find(p=>p.active);if(a){$('prof').value=a.index;$('prof').onchange()}}catch(e){fail(e)}}
$('prof').onchange=async()=>{fail();$('out').innerHTML='';sols=[];renderSols();const p=profs.find(x=>x.index==$('prof').value);if(!p)return;
  $('sol').disabled=$('filter').disabled=true;$('cnt').textContent='(cargando…)';
  try{await j('/select?index='+p.index);sols=await j('/solutions?env='+encodeURIComponent(p.url));$('filter').disabled=$('sol').disabled=false;renderSols();}catch(e){fail(e);$('cnt').textContent=''}};
function renderSols(){const f=$('filter').value.toLowerCase();const l=sols.filter(s=>(s.friendly+' '+s.unique).toLowerCase().includes(f));
  $('cnt').textContent=sols.length?'('+l.length+'/'+sols.length+')':'';
  $('sol').innerHTML=l.map(s=>'<option value="'+s.unique+'">'+s.friendly+' ['+s.unique+'] v'+s.version+(s.managed?' (administrada)':'')+'</option>').join('')}
$('filter').oninput=renderSols;
$('sol').onchange=()=>loadRoles(true);
$('refresh').onclick=()=>loadRoles(false);
async function loadRoles(clear){fail();const p=profs.find(x=>x.index==$('prof').value);if(!p||!$('sol').value)return;
  if(clear||!data)$('out').textContent='Cargando roles…';$('refresh').disabled=true;
  try{data=await j('/roles?env='+encodeURIComponent(p.url)+'&solution='+encodeURIComponent($('sol').value));$('tfilter').disabled=false;renderRoles()}catch(e){$('out').textContent='';fail(e)}
  $('refresh').disabled=false}
$('tfilter').oninput=()=>data&&renderRoles();
function renderRoles(){const f=$('tfilter').value.toLowerCase();
  if(!data.roles.length){$('out').textContent='La solución no contiene roles de seguridad.';return}
  $('out').innerHTML=data.roles.map(r=>{const ts=Object.keys(r.tables).filter(t=>t.toLowerCase().includes(f)).sort();
    return '<h2>'+r.name+'</h2><table><tr><th>Tabla</th>'+data.actions.map(a=>'<th>'+a+'</th>').join('')+'</tr>'+
    ts.map(t=>'<tr><td>'+t+'</td>'+data.actions.map(a=>{const v=r.tables[t][a];return v?'<td class="'+v+'">'+v+'</td>':'<td class="none">—</td>'}).join('')+'</tr>').join('')+'</table>'}).join('')}
init();
</script></body></html>`;

async function startServer() {
    const server = createServer(async (req, res) => {
        const u = new URL(req.url, "http://x");
        if (u.pathname === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            return res.end(HTML);
        }
        res.setHeader("Content-Type", "application/json");
        try {
            const q = u.searchParams;
            let body;
            if (u.pathname === "/profiles") body = await profiles();
            else if (u.pathname === "/select") {
                await run("pac", ["auth", "select", "--index", String(Number(q.get("index")))]);
                body = { ok: true };
            } else if (u.pathname === "/solutions") body = await solutions(q.get("env"));
            else if (u.pathname === "/roles") body = await roles(q.get("env"), q.get("solution"));
            else {
                res.statusCode = 404;
                body = { error: "not found" };
            }
            res.end(JSON.stringify(body));
        } catch (e) {
            res.end(JSON.stringify({ error: String(e.message || e) }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

await joinSession({
    canvases: [
        createCanvas({
            id: "role-permissions",
            displayName: "Permisos de roles",
            description: "Elige perfil PAC y solución, y muestra la matriz de privilegios de sus roles de seguridad (datos en vivo de Dataverse)",
            actions: [],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Permisos de roles", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
